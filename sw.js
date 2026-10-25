/* TycGame runtime: credentials remain in this worker's volatile memory only.
 * A session grants reads of one immutable, approved file manifest. It is never
 * a GitHub API proxy, never exposes a token, and never borrows another session.
 */
'use strict';
const sessions = new Map();
const scope = new URL(self.registration.scope).pathname;
const virtualPrefix = scope + '__tyc_runtime/';
const TTL = 4 * 60 * 60 * 1000;
const mime = { html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',json:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',ico:'image/x-icon',wasm:'application/wasm',woff:'font/woff',woff2:'font/woff2',txt:'text/plain; charset=utf-8',mp3:'audio/mpeg',mp4:'video/mp4',webm:'video/webm',pdf:'application/pdf' };
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.startsWith('/') && !/[\\\x00-\x1f\x7f?#]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const errorResponse = (message,status=400) => new Response(message,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const port = event.ports?.[0];
  if (!port) return;
  event.waitUntil((async () => {
    try {
      const message = event.data || {};
      if (!/^[a-f0-9]{64}$/.test(message.session || '')) throw new Error('运行会话无效');
      if (message.type === 'TYC_STATUS') {
        const session = sessions.get(message.session);
        if (session && session.expires > Date.now()) { session.expires = Date.now() + TTL; port.postMessage({ok:true,exists:true}); }
        else { sessions.delete(message.session); port.postMessage({ok:true,exists:false}); }
        return;
      }
      if (message.type === 'TYC_CLOSE') { sessions.delete(message.session); port.postMessage({ok:true}); return; }
      if (message.type !== 'TYC_CONFIGURE') throw new Error('不支持的运行请求');
      // Existing sessions cannot be changed, even by a same-origin application
      // which disguises its URL with history.replaceState(). Source URLs alone
      // are deliberately not treated as an authorization boundary.
      if (sessions.has(message.session)) { port.postMessage({ok:true,exists:true}); return; }
      const app = message.app;
      const connection = message.connection || {};
      const mode = connection.mode === 'local' ? 'local' : 'github';
      if (!app || app.status !== 'ready' || !Array.isArray(app.files) || !app.files.length || app.files.length > 2000 || !safePath(app.entry)) throw new Error('应用清单无效或尚未发布');
      if (mode === 'github' && (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(connection.owner || '') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(connection.repo || '') || ['.','..'].includes(connection.repo))) throw new Error('GitHub 仓库配置无效');
      const files = new Map();
      let total = 0;
      for (const source of app.files) {
        if (!safePath(source.path) || files.has(source.path) || !Number.isSafeInteger(source.size) || source.size < 0 || !Array.isArray(source.chunks)) throw new Error('应用文件清单无效');
        const chunks = source.chunks.map(chunk => {
          if (!Number.isSafeInteger(chunk.size) || chunk.size < 0 || chunk.size > 8 * 1024 ** 2) throw new Error('文件分块无效');
          if (mode === 'github' && !/^[a-f0-9]{40}$/.test(chunk.sha || '')) throw new Error('GitHub 分块标识无效');
          if (mode === 'local' && (typeof chunk.key !== 'string' || !chunk.key || chunk.key.length > 2048)) throw new Error('本地分块标识无效');
          return mode === 'github' ? {sha:chunk.sha,size:chunk.size} : {key:chunk.key,size:chunk.size};
        });
        if (chunks.reduce((sum,chunk) => sum + chunk.size,0) !== source.size) throw new Error('文件分块长度与清单不符');
        total += source.size;
        files.set(source.path,{path:source.path,size:source.size,type:mime[source.path.split('.').pop().toLowerCase()] || 'application/octet-stream',chunks});
      }
      if (!files.has(app.entry) || total > 2 * 1024 ** 3) throw new Error('应用入口或体积无效');
      for (const [key,value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
      sessions.set(message.session,{
        mode,appId:app.id,revision:app.revision,entry:app.entry,files,expires:Date.now()+TTL,
        owner:connection.owner,repo:connection.repo,branch:connection.branch || 'tycgame-data',
        token:mode === 'github' && typeof connection.token === 'string' ? connection.token.trim() : '',
      });
      port.postMessage({ok:true,exists:false});
    } catch (error) { port.postMessage({ok:false,error:error.message || '无法建立运行会话'}); }
    finally { port.close(); }
  })());
});

function rangeOf(header,size) {
  if (!header) return {offset:0,length:size,partial:false};
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) throw new Error('range');
  let start,end;
  if (!match[1]) { const suffix=Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix<=0) throw new Error('range'); start=Math.max(0,size-suffix);end=size-1; }
  else { start=Number(match[1]);end=match[2] ? Math.min(Number(match[2]),size-1) : size-1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>=size || end<start) throw new Error('range');
  return {offset:start,length:end-start+1,partial:true};
}

