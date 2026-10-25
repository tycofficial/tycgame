/* TycGame runtime: credentials remain in this worker's volatile memory only.
 * A session grants reads of one immutable, approved file manifest. It is never
 * a GitHub API proxy, never exposes a token, and never borrows another session.
 */
'use strict';
const sessions = new Map();
const scope = new URL(self.registration.scope).pathname;
const virtualPrefix = scope + '__tyc_runtime/';
const TTL = 4 * 60 * 60 * 1000;
const NETWORK_IDLE_MS = 15000;
const PUBLIC_CACHE = 'tycgame-public-chunks-v1';
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
        const session = sessions.get(message.session) || await restorePublicSession(message.session);
        if (session && session.expires > Date.now()) { session.expires = Date.now() + TTL; port.postMessage({ok:true,exists:true}); }
        else { sessions.delete(message.session); port.postMessage({ok:true,exists:false}); }
        return;
      }
      if (message.type === 'TYC_CLOSE') {
        const session=sessions.get(message.session);if(session){session.revoked=true;session.token='';session.memory?.clear();for(const abort of session.abortControllers || [])abort.abort();}
        sessions.delete(message.session);
        if(typeof caches!=='undefined')try{await(await caches.open('tycgame-public-sessions-v1')).delete(new URL('__tyc_public_session/'+message.session,self.registration.scope));}catch{}
        port.postMessage({ok:true});return;
      }
      if (message.type === 'TYC_WATCH') {
        const session=sessions.get(message.session);
        if(!session)throw new Error('运行会话已结束');
        if(event.source?.id)session.observers.add(event.source.id);
        port.postMessage({ok:true,progress:session.progress || null});return;
      }
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
        cap:message.session,mode,appId:app.id,revision:app.revision,entry:app.entry,files,expires:Date.now()+TTL,
        owner:connection.owner,repo:connection.repo,branch:connection.branch || 'tycgame-data',
        token:mode === 'github' && typeof connection.token === 'string' ? connection.token.trim() : '',
        private:typeof connection.private==='boolean'?connection.private:null,observers:new Set(),progress:null,memory:new Map(),memoryBytes:0,abortControllers:new Set(),
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

