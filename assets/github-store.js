/**
 * TycGame's browser-only GitHub storage. No server, OAuth secret or token is
 * written into the repository. Upload objects live on a separate data branch.
 * GitHub rate/storage limits still apply; deleting a Git ref cannot erase history.
 */
import { mimeFromPath } from './shared.js';
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_APP_BYTES = 2 * 1024 ** 3;
export const MAX_FILES = 2000;
const API = 'https://api.github.com';
const VERSION = '2022-11-28';
const enc = encodeURIComponent;
const now = () => new Date().toISOString();
const copy = value => JSON.parse(JSON.stringify(value));
const abortError = () => new DOMException('上传已暂停，已提交的分块会保留。', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const shaPattern = /^[a-f0-9]{40,64}$/i;
const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export class GitHubError extends Error {
  constructor(message, status = 0, details = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    Object.assign(this, details);
  }
}

function problem(message, status = 400) { throw new GitHubError(message, status); }
function sleep(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', cancel); resolve(); }
    function cancel() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export function validatePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') || /[\\\x00-\x1f\x7f?#]/.test(value) || value.split('/').some(x => !x || x === '.' || x === '..')) {
    problem('文件路径无效，请选择应用的构建输出目录。');
  }
  return value.normalize('NFC');
}
export function validateSlug(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(value) || value.endsWith('-')) problem('访问后缀需要 3–64 位小写字母、数字或连字符。');
  return value;
}
function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) problem('应用名称需要 1–80 个字符。');
  return value.trim();
}
function bytesToBase64(bytes) {
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 32768) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(pieces.join(''));
}
export function base64ToBytes(base64) {
  const text = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
async function gitBlobSha(bytes) {
  const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const input = new Uint8Array(prefix.length + bytes.byteLength);
  input.set(prefix); input.set(bytes, prefix.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', input))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function safeSHA(value) { if (!shaPattern.test(value || '')) problem('GitHub 返回了无效的文件标识。', 502); return value; }
function manifestPath(id) { return `apps/${validateSlug(id)}/manifest.json`; }
function publicSummary(app) {
  const { files, _objects, ...summary } = app;
  return summary;
}
function objectsIn(app) { return new Set((app.files || []).flatMap(f => (f.chunks || []).filter(Boolean).map(c => c.sha))); }
function metadata(app) { return { ...publicSummary(app), _objects: [...objectsIn(app)] }; }
function completedBytes(app) { return (app.files || []).reduce((sum, file) => sum + (file.chunks || []).reduce((n, chunk) => n + (chunk?.size || 0), 0), 0); }
function emptyCatalog() { return { version: 1, apps: [] }; }
function validCatalog(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.apps) || value.apps.length > 10000) problem('云端应用目录格式不受支持，请确认数据分支。', 422);
  const ids = new Set();
  for (const app of value.apps) {
    validateSlug(app.id); if (ids.has(app.id)) problem('云端应用目录存在重复条目。', 422); ids.add(app.id);
  }
  return value;
}
function validateManifest(app) {
  if (!app || !Array.isArray(app.files) || !app.revision || !['uploading', 'ready'].includes(app.status)) problem('应用清单格式无效。', 422);
  validateSlug(app.id); validatePath(app.entry);
  if (app.files.length > MAX_FILES) problem('应用文件数量超出限制。', 422);
  const paths = new Set(); let size = 0;
  for (const file of app.files) {
    file.path = validatePath(file.path);
    if (paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !Array.isArray(file.chunks)) problem('云端文件清单无效。', 422);
    paths.add(file.path); size += file.size;
    if (file.chunks.length !== Math.ceil(file.size / CHUNK_SIZE)) problem('云端文件分块数量无效。', 422);
    for (let i = 0; i < file.chunks.length; i++) {
      const chunk = file.chunks[i];
      if (chunk && (!shaPattern.test(chunk.sha || '') || chunk.size !== Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE))) problem('云端文件分块无效。', 422);
      if (app.status === 'ready' && !chunk) problem('应用文件尚未上传完整。', 422);
    }
  }
  if (size > MAX_APP_BYTES || size !== app.totalBytes || !paths.has(app.entry)) problem('云端应用清单大小或入口无效。', 422);
  return app;
}

