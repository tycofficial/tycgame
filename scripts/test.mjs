import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MockR2Bucket } from './mock-r2.mjs';
import { handle } from '../worker/backend.js';

const ORIGIN = 'https://publisher.test';
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const encoder = new TextEncoder();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ownerHash = user => createHash('sha256').update(user).digest('hex').slice(0, 32);
const fileKey = (app, index = 0, user = 'alice') => `accounts/${ownerHash(user)}/data/${app.id}/${app.revision}/files/${index}`;

function setup() {
  const BUCKET = new MockR2Bucket();
  const env = { BUCKET };
  const tasks = [];
  const ctx = { waitUntil(promise) { tasks.push(promise); } };
  async function request(path, { method = 'GET', body, user = 'alice', headers = {}, writeHeaders = true, storage = true } = {}) {
    const requestHeaders = new Headers(headers);
    if (user) {
      requestHeaders.set('oai-authenticated-user-id', user);
      requestHeaders.set('oai-authenticated-user-email', `${user}@example.test`);
    }
    if (method !== 'GET' && method !== 'HEAD' && writeHeaders) {
      requestHeaders.set('X-Publisher-Request', '1');
      if (!requestHeaders.has('Origin')) requestHeaders.set('Origin', ORIGIN);
    }
    if (body != null && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body !== 'string' && !(body instanceof ReadableStream)) {
      body = JSON.stringify(body);
      requestHeaders.set('Content-Type', 'application/json');
    }
    const response = await handle(new Request(`${ORIGIN}${path}`, { method, headers: requestHeaders, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), storage ? env : {}, ctx);
    await Promise.all(tasks.splice(0));
    return response;
  }
  async function json(path, options) {
    const response = await request(path, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { assert.fail(`Expected JSON from ${path}: ${response.status} ${text.slice(0, 250)}`); }
    return { response, data };
  }
  async function create({ name = '测试应用', slug = 'test-app', entry = 'index.html', files = [{ path: 'index.html', size: 16, type: 'text/html', lastModified: 0 }], ...options } = {}) {
    const result = await json('/api/apps', { method: 'POST', body: { name, slug, entry, files }, ...options });
    assert.ok([200, 201].includes(result.response.status), `create failed: ${result.response.status} ${JSON.stringify(result.data)}`);
    assert.equal(result.data.app.slug, slug);
    return result.data;
  }
  async function uploadSmall(slug, bytes, index = 0, user = 'alice') {
    const result = await json(`/api/apps/${slug}/files/${index}/whole`, { method: 'PUT', body: bytes, user });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    return result;
  }
  async function publish(slug, user = 'alice') {
    const result = await json(`/api/apps/${slug}/publish`, { method: 'POST', body: {}, user });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.app.status, 'ready');
    return result;
  }
  return { BUCKET, env, request, json, create, uploadSmall, publish };
}

test('cloud APIs require sign-in and configured object storage', async () => {
  const s = setup();
  assert.equal((await s.request('/api/me', { user: null })).status, 401);
  assert.equal((await s.request('/api/apps', { user: null })).status, 401);
  assert.equal((await s.request('/api/me', { storage: false })).status, 503);
  const { response, data } = await s.json('/api/me');
  assert.equal(response.status, 200);
  assert.equal(data.user.email, 'alice@example.test');
  assert.deepEqual(data.apps, []);
  assert.equal(data.storage.usedBytes, 0);
  assert.equal(data.storage.pendingBytes, 0);
  assert.ok(data.limits.maxAppBytes >= GiB);
  assert.equal(data.limits.partSize, 8 * MiB);
});

test('writes reject missing request marker and foreign or opaque origins', async () => {
  const s = setup();
  const body = { name: 'bad', slug: 'bad', entry: 'index.html', files: [{ path: 'index.html', size: 1 }] };
  assert.equal((await s.request('/api/apps', { method: 'POST', body, writeHeaders: false })).status, 403);
  assert.equal((await s.request('/api/apps', { method: 'POST', body, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await s.request('/api/apps', { method: 'POST', body, headers: { Origin: 'null' } })).status, 403);
  assert.equal(s.BUCKET.objects.size, 0);
});

test('upload manifests reject traversal and unsafe file paths', async () => {
  const s = setup();
  const paths = ['../secret.html', 'assets/../../secret.html', '/index.html', 'assets\\secret.js', 'a\u0000b.html'];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    const response = await s.request('/api/apps', { method: 'POST', body: { name: 'path test', slug: `unsafe-${index}`, entry: path, files: [{ path, size: 1 }] } });
    assert.ok([400, 422].includes(response.status), `${JSON.stringify(path)} accepted: ${response.status}`);
  }
});

test('duplicate slugs conflict per user and cloud reads/writes stay isolated', async () => {
  const s = setup();
  await s.create({ slug: 'same-slug' });
  const conflict = await s.request('/api/apps', { method: 'POST', body: { name: 'duplicate', slug: 'same-slug', entry: 'index.html', files: [{ path: 'index.html', size: 16 }] } });
  assert.equal(conflict.status, 409);
  assert.equal((await s.request('/api/apps/same-slug', { user: 'bob' })).status, 404);
  assert.equal((await s.request('/api/apps/same-slug', { user: 'bob', method: 'DELETE' })).status, 404);
  assert.deepEqual((await s.json('/api/apps', { user: 'bob' })).data.apps, []);
  await s.create({ slug: 'same-slug', name: 'Bob application', user: 'bob' });
  const alice = (await s.json('/api/apps/same-slug')).data.app;
  const bob = (await s.json('/api/apps/same-slug', { user: 'bob' })).data.app;
  assert.notEqual(alice.name, bob.name);
  const renamed = await s.json('/api/apps/same-slug', { method: 'PATCH', body: { name: 'Alice renamed' } });
  assert.equal(renamed.response.status, 200);
  assert.equal((await s.json('/api/apps/same-slug', { user: 'bob' })).data.app.name, 'Bob application');
});

test('concurrent creation reserves each user slug atomically', async () => {
  const s = setup();
  const body = { name: '同名并发创建', slug: 'atomic-slug', entry: 'index.html', files: [{ path: 'index.html', size: 1 }] };
  const responses = await Promise.all(Array.from({ length: 6 }, () => s.request('/api/apps', { method: 'POST', body })));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 5);
  assert.equal((await s.json('/api/apps')).data.apps.length, 1);
});

test('single HTML uploads, publishes, runs by short path and deletes cleanly', async () => {
  const s = setup();
  const bytes = encoder.encode('<!doctype html><title>跨设备 HTML</title><h1>运行成功</h1>');
  await s.create({ slug: 'hello-html', files: [{ path: 'index.html', size: bytes.byteLength, type: 'text/html' }] });
  assert.ok([404, 409].includes((await s.request('/a/hello-html/')).status));
  assert.ok([400, 409].includes((await s.request('/api/apps/hello-html/publish', { method: 'POST', body: {} })).status));
  await s.uploadSmall('hello-html', bytes);
  await s.publish('hello-html');
  const redirect = await s.request('/hello-html');
  assert.ok([301, 302, 307, 308].includes(redirect.status));
  assert.ok(redirect.headers.get('location').endsWith('/a/hello-html/'));
  const run = await s.request('/a/hello-html/');
  assert.equal(run.status, 200);
  assert.match(run.headers.get('content-type'), /text\/html/);
  assert.match(run.headers.get('content-security-policy'), /sandbox/);
  assert.doesNotMatch(run.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal(await run.text(), new TextDecoder().decode(bytes));
  assert.equal((await s.request('/a/hello-html/', { user: 'bob' })).status, 404);
  const listing = (await s.json('/api/me')).data;
  assert.equal(listing.apps.length, 1);
  assert.equal(listing.storage.usedBytes, bytes.byteLength);
  assert.equal(listing.storage.pendingBytes, 0);
  assert.equal((await s.request('/api/apps/hello-html', { method: 'DELETE' })).status, 200);
  assert.equal((await s.request('/a/hello-html/')).status, 404);
  assert.deepEqual((await s.json('/api/apps')).data.apps, []);
  assert.equal(s.BUCKET.uploads.size, 0);
  assert.ok([...s.BUCKET.objects.values()].every(record => !record.httpMetadata.contentType?.includes('text/html')));
});

test('multi-file app preserves nested paths and serves the configured entry', async () => {
  const s = setup();
  const html = encoder.encode('<!doctype html><script src="assets/app.js"></script>');
  const js = encoder.encode('window.appReady = true;');
  await s.create({ slug: 'folder-app', entry: 'pages/home.html', files: [{ path: 'pages/home.html', size: html.byteLength, type: 'text/html' }, { path: 'pages/assets/app.js', size: js.byteLength, type: 'text/javascript' }] });
  await s.uploadSmall('folder-app', html, 0);
  await s.uploadSmall('folder-app', js, 1);
  await s.publish('folder-app');
  const entry = await s.request('/a/folder-app/');
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), `${ORIGIN}/a/folder-app/pages/home.html`);
  assert.equal(new URL('assets/app.js', entry.headers.get('location')).pathname, '/a/folder-app/pages/assets/app.js');
  const response = await s.request('/a/folder-app/pages/assets/app.js');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), new TextDecoder().decode(js));
  const detail = (await s.json('/api/apps/folder-app')).data;
  assert.equal(detail.app.fileCount, 2);
  assert.ok(detail.files.every(file => file.uploaded));
});