function report(session,details) {
  session.progress={...details,at:Date.now()};
  if(details.state==='downloading' && session.lastReport && Date.now()-session.lastReport<200)return;
  session.lastReport=Date.now();
  if(!self.clients?.get)return;
  for(const id of session.observers || [])self.clients.get(id).then(client=>client?.postMessage({type:'TYC_PROGRESS',session:session.cap,...session.progress})).catch(()=>{});
}
function chunkProgress(session,file,index,loaded,cached=false){
  session.fileProgress ||= new Map();
  let parts=session.fileProgress.get(file.path);if(!parts){parts=new Map();session.fileProgress.set(file.path,parts);}
  parts.set(index,Math.max(parts.get(index)||0,loaded));
  report(session,{path:file.path,loaded:Math.min(file.size,[...parts.values()].reduce((sum,value)=>sum+value,0)),total:file.size,state:'downloading',cached});
}
async function savePublicSession(session){
  if(!session.cap || session.revoked || session.savedPublic || typeof caches==='undefined')return;
  session.savedPublic=true;
  try{const cache=await caches.open('tycgame-public-sessions-v1');const {cap,owner,repo,branch,entry,appId,revision}=session;const key=new URL('__tyc_public_session/'+cap,self.registration.scope);await cache.put(key,new Response(JSON.stringify({cap,owner,repo,branch,entry,appId,revision,files:[...session.files.values()]}),{headers:{'Content-Type':'application/json'}}));if(session.revoked)await cache.delete(key);}catch{session.savedPublic=false;}
}
async function restorePublicSession(cap){
  if(!/^[a-f0-9]{64}$/.test(cap || '') || typeof caches==='undefined')return null;
  try{const response=await(await caches.open('tycgame-public-sessions-v1')).match(new URL('__tyc_public_session/'+cap,self.registration.scope));if(!response)return null;const data=await response.json();if(data.cap!==cap || !Array.isArray(data.files))return null;const session={...data,mode:'github',private:false,publicReadable:true,token:'',files:new Map(data.files.map(file=>[file.path,file])),expires:Date.now()+TTL,observers:new Set(),memory:new Map(),memoryBytes:0,savedPublic:true,abortControllers:new Set()};sessions.set(cap,session);return session;}catch{return null;}
}
function cacheKey(session,sha){return new URL(`__tyc_cache/${encodeURIComponent(session.owner)}/${encodeURIComponent(session.repo)}/${sha}`,self.registration.scope).href;}
async function publicCached(session,chunk){
  if(session.private===true || typeof caches==='undefined')return null;
  try{const response=await(await caches.open(PUBLIC_CACHE)).match(cacheKey(session,chunk.sha));if(response){const blob=await response.blob();if(blob.size===chunk.size)return blob;}}catch{}
  return null;
}
async function rememberChunk(session,chunk,blob,isPublic){
  if(isPublic && typeof caches!=='undefined'){
    try{const cache=await caches.open(PUBLIC_CACHE);await cache.put(cacheKey(session,chunk.sha),new Response(blob,{headers:{'Content-Length':String(blob.size)}}));const keys=await cache.keys();for(const key of keys.slice(0,Math.max(0,keys.length-64)))await cache.delete(key);}catch{}
  }else if(session.memory){
    if(!session.memory.has(chunk.sha)){session.memory.set(chunk.sha,blob);session.memoryBytes+=blob.size;}
    while(session.memoryBytes>32*1024**2 && session.memory.size){const key=session.memory.keys().next().value;session.memoryBytes-=session.memory.get(key).size;session.memory.delete(key);}
  }
}
function abortFailure(){return new DOMException('读取已取消','AbortError');}
async function openNetwork(url,headers,signal){
  const abort=new AbortController();
  const canceled=()=>abort.abort(signal?.reason || abortFailure());
  if(signal?.aborted)throw abortFailure();signal?.addEventListener('abort',canceled,{once:true});
  const timed=async operation=>{
    let timer;
    try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Object.assign(new Error('GitHub 连接连续 15 秒没有响应，请检查网络后重试。'),{retryable:true});reject(error);abort.abort(error);},NETWORK_IDLE_MS);})]);}
    finally{clearTimeout(timer);}
  };
  const close=()=>{signal?.removeEventListener('abort',canceled);abort.abort();};
  try{
    const response=await timed(fetch(url,{headers,cache:'no-cache',credentials:'omit',referrerPolicy:'no-referrer',signal:abort.signal}));
    if(!response.ok){response.body?.cancel().catch(()=>{});const status=response.status;throw Object.assign(new Error(status===403 || status===429?'GitHub 配额或访问频率受限，请稍后重试（可在主页连接令牌）。':status===401?'GitHub 令牌已失效，请返回主页重新连接。':`云端分块读取失败（${status}）`),{status,retryable:status>=500});}
    if(!response.body)throw new Error('云端分块为空');
    return {response,timed,close};
  }catch(error){close();throw error;}
}
async function githubChunk(session,chunk,signal,onProgress=()=>{}) {
  const memory=session.memory?.get(chunk.sha),cached=memory || await publicCached(session,chunk);
  if(cached){onProgress(chunk.size,true);return cached.stream();}
  const prefix=`${encodeURIComponent(session.owner)}/${encodeURIComponent(session.repo)}`;
  const raw=`https://raw.githubusercontent.com/${prefix}/${encodeURIComponent(session.branch)}/objects/${chunk.sha}`;
  const api=`https://api.github.com/repos/${prefix}/git/blobs/${chunk.sha}`;
  let reader=null,network=null,attempt=0,offset=0,skip=0,closed=false,isPublic=false,preferAPI=session.private===true || session.preferAPI===true;
  const pieces=[];
  async function open(){
    let error;
    while(attempt<3){
      if(signal?.aborted)throw abortFailure();
      const sources=preferAPI?[false]:[true,false];
      for(const anonymousRaw of sources){
        try{
          const headers=anonymousRaw?{}:{Accept:'application/vnd.github.raw+json',...(session.token?{Authorization:`Bearer ${session.token}`}:{})};
          network=await openNetwork(anonymousRaw?raw:api,headers,signal);
          isPublic=anonymousRaw || !session.token;
          if(isPublic){session.publicReadable=true;savePublicSession(session).catch(()=>{});}
          let body=network.response.body;
          // API fallback may use a base64 envelope. Only one <=8 MiB object is
          // buffered here; large HTML is never assembled as a single buffer.
          if(!anonymousRaw && /\bjson\b/i.test(network.response.headers.get('content-type') || '')){
            const input=body.getReader(),parts=[];let size=0;
            while(true){const value=await network.timed(input.read());if(value.done)break;size+=value.value.byteLength;if(size>chunk.size*1.5+1024**2)throw new Error('GitHub 分块响应超出长度限制');parts.push(value.value);}
            let blob=new Blob(parts),value;try{value=JSON.parse(await blob.text());}catch{}
            if(value?.sha===chunk.sha && value.encoding==='base64' && typeof value.content==='string'){const binary=atob(value.content.replace(/\s/g,'')),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);blob=new Blob([bytes]);}
            body=blob.stream();
          }
          reader=body.getReader();skip=offset;return;
        }catch(failure){network?.close();network=null;error=failure;if(signal?.aborted)throw abortFailure();if(anonymousRaw){preferAPI=true;session.preferAPI=true;continue;}if(failure.retryable===false || [401,403,404,429].includes(failure.status))throw failure;}
      }
      attempt++;
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,250*attempt));
    }
    throw error || new Error('云端分块重试 3 次后仍无法读取，请重新加载。');
  }
  await open();
  return new ReadableStream({
    async pull(controller){
      if(closed)return;
      try{
        while(true){
          try{
            const {done,value}=await network.timed(reader.read());
            if(done){if(offset!==chunk.size)throw new Error('云端分块传输不完整');closed=true;network.close();await rememberChunk(session,chunk,new Blob(pieces),isPublic);controller.close();return;}
            if(skip>=value.byteLength){skip-=value.byteLength;continue;}
            const output=value.subarray(skip);skip=0;
            if(offset+output.byteLength>chunk.size)throw new Error('云端分块长度不符');
            offset+=output.byteLength;pieces.push(output);onProgress(offset,false);
            if(offset===chunk.size){closed=true;await rememberChunk(session,chunk,new Blob(pieces),isPublic);network.close();controller.enqueue(output);controller.close();return;}
            controller.enqueue(output);return;
          }catch(error){
            reader?.cancel().catch(()=>{});network?.close();
            if(signal?.aborted || attempt>=2 || error.retryable===false || [401,403,404,429].includes(error.status))throw error;
            attempt++;preferAPI=true;session.preferAPI=true;await open();
          }
        }
      }catch(error){const canceled=closed;closed=true;reader?.cancel().catch(()=>{});network?.close();if(!canceled)controller.error(error);}
    },
    async cancel(reason){closed=true;reader?.cancel(reason).catch(()=>{});network?.close();},
  },{highWaterMark:0});
}