export class GitHubStore {
  #token = '';
  #fetch;
  #writeQueue = Promise.resolve();
  #mutationQueue = Promise.resolve();
  #nextWriteAt = 0;
  #writeInterval;
  #connection = null;
  #readManifests = new Map();

  constructor(config = {}) {
    this.owner = config.owner || 'tycofficial';
    this.repo = config.repo || 'tycgame';
    this.branch = config.branch || 'tycgame-data';
    this.mode = 'github';
    this.#token = String(config.token || '').trim();
    this.#fetch = config.fetch || globalThis.fetch.bind(globalThis);
    // GitHub has secondary content-creation limits as well as hourly API limits.
    this.#writeInterval = Number.isFinite(config.writeInterval) ? Math.max(0, config.writeInterval) : 950;
    this.#validateConfig();
  }
  #validateConfig() {
    if (!/^[a-zA-Z0-9-]{1,39}$/.test(this.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(this.repo) || ['.', '..'].includes(this.repo)) problem('请输入有效的 GitHub 用户名与仓库名称。');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,150}$/.test(this.branch) || this.branch.includes('..') || this.branch.includes('//') || /[/.]$/.test(this.branch)) problem('数据分支名称无效。');
  }
  get repository() { return this.#connection?.repository || { fullName: `${this.owner}/${this.repo}`, private: null, branch: this.branch }; }
  get limits() { return { maxAppBytes: MAX_APP_BYTES, maxFiles: MAX_FILES, chunkSize: CHUNK_SIZE, partSize: CHUNK_SIZE }; }
  get authenticated() { return !!this.#token; }
  get connection() { return this.#connection ? copy(this.#connection) : null; }
  // Trusted runner bootstrap only. Never serialize this into persistent storage.
  runtimeConfig() { return { mode: 'github', owner: this.owner, repo: this.repo, branch: this.branch, token: this.#token }; }
  disconnect() { this.#token = ''; this.#connection = null; this.#readManifests.clear(); }
  #path(path = '') { return `/repos/${enc(this.owner)}/${enc(this.repo)}${path}`; }
  #writeRequired() { if (!this.#token) problem('请先连接 GitHub 访问令牌，再保存到云端。', 401); }

  async #throttle(signal) {
    const run = async () => {
      checkAbort(signal);
      const wait = Math.max(0, this.#nextWriteAt - Date.now());
      if (wait) await sleep(wait, signal);
      this.#nextWriteAt = Date.now() + this.#writeInterval;
    };
    const result = this.#writeQueue.then(run, run);
    this.#writeQueue = result.catch(() => {});
    return result;
  }
  async #request(path, { method = 'GET', body, signal, raw = false, retries = 3 } = {}) {
    if (!path.startsWith('/')) problem('请求路径无效。');
    const write = writeMethods.has(method);
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      if (write) { this.#writeRequired(); await this.#throttle(signal); }
      const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': VERSION };
      if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try { response = await this.#fetch(API + path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', redirect: 'follow' }); }
      catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw abortError();
        if (attempt < retries) { await sleep(Math.min(800 * 2 ** attempt, 5000), signal); continue; }
        throw new GitHubError('无法连接 GitHub。请检查网络、GitHub API 可达性后重试。', 0, { cause: error });
      }
      if (response.ok) {
        if (response.status === 204) return null;
        if (raw) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          // Some proxies ignore raw media types and return GitHub's JSON blob
          // envelope. Never mistake an application's own JSON for that envelope.
          if (response.headers.get('content-type')?.includes('json')) {
            try {
              const envelope = JSON.parse(new TextDecoder().decode(bytes));
              if (envelope.sha === path.split('/').pop() && envelope.encoding === 'base64' && typeof envelope.content === 'string') return base64ToBytes(envelope.content);
            } catch {}
          }
          return bytes;
        }
        return response.json();
      }
      let data = {}; try { data = await response.json(); } catch {}
      const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit|abuse|secondary rate/i.test(data.message || '')));
      const retryAfter = Number(response.headers.get('retry-after')) || (response.headers.get('x-ratelimit-remaining') === '0' ? Math.max(1, Number(response.headers.get('x-ratelimit-reset')) - Math.floor(Date.now() / 1000)) : 0);
      if ((rateLimited || response.status >= 500) && attempt < retries && retryAfter <= 60) {
        await sleep(Math.max(retryAfter * 1000, Math.min(1000 * 2 ** attempt, 6000)), signal); continue;
      }
      let message = `GitHub 请求失败（${response.status}）。`;
      if (response.status === 401) message = 'GitHub 访问令牌无效或已过期，请重新连接。';
      else if (rateLimited) message = `GitHub 请求配额或写入频率已达限制，请${retryAfter ? `在 ${Math.ceil(retryAfter)} 秒后` : '稍后'}继续；已提交的分块会保留。`;
      else if (response.status === 403) message = 'GitHub 拒绝了操作，请检查令牌的仓库 Contents 读写权限与仓库访问范围。';
      else if (response.status === 404) message = '找不到 GitHub 仓库、数据分支或应用；私有仓库也需要有效权限。';
      else if (response.status === 409 || response.status === 422) message = '云端数据正在更新或提交冲突，请稍后继续。';
      else if (response.status === 413) message = '上传分块超过 GitHub 的请求限制。';
      throw new GitHubError(message, response.status, { retryAfterSeconds: retryAfter || undefined, githubMessage: data.message });
    }
  }

  async connect(config = {}) {
    this.#readManifests.clear();
    if (config.owner !== undefined) this.owner = String(config.owner).trim();
    if (config.repo !== undefined) this.repo = String(config.repo).trim();
    if (config.branch !== undefined) this.branch = String(config.branch).trim();
    if (config.token !== undefined) this.#token = String(config.token).trim();
    this.#validateConfig();
    const [repository, user] = await Promise.all([
      this.#request(this.#path()),
      this.#token ? this.#request('/user') : Promise.resolve(null),
    ]);
    if (this.branch === repository.default_branch) problem('数据分支不能与网站源码分支相同，请使用 tycgame-data。');
    if (this.#token && repository.permissions?.push === false) problem('此账户没有向该仓库写入文件的权限。', 403);
    this.defaultBranch = repository.default_branch || 'main';
    this.#connection = {
      user: user ? { login: user.login, name: user.name || user.login, avatarUrl: user.avatar_url || '' } : null,
      repository: { fullName: repository.full_name || `${this.owner}/${this.repo}`, private: !!repository.private, branch: this.branch, defaultBranch: this.defaultBranch },
      limits: this.limits,
    };
    return copy(this.#connection);
  }

  async #head(signal, branch = this.branch) {
    try {
      const ref = await this.#request(this.#path(`/git/ref/heads/${branch.split('/').map(enc).join('/')}`), { signal });
      const sha = safeSHA(ref.object?.sha);
      const commit = await this.#request(this.#path(`/git/commits/${sha}`), { signal });
      return { sha, tree: safeSHA(commit.tree?.sha) };
    } catch (error) { if (error.status === 404) return null; throw error; }
  }
  async #jsonAt(path, ref, signal, optional = false) {
    try {
      const data = await this.#request(this.#path(`/contents/${path.split('/').map(enc).join('/')}?ref=${enc(ref)}`), { signal });
      let bytes;
      if (data.encoding === 'base64' && typeof data.content === 'string') bytes = base64ToBytes(data.content);
      else if (data.sha) bytes = await this.readChunk(data.sha, { signal });
      else problem('GitHub 云端清单读取失败。', 502);
      if (bytes.byteLength > 8 * 1024 * 1024) problem('云端清单过大。', 422);
      try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { problem('GitHub 云端清单不是有效的 JSON。', 422); }
    } catch (error) { if (optional && error.status === 404) return null; throw error; }
  }
  async #catalog(head, signal) {
    if (!head) return emptyCatalog();
    return validCatalog(await this.#jsonAt('catalog.json', head.sha, signal));
  }
  async #ensureBranch(signal) {
    // Guard writes even when callers bypass the UI's normal connect step.
    // An existing source branch must never be accepted as application storage.
    if (!this.#connection || this.#connection.repository.fullName.toLowerCase() !== `${this.owner}/${this.repo}`.toLowerCase() || this.#connection.repository.branch !== this.branch) await this.connect();
    if (this.branch === this.defaultBranch) problem('数据分支不能与网站源码分支相同，请使用 tycgame-data。');
    let head = await this.#head(signal);
    if (head) return head;
    this.#writeRequired();
    if (!this.defaultBranch) await this.connect();
    const source = await this.#head(signal, this.defaultBranch);
    if (!source) problem('仓库尚未初始化，请先在 GitHub 创建一个文件。', 409);
    const tree = await this.#request(this.#path('/git/trees'), { method: 'POST', signal, body: { tree: [{ path: 'catalog.json', mode: '100644', type: 'blob', content: JSON.stringify(emptyCatalog()) }] } });
    const commit = await this.#request(this.#path('/git/commits'), { method: 'POST', signal, body: { message: 'Initialize TycGame application storage', tree: tree.sha, parents: [source.sha] } });
    try {
      await this.#request(this.#path('/git/refs'), { method: 'POST', signal, body: { ref: `refs/heads/${this.branch}`, sha: commit.sha } });
      return { sha: commit.sha, tree: tree.sha };
    } catch (error) {
      if (error.status === 409 || error.status === 422) { head = await this.#head(signal); if (head) return head; }
      throw error;
    }
  }
  async #mutate(change, signal) {
    this.#writeRequired();
    const run = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        checkAbort(signal);
        const head = await this.#ensureBranch(signal);
        const catalog = await this.#catalog(head, signal);
        const mutation = await change({ head, catalog });
        if (!mutation || mutation.unchanged) return mutation?.result;
        const entries = [
          { path: 'catalog.json', mode: '100644', type: 'blob', content: JSON.stringify(catalog) },
          ...(mutation.entries || []),
        ];
        const tree = await this.#request(this.#path('/git/trees'), { method: 'POST', signal, body: { base_tree: head.tree, tree: entries } });
        const commit = await this.#request(this.#path('/git/commits'), { method: 'POST', signal, body: { message: mutation.message || 'Update TycGame application storage', tree: tree.sha, parents: [head.sha] } });
        try {
          await this.#request(this.#path(`/git/refs/heads/${this.branch.split('/').map(enc).join('/')}`), { method: 'PATCH', signal, body: { sha: commit.sha, force: false } });
          this.#readManifests.clear();
          return mutation.result;
        } catch (error) {
          if ((error.status === 409 || error.status === 422) && attempt < 4) { await sleep(200 * (attempt + 1), signal); continue; }
          throw error;
        }
      }
    };
    const result = this.#mutationQueue.then(run, run);
    this.#mutationQueue = result.catch(() => {});
    return result;
  }

  async listApps() {
    this.#readManifests.clear();
    const catalog = await this.#catalog(await this.#head());
    return catalog.apps.map(publicSummary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async getApp(id) {
    validateSlug(id);
    const head = await this.#head();
    if (!head) problem('还没有云端应用。', 404);
    const app = validateManifest(await this.#jsonAt(manifestPath(id), head.sha));
    this.#readManifests.set(id, { app, at: Date.now() });
    return app;
  }
  async #createApp(app, signal) {
    return this.#mutate(({ catalog }) => {
      if (catalog.apps.some(a => a.id === app.id)) problem('这个访问后缀已经存在，请更换后缀或继续原来的上传。', 409);
      catalog.apps.push(metadata(app));
      return { entries: [{ path: manifestPath(app.id), mode: '100644', type: 'blob', content: JSON.stringify(app) }], message: `Start uploading ${app.name}`, result: app };
    }, signal);
  }
  async #checkpoint(incoming, signal, publish = false) {
    return this.#mutate(async ({ head, catalog }) => {
      const position = catalog.apps.findIndex(a => a.id === incoming.id);
      if (position < 0) problem('上传已被取消或删除，请重新创建应用。', 409);
      const app = validateManifest(await this.#jsonAt(manifestPath(incoming.id), head.sha, signal));
      if (app.revision !== incoming.revision) problem('这个后缀已用于另一个上传，请刷新应用库。', 409);
      if (app.files.length !== incoming.files.length) problem('云端文件清单已发生变化。', 409);
      const entries = []; const known = objectsIn(app);
      for (let f = 0; f < app.files.length; f++) {
        const oldFile = app.files[f], newFile = incoming.files[f];
        if (oldFile.path !== newFile.path || oldFile.size !== newFile.size) problem('云端文件清单已发生变化。', 409);
        for (let c = 0; c < oldFile.chunks.length; c++) {
          const chunk = newFile.chunks[c]; if (!chunk) continue;
          if (oldFile.chunks[c] && oldFile.chunks[c].sha !== chunk.sha) problem('另一设备上传了不同内容，请选择原始文件或新建后缀。', 409);
          if (!known.has(chunk.sha)) { known.add(chunk.sha); entries.push({ path: `objects/${safeSHA(chunk.sha)}`, mode: '100644', type: 'blob', sha: chunk.sha }); }
          oldFile.chunks[c] = chunk;
        }
      }
      if (app.status === 'ready') return { unchanged: true, result: app };
      if (publish) {
        if (app.files.some(f => f.chunks.some(c => !c))) problem('文件分块尚未全部上传。', 409);
        app.status = 'ready';
      }
      app.updatedAt = now();
      catalog.apps[position] = metadata(app);
      entries.push({ path: manifestPath(app.id), mode: '100644', type: 'blob', content: JSON.stringify(app) });
      return { entries, message: publish ? `Publish ${app.name}` : `Save upload progress for ${app.name}`, result: app };
    }, signal);
  }

  async upload({ files, name, slug, entry, concurrency = 4, signal, onProgress = () => {}, resumeId } = {}) {
    this.#writeRequired(); checkAbort(signal);
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) problem(`请选择 1–${MAX_FILES} 个文件。`);
    name = validateName(name || '未命名应用'); entry = validatePath(entry || 'index.html');
    const seen = new Set(); let totalBytes = 0;
    const selected = files.map(item => {
      const path = validatePath(item.path || item.file?.webkitRelativePath || item.file?.name);
      const file = item.file;
      if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0 || seen.has(path)) problem('上传文件清单无效或存在重复路径。');
      seen.add(path); totalBytes += file.size;
      return { path, file };
    });
    if (totalBytes > MAX_APP_BYTES) problem('单个应用最多 2 GiB，仍需遵守 GitHub 仓库存储与流量限制。', 413);
    if (!seen.has(entry) || !/\.html?$/i.test(entry)) problem('请选择文件列表中的 HTML 入口。');
    concurrency = Math.max(1, Math.min(6, Math.floor(Number(concurrency) || 4)));
    let app; let loaded = 0; let initialLoaded = 0; let currentFile = ''; const startedAt = Date.now();
    const emit = stage => {
      try { onProgress({ stage, loaded, total: totalBytes, currentFile, completedFiles: app?.files?.filter(f => f.chunks.every(Boolean)).length || 0, totalFiles: selected.length, speed: Math.max(0, loaded - initialLoaded) / Math.max(1, (Date.now() - startedAt) / 1000), appId: app?.id, app: app ? publicSummary(app) : undefined }); } catch {}
    };
    emit('preparing');
    if (resumeId) {
      app = await this.getApp(validateSlug(resumeId));
      if (app.status === 'ready') return app;
      if (app.files.length !== selected.length || app.entry !== entry) problem('请重新选择同一批原始文件，保留相同的目录和入口。');
      const byPath = new Map(selected.map(f => [f.path, f]));
      for (const file of app.files) {
        const source = byPath.get(file.path);
        if (!source || source.file.size !== file.size) problem(`原文件不匹配：${file.path}。请重新选择同一批原始文件。`);
      }
      selected.splice(0, selected.length, ...app.files.map(f => byPath.get(f.path)));
      // Verify every saved chunk locally before trusting a resumed file. This
      // catches a changed middle section even if name/size/mtime are identical.
      for (let f = 0; f < app.files.length; f++) for (let c = 0; c < app.files[f].chunks.length; c++) {
        const chunk = app.files[f].chunks[c]; if (!chunk) continue; checkAbort(signal);
        currentFile = app.files[f].path;
        const bytes = new Uint8Array(await selected[f].file.slice(c * CHUNK_SIZE, c * CHUNK_SIZE + chunk.size).arrayBuffer());
        if ((await gitBlobSha(bytes)) !== chunk.sha) problem(`续传文件内容已改变：${currentFile}。请使用原始文件，或创建新应用。`, 409);
        loaded += chunk.size; emit('preparing');
      }
    } else {
      slug = validateSlug(slug || `app-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`);
      app = { id: slug, slug, revision: crypto.randomUUID(), name, type: selected.length === 1 ? 'html' : 'app', status: 'uploading', storage: 'github', entry, totalBytes, fileCount: selected.length, createdAt: now(), updatedAt: now(), files: selected.map(({ path, file }) => ({ path, size: file.size, type: mimeFromPath(path) !== 'application/octet-stream' ? mimeFromPath(path) : file.type || 'application/octet-stream', lastModified: Number(file.lastModified) || 0, chunks: Array(Math.ceil(file.size / CHUNK_SIZE)).fill(null) })) };
      await this.#createApp(app, signal);
    }
    initialLoaded = loaded; emit('uploading');
    const tasks = [];
    for (let f = 0; f < app.files.length; f++) for (let c = 0; c < app.files[f].chunks.length; c++) if (!app.files[f].chunks[c]) tasks.push({ f, c });
    let nextTask = 0, changed = 0, fatal = null, flushQueue = Promise.resolve();
    const flush = (flushSignal = signal, publish = false) => {
      const snapshot = copy(app);
      const operation = async () => {
        emit(publish ? 'publishing' : 'checkpoint');
        const stored = await this.#checkpoint(snapshot, flushSignal, publish);
        app.name = stored.name; app.updatedAt = stored.updatedAt; app.status = stored.status;
        emit(publish ? 'complete' : 'uploading');
        return stored;
      };
      const result = flushQueue.then(operation, operation);
      flushQueue = result.catch(() => {});
      return result;
    };
    try {
      const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        while (!fatal && nextTask < tasks.length) {
          checkAbort(signal);
          const { f, c } = tasks[nextTask++]; const file = app.files[f]; currentFile = file.path;
          try {
            const size = Math.min(CHUNK_SIZE, file.size - c * CHUNK_SIZE);
            const bytes = new Uint8Array(await selected[f].file.slice(c * CHUNK_SIZE, c * CHUNK_SIZE + size).arrayBuffer());
            checkAbort(signal);
            const blob = await this.#request(this.#path('/git/blobs'), { method: 'POST', signal, body: { content: bytesToBase64(bytes), encoding: 'base64' } });
            app.files[f].chunks[c] = { sha: safeSHA(blob.sha), size };
            loaded += size; changed++; emit('uploading');
            if (changed >= 8) { changed = 0; await flush(signal); }
          } catch (error) { fatal = error; throw error; }
        }
      }));
      const failed = workers.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      checkAbort(signal);
      await flushQueue;
      const stored = await flush(signal, true);
      loaded = totalBytes; app = stored; emit('complete');
      return app;
    } catch (error) {
      // A paused upload keeps completed objects referenced on the data branch.
      // Bound this last checkpoint so cancellation cannot wait indefinitely.
      await flushQueue;
      if (changed > 0 || completedBytes(app) > initialLoaded) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
        try { await flush(controller.signal); } catch {} finally { clearTimeout(timer); }
      }
      if (signal?.aborted || error.name === 'AbortError') throw abortError();
      throw error;
    }
  }

  async renameApp(id, name) {
    id = validateSlug(id); name = validateName(name);
    return this.#mutate(async ({ head, catalog }) => {
      const index = catalog.apps.findIndex(a => a.id === id); if (index < 0) problem('这个应用已被删除。', 404);
      const app = validateManifest(await this.#jsonAt(manifestPath(id), head.sha)); app.name = name; app.updatedAt = now();
      catalog.apps[index] = metadata(app);
      return { entries: [{ path: manifestPath(id), mode: '100644', type: 'blob', content: JSON.stringify(app) }], message: `Rename application to ${name}`, result: app };
    });
  }
  async deleteApp(id) {
    id = validateSlug(id);
    return this.#mutate(async ({ catalog }) => {
      const old = catalog.apps.find(a => a.id === id); if (!old) return { unchanged: true };
      catalog.apps = catalog.apps.filter(a => a.id !== id);
      const entries = [{ path: manifestPath(id), mode: '100644', type: 'blob', sha: null }];
      // Shared content-addressed objects are removed only if no other catalog
      // entry references them. Git commit history still retains old objects.
      if (Array.isArray(old._objects) && catalog.apps.every(a => Array.isArray(a._objects))) {
        const used = new Set(catalog.apps.flatMap(a => a._objects));
        for (const sha of old._objects) if (shaPattern.test(sha) && !used.has(sha)) entries.push({ path: `objects/${sha}`, mode: '100644', type: 'blob', sha: null });
      }
      return { entries, message: `Remove application ${old.name}` };
    });
  }
  async readChunk(sha, { signal } = {}) {
    const bytes = await this.#request(this.#path(`/git/blobs/${safeSHA(sha)}`), { signal, raw: true });
    if (bytes.byteLength > CHUNK_SIZE) problem('文件分块超过预期大小。', 422);
    return bytes;
  }
  async streamFile(id, path) {
    const cached = this.#readManifests.get(id);
    const app = cached && Date.now() - cached.at < 30000 ? cached.app : await this.getApp(id);
    return this.#streamFromManifest(app, path);
  }
  #streamFromManifest(app, path) {
    path = validatePath(path);
    const file = app.files.find(f => f.path === path); if (!file) problem('应用中没有这个文件。', 404);
    if (app.status !== 'ready') problem('应用尚未发布完成。', 409);
    let index = 0; const controller = new AbortController(); const store = this;
    const stream = new ReadableStream({
      async pull(out) {
        try {
          if (index === file.chunks.length) { out.close(); return; }
          const chunk = file.chunks[index++]; const bytes = await store.readChunk(chunk.sha, { signal: controller.signal });
          if (bytes.length !== chunk.size) problem('云端分块大小不一致。', 422);
          out.enqueue(bytes);
        } catch (error) { out.error(error); }
      },
      cancel() { controller.abort(); },
    });
    return { stream, size: file.size, type: file.type || 'application/octet-stream', path };
  }
  async readFile(id, path) {
    const file = await this.streamFile(id, path);
    const blob = await new Response(file.stream, { headers: { 'Content-Type': file.type } }).blob();
    return blob;
  }
  async downloadApp(id) {
    const app = await this.getApp(id); const results = [];
    for (const file of app.files) {
      const { stream, type } = this.#streamFromManifest(app, file.path);
      results.push({ path: file.path, blob: await new Response(stream, { headers: { 'Content-Type': type } }).blob() });
    }
    return results;
  }
}