async function localChunk(session,chunk) {
  const db = await new Promise((resolve,reject) => {
    const request=indexedDB.open('tycgame-v2',1);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(new Error('无法读取本地文件'));
    request.onupgradeneeded=()=>{request.transaction.abort();reject(new Error('没有找到本地应用数据'));};
  });
  try {
    const record=await new Promise((resolve,reject) => {const request=db.transaction('chunks','readonly').objectStore('chunks').get(chunk.key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('读取本地分块失败'));});
    if (!record || record.appId!==session.appId || (session.revision && record.revision!==session.revision) || !(record.data instanceof Blob) || record.data.size!==chunk.size) throw new Error('本地分块不存在或已变化');
    return record.data.stream();
  } finally {db.close();}
}

async function githubChunk(session,chunk,signal) {
  const api=`https://api.github.com/repos/${encodeURIComponent(session.owner)}/${encodeURIComponent(session.repo)}/git/blobs/${chunk.sha}`;
  const options={cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal};
  let response;
  if (!session.token) {
    const raw=`https://raw.githubusercontent.com/${encodeURIComponent(session.owner)}/${encodeURIComponent(session.repo)}/${encodeURIComponent(session.branch)}/objects/${chunk.sha}`;
    response=await fetch(raw,options);
    if (!response.ok) response=await fetch(api,{...options,headers:{Accept:'application/vnd.github.raw+json'}});
  } else response=await fetch(api,{...options,headers:{Accept:'application/vnd.github.raw+json',Authorization:`Bearer ${session.token}`}});
  if (!response.ok) throw new Error(response.status===403 || response.status===429 ? 'GitHub 请求受限，请稍后重新打开应用' : '无法读取云端分块，请返回主页重新连接仓库');
  if (/\bjson\b/i.test(response.headers.get('content-type') || '')) {
    // A raw file may itself be JSON. Decode only an actual Git blob envelope;
    // preserve original bytes for JSON resources belonging to the application.
    const value=await response.clone().json().catch(()=>null);
    if (value?.sha===chunk.sha && value.encoding==='base64' && typeof value.content==='string') {
      const binary=atob(value.content.replace(/\s/g,''));
      const bytes=new Uint8Array(binary.length);
      for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
      if(bytes.length!==chunk.size)throw new Error('云端分块长度不符');
      await response.body?.cancel();
      return new Blob([bytes]).stream();
    }
  }
  if (!response.body) throw new Error('云端分块为空');
  return response.body;
}