test('multipart retries remain idempotent and resume returns uploaded parts', async () => {
  const s = setup();
  const partSize = 8 * MiB;
  const tail = encoder.encode('last-part');
  await s.create({ slug: 'multipart-app', files: [{ path: 'index.html', size: partSize + tail.byteLength, type: 'text/html' }] });
  const firstInit = await s.json('/api/apps/multipart-app/files/0/init', { method: 'POST', body: {} });
  assert.equal(firstInit.response.status, 200);
  assert.ok(firstInit.data.uploadId);
  const bytes = new Uint8Array(partSize).fill(65);
  const first = await s.json('/api/apps/multipart-app/files/0/parts/1', { method: 'PUT', body: bytes });
  assert.equal(first.response.status, 200);
  const retry = await s.json('/api/apps/multipart-app/files/0/parts/1', { method: 'PUT', body: bytes });
  assert.equal(retry.response.status, 200);
  assert.equal(first.data.etag, retry.data.etag);
  const resumed = await s.json('/api/apps/multipart-app/files/0/init', { method: 'POST', body: {} });
  assert.equal(resumed.data.uploadId, firstInit.data.uploadId);
  assert.equal(resumed.data.parts.length, 1);
  assert.equal(resumed.data.parts[0].partNumber, 1);
  const pending = (await s.json('/api/me')).data;
  assert.equal(pending.storage.pendingBytes, partSize + tail.byteLength);
  const last = await s.json('/api/apps/multipart-app/files/0/parts/2', { method: 'PUT', body: tail });
  assert.equal(last.response.status, 200);
  const complete = await s.json('/api/apps/multipart-app/files/0/complete', { method: 'POST', body: {} });
  assert.equal(complete.response.status, 200, JSON.stringify(complete.data));
  assert.equal(s.BUCKET.uploads.size, 0);
  await s.publish('multipart-app');
  const start = await s.request('/a/multipart-app/', { headers: { Range: 'bytes=0-3' } });
  assert.equal(start.status, 206);
  assert.equal(start.headers.get('content-range'), `bytes 0-3/${partSize + tail.byteLength}`);
  assert.equal(await start.text(), 'AAAA');
  const suffix = await s.request('/a/multipart-app/', { headers: { Range: 'bytes=-9' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), 'last-part');
  assert.equal((await s.request('/a/multipart-app/', { headers: { Range: `bytes=${partSize + tail.byteLength}-` } })).status, 416);
  assert.equal((await s.request('/a/multipart-app/', { headers: { Range: 'bytes=10-2' } })).status, 416);
});

test('canceling an incomplete multipart app aborts cloud uploads and removes it', async () => {
  const s = setup();
  await s.create({ slug: 'cancel-me', files: [{ path: 'index.html', size: 20 * MiB, type: 'text/html' }] });
  await s.request('/api/apps/cancel-me/files/0/init', { method: 'POST', body: {} });
  assert.equal(s.BUCKET.uploads.size, 1);
  assert.equal((await s.request('/api/apps/cancel-me', { method: 'DELETE' })).status, 200);
  assert.equal(s.BUCKET.uploads.size, 0);
  assert.equal((await s.json('/api/me')).data.storage.pendingBytes, 0);
});

test('a 1 GiB multi-file manifest is accepted without loading its file data', async () => {
  const s = setup();
  const files = Array.from({ length: 128 }, (_, index) => ({ path: index === 0 ? 'index.html' : `assets/file-${index}.bin`, size: 8 * MiB, type: index === 0 ? 'text/html' : 'application/octet-stream' }));
  const created = await s.create({ slug: 'one-gib-app', files });
  assert.equal(created.app.totalBytes, GiB);
  assert.equal(created.app.fileCount, 128);
  const usage = (await s.json('/api/me')).data.storage;
  assert.equal(usage.usedBytes, 0);
  assert.equal(usage.pendingBytes, GiB);
  assert.ok([...s.BUCKET.objects.values()].every(record => record.size < MiB));
});

test('120 MiB HTML is returned as an R2 stream without reading the whole body', async () => {
  const s = setup();
  const size = 120 * MiB;
  const slug = 'large-stream';
  const { app } = await s.create({ slug, files: [{ path: 'index.html', size, type: 'text/html' }] });
  const key = fileKey(app);
  s.BUCKET.seedVirtual(key, size, { prefix: '<!doctype html><h1>120 MiB</h1>', httpMetadata: { contentType: 'text/html' } });
  await s.publish(slug);
  s.BUCKET.stats.fullBodyReadKeys.length = 0;
  s.BUCKET.stats.streamBytesServed = 0;
  const response = await s.request(`/a/${slug}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(size));
  assert.equal(s.BUCKET.stats.fullBodyReadKeys.includes(key), false);
  assert.ok(s.BUCKET.stats.streamBytesServed < MiB, 'Serving a large object must not buffer it');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.byteLength <= 64 * 1024);
  assert.match(new TextDecoder().decode(first.value), /^<!doctype html><h1>120 MiB<\/h1>/);
  await reader.cancel();
  assert.ok(s.BUCKET.stats.streamBytesServed < MiB);
  const head = await s.request(`/a/${slug}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), String(size));
});