function fileStream(session,file,range) {
  let index=0,skip=range.offset,remaining=range.length,reader=null,partRead=0,stopped=false,cancelled=false;
  while(index<file.chunks.length && skip>=file.chunks[index].size) {skip-=file.chunks[index].size;index++;}
  let last=index,covered=file.chunks[index]?.size-skip || 0;
  while(covered<remaining && last+1<file.chunks.length){last++;covered+=file.chunks[last].size;}
  const lookAhead=file.size>8*1024**2;
  const pending=new Map();
  function prepare(partIndex) {
    if(stopped || session.revoked || partIndex>last || partIndex>=file.chunks.length)return null;
    if(pending.has(partIndex))return pending.get(partIndex);
    const abort=new AbortController();
    session.abortControllers?.add(abort);
    const task=session.mode==='local'?localChunk(session,file.chunks[partIndex]):githubChunk(session,file.chunks[partIndex],abort.signal,(loaded,cached)=>chunkProgress(session,file,partIndex,loaded,cached));
    // Observe rejection immediately, including a failed prefetch which has not
    // yet been consumed. Never leave a speculative fetch rejection unhandled.
    const entry={abort,promise:task.then(stream=>({stream}),error=>({error}))};
    pending.set(partIndex,entry);return entry;
  }
  async function shutdown(reason) {
    stopped=true;
    const current=reader;reader=null;
    const entries=[...pending.values()];pending.clear();
    for(const entry of entries){entry.abort.abort(reason);session.abortControllers?.delete(entry.abort);}
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
          if(done){if(partRead!==file.chunks[index].size)throw new Error('文件分块长度不符');reader=null;session.abortControllers?.delete(pending.get(index)?.abort);pending.delete(index);index++;continue;}
          partRead+=value.byteLength;
          if(session.mode==='local')chunkProgress(session,file,index,partRead);
          if(partRead>file.chunks[index].size)throw new Error('文件分块长度不符');
          if(skip>=value.byteLength){skip-=value.byteLength;continue;}
          const output=value.subarray(skip,Math.min(value.byteLength,skip+remaining));skip=0;remaining-=output.byteLength;
          if(output.byteLength)controller.enqueue(output);
          if(!remaining){await shutdown();if(!cancelled){report(session,{path:file.path,loaded:file.size,total:file.size,state:'ready'});controller.close();}}
          return;
        }
        if(!stopped){await shutdown();if(!cancelled)controller.close();}
      } catch(error) {await shutdown(error);if(!cancelled){report(session,{path:file.path,loaded:session.progress?.loaded || 0,total:file.size,state:'error',error:error.message || '应用资源读取失败'});controller.error(error);}}
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
      const session=sessions.get(id) || await restorePublicSession(id);
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