function fileStream(session,file,range) {
  let index=0,skip=range.offset,remaining=range.length,reader=null,partRead=0,stopped=false,cancelled=false;
  while(index<file.chunks.length && skip>=file.chunks[index].size) {skip-=file.chunks[index].size;index++;}
  let last=index,covered=file.chunks[index]?.size-skip || 0;
  while(covered<remaining && last+1<file.chunks.length){last++;covered+=file.chunks[last].size;}
  const lookAhead=file.size>8*1024**2;
  const pending=new Map();
  function prepare(partIndex) {
    if(stopped || partIndex>last || partIndex>=file.chunks.length)return null;
    if(pending.has(partIndex))return pending.get(partIndex);
    const abort=new AbortController();
    const task=session.mode==='local'?localChunk(session,file.chunks[partIndex]):githubChunk(session,file.chunks[partIndex],abort.signal);
    // Observe rejection immediately, including a failed prefetch which has not
    // yet been consumed. Never leave a speculative fetch rejection unhandled.
    const entry={abort,promise:task.then(stream=>({stream}),error=>({error}))};
    pending.set(partIndex,entry);return entry;
  }
  async function shutdown(reason) {
    stopped=true;
    const current=reader;reader=null;
    const entries=[...pending.values()];pending.clear();
    for(const entry of entries)entry.abort.abort(reason);
    await Promise.allSettled([
      ...(current?[current.cancel(reason)]:[]),
      ...entries.map(async entry=>{const result=await entry.promise;if(result.stream && !result.stream.locked)await result.stream.cancel(reason);}),
    ]);
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        while (remaining>0 && !stopped) {
          if(!reader){
            const entry=prepare(index);if(!entry)throw new Error('文件分块不完整');
            const result=await entry.promise;if(stopped)return;if(result.error)throw result.error;
            reader=result.stream.getReader();partRead=0;
            // At most the current chunk and one following chunk are in flight.
            // The final eligible index is computed from this request's Range,
            // so a partial request never speculates outside its covered chunks.
            if(lookAhead && index<last)prepare(index+1);
          }
          const {done,value}=await reader.read();
          if(stopped)return;
          if(done){if(partRead!==file.chunks[index].size)throw new Error('文件分块长度不符');reader=null;pending.delete(index);index++;continue;}
          partRead+=value.byteLength;
          if(partRead>file.chunks[index].size)throw new Error('文件分块长度不符');
          if(skip>=value.byteLength){skip-=value.byteLength;continue;}
          const output=value.subarray(skip,Math.min(value.byteLength,skip+remaining));skip=0;remaining-=output.byteLength;
          if(output.byteLength)controller.enqueue(output);
          if(!remaining){await shutdown();if(!cancelled)controller.close();}
          return;
        }
        if(!stopped){await shutdown();if(!cancelled)controller.close();}
      } catch(error) {await shutdown(error);if(!cancelled)controller.error(error);}
    },
    async cancel(reason){cancelled=true;await shutdown(reason);},
  },{highWaterMark:0});
}

self.addEventListener('fetch',event => {
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin || !url.pathname.startsWith(virtualPrefix))return;
  event.respondWith((async () => {
    try {
      if(!['GET','HEAD'].includes(event.request.method))return errorResponse('运行文件只允许读取',405);
      const rest=url.pathname.slice(virtualPrefix.length);const slash=rest.indexOf('/');
      const id=slash<0?rest:rest.slice(0,slash);
      const session=sessions.get(id);
      if(!session || session.expires<=Date.now()){sessions.delete(id);return errorResponse('运行会话已结束。请返回 TycGame 主页，重新打开应用。',410);}
      session.expires=Date.now()+TTL;
      let path;
      try{path=decodeURIComponent(slash<0?'':rest.slice(slash+1));}catch{return errorResponse('文件路径编码无效');}
      if(!path)path=session.entry;
      if(!safePath(path))return errorResponse('文件路径无效');
      let file=session.files.get(path);
      if(!file && !path.split('/').pop().includes('.') && (event.request.headers.get('accept') || '').includes('text/html'))file=session.files.get(session.entry);
      if(!file)return errorResponse('应用中没有此文件。请以相对资源路径构建静态 Web APP。',404);
      let range;
      try{range=rangeOf(event.request.headers.get('range'),file.size);}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size}`,'Cache-Control':'no-store'}});}
      const headers=new Headers({'Content-Type':file.type,'Content-Length':String(range.length),'Accept-Ranges':'bytes','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
      // Same-origin is required for service-worker control, modules and storage.
      // The manager is a separate, opener-free window and contains no persisted
      // token. Same-origin browser storage remains shared: run trusted code only.
      if(file.type.startsWith('text/html'))headers.set('Content-Security-Policy',"sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads; frame-ancestors 'self'; object-src 'none'");
      if(range.partial)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${file.size}`);
      return new Response(event.request.method==='HEAD'?null:fileStream(session,file,range),{status:range.partial?206:200,headers});
    }catch{return errorResponse('应用资源加载失败，请返回主页重新打开。',502);}
  })());
});