test('late uploads after delete and slug recreation cannot change the new app', { timeout: 5000 }, async () => {
  const s = setup();
  const { app: oldApp } = await s.create({ slug: 'recreate-app', files: [{ path: 'index.html', size: 4, type: 'text/html' }] });
  const oldKey = fileKey(oldApp);
  const entered = deferred();
  const release = deferred();
  const originalPut = s.BUCKET.put.bind(s.BUCKET);
  s.BUCKET.put = async (key, value, options) => {
    if (key === oldKey) { entered.resolve(); await release.promise; }
    return originalPut(key, value, options);
  };
  const lateUpload = s.request('/api/apps/recreate-app/files/0/whole', { method: 'PUT', body: encoder.encode('OLD!') });
  await entered.promise;
  assert.equal((await s.request('/api/apps/recreate-app', { method: 'DELETE' })).status, 200);
  const { app: newApp } = await s.create({ slug: 'recreate-app', files: [{ path: 'index.html', size: 4, type: 'text/html' }] });
  assert.notEqual(newApp.revision, oldApp.revision);
  await s.uploadSmall('recreate-app', encoder.encode('NEW!'));
  await s.publish('recreate-app');
  release.resolve();
  assert.equal((await lateUpload).status, 409);
  assert.equal(s.BUCKET.objects.has(oldKey), false);
  assert.equal(await (await s.request('/a/recreate-app/')).text(), 'NEW!');
});

test('publishing between file write and upload response keeps the ready file', { timeout: 5000 }, async () => {
  const s = setup();
  const { app } = await s.create({ slug: 'publish-race', files: [{ path: 'index.html', size: 4, type: 'text/html' }] });
  const key = fileKey(app);
  const entered = deferred();
  const release = deferred();
  const originalPut = s.BUCKET.put.bind(s.BUCKET);
  s.BUCKET.put = async (objectKey, value, options) => {
    const result = await originalPut(objectKey, value, options);
    if (objectKey === key) { entered.resolve(); await release.promise; }
    return result;
  };
  const upload = s.request('/api/apps/publish-race/files/0/whole', { method: 'PUT', body: encoder.encode('GOOD') });
  await entered.promise;
  await s.publish('publish-race');
  release.resolve();
  assert.equal((await upload).status, 200);
  const run = await s.request('/a/publish-race/');
  assert.equal(run.status, 200);
  assert.equal(await run.text(), 'GOOD');
});

test('a retry that was already in flight cannot overwrite a published whole file', { timeout: 5000 }, async () => {
  const s = setup();
  const { app } = await s.create({ slug: 'retry-race', files: [{ path: 'index.html', size: 4, type: 'text/html' }] });
  const key = fileKey(app);
  const entered = deferred();
  const release = deferred();
  const originalPut = s.BUCKET.put.bind(s.BUCKET);
  let delayOne = true;
  s.BUCKET.put = async (objectKey, value, options) => {
    if (objectKey === key && delayOne) { delayOne = false; entered.resolve(); await release.promise; }
    return originalPut(objectKey, value, options);
  };
  const lateUpload = s.request('/api/apps/retry-race/files/0/whole', { method: 'PUT', body: encoder.encode('LATE') });
  await entered.promise;
  await s.uploadSmall('retry-race', encoder.encode('GOOD'));
  await s.publish('retry-race');
  release.resolve();
  assert.ok([200, 409].includes((await lateUpload).status));
  const run = await s.request('/a/retry-race/');
  assert.equal(run.status, 200);
  assert.equal(await run.text(), 'GOOD');
});

test('multipart init racing deletion aborts its late-created upload session', { timeout: 5000 }, async () => {
  const s = setup();
  const { app } = await s.create({ slug: 'init-race', files: [{ path: 'index.html', size: 20 * MiB, type: 'text/html' }] });
  const transferKey = fileKey(app).replace('/files/0', '/transfers/0.json');
  const entered = deferred();
  const release = deferred();
  const originalPut = s.BUCKET.put.bind(s.BUCKET);
  s.BUCKET.put = async (key, value, options) => {
    if (key === transferKey) { entered.resolve(); await release.promise; }
    return originalPut(key, value, options);
  };
  const init = s.request('/api/apps/init-race/files/0/init', { method: 'POST', body: {} });
  await entered.promise;
  assert.equal(s.BUCKET.uploads.size, 1);
  assert.equal((await s.request('/api/apps/init-race', { method: 'DELETE' })).status, 200);
  release.resolve();
  assert.equal((await init).status, 409);
  assert.equal(s.BUCKET.uploads.size, 0);
  assert.equal(s.BUCKET.objects.has(transferKey), false);
});

test('deletion can resume after a transient storage failure during cleanup', async () => {
  const s = setup();
  await s.create({ slug: 'retry-delete', files: [{ path: 'index.html', size: 4, type: 'text/html' }] });
  await s.uploadSmall('retry-delete', encoder.encode('GOOD'));
  await s.publish('retry-delete');
  const originalList = s.BUCKET.list.bind(s.BUCKET);
  let failOnce = true;
  s.BUCKET.list = async options => {
    if (failOnce && options.prefix.includes('/data/')) { failOnce = false; throw new Error('Simulated transient R2 failure'); }
    return originalList(options);
  };
  assert.equal((await s.request('/api/apps/retry-delete', { method: 'DELETE' })).status, 500);
  assert.equal((await s.request('/api/apps/retry-delete', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await s.json('/api/apps')).data.apps, []);
  assert.equal(s.BUCKET.uploads.size, 0);
  assert.equal(s.BUCKET.objects.size, 0);
});

test('file size mismatches and premature multipart completion are rejected', async () => {
  const s = setup();
  await s.create({ slug: 'size-check', files: [{ path: 'index.html', size: 25, type: 'text/html' }] });
  const small = await s.request('/api/apps/size-check/files/0/whole', { method: 'PUT', body: encoder.encode('short') });
  assert.ok([400, 409, 413, 422].includes(small.status));
  await s.create({ slug: 'incomplete', files: [{ path: 'index.html', size: 20 * MiB, type: 'text/html' }] });
  await s.request('/api/apps/incomplete/files/0/init', { method: 'POST', body: {} });
  const response = await s.request('/api/apps/incomplete/files/0/complete', { method: 'POST', body: {} });
  assert.ok([400, 409, 422].includes(response.status));
});
