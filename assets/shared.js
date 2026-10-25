export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_APP_BYTES = 2 * 1024 ** 3;
export const MAX_FILES = 2000;
export const LOCAL_DB_NAME = 'tycgame-v2';
export const LOCAL_DB_VERSION = 1;
const TYPES = {html:'text/html;charset=utf-8',htm:'text/html;charset=utf-8',js:'text/javascript;charset=utf-8',mjs:'text/javascript;charset=utf-8',css:'text/css;charset=utf-8',json:'application/json',wasm:'application/wasm',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',ico:'image/x-icon',avif:'image/avif',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',txt:'text/plain;charset=utf-8',xml:'application/xml',pdf:'application/pdf',webmanifest:'application/manifest+json'};
export const mimeFromPath = path => TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
export function abortError() { return new DOMException('传输已暂停，已完成的分块会保留。', 'AbortError'); }
export function throwIfAborted(signal) { if(signal?.aborted) throw abortError(); }
export function safePath(value) {
  if(typeof value!=='string'||!value||value.length>1024||value.startsWith('/')||/[\\\x00-\x1f\x7f?#]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('文件路径无效：请使用相对路径，不要包含 .. 或反斜线。');
  return value.normalize('NFC');
}
export function validSlug(value) { return typeof value==='string'&&/^[a-z0-9][a-z0-9-]{2,63}$/.test(value)&&!value.endsWith('-'); }
export function slugify(name='app') { const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,45);return (slug.length>=3?slug:'app')+'-'+crypto.randomUUID().slice(0,6); }
export function validateUpload({name,slug,entry,files}) {
  name=String(name||'').trim();if(!name||name.length>80)throw new Error('应用名称需要 1–80 个字符。');
  slug=slug||slugify(name);if(!validSlug(slug))throw new Error('访问后缀需为 3–64 位小写字母、数字或连字符。');
  if(!Array.isArray(files)||!files.length||files.length>MAX_FILES)throw new Error(`请选择 1–${MAX_FILES} 个文件。`);
  const seen=new Set();let totalBytes=0;
  const list=files.map(item=>{const path=safePath(item.path||item.file?.webkitRelativePath||item.file?.name);if(seen.has(path))throw new Error('存在重复文件路径：'+path);seen.add(path);const file=item.file;if(!file||!Number.isSafeInteger(file.size)||file.size<0||typeof file.slice!=='function')throw new Error('文件内容无效。');totalBytes+=file.size;return {file,path};});
  if(totalBytes>MAX_APP_BYTES)throw new Error('单个应用最多 2 GiB，存储服务还可能有其他配额。');
  entry=safePath(entry||'index.html');if(!seen.has(entry)||!/[.]html?$/i.test(entry))throw new Error('请选择上传文件中的一个 HTML 入口。');
  return {name,slug,entry,files:list,totalBytes};
}
export function getBasePath() { return new URL('../',import.meta.url).pathname; }
export const DEFAULT_RUN_CONNECTION = Object.freeze({mode:'github',owner:'tycofficial',repo:'tycgame',branch:'tycgame-data'});
function runConnection(connection={}) {
  if(connection.mode==='local')return {mode:'local'};
  const result={mode:'github',owner:String(connection.owner||DEFAULT_RUN_CONNECTION.owner),repo:String(connection.repo||DEFAULT_RUN_CONNECTION.repo),branch:String(connection.branch||DEFAULT_RUN_CONNECTION.branch)};
  if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(result.owner)||!/^[A-Za-z0-9_.-]{1,100}$/.test(result.repo)||['.','..'].includes(result.repo)||!result.branch||result.branch.length>255||/[\x00-\x1f\x7f]/.test(result.branch))throw new Error('应用链接的仓库配置无效。');
  return result;
}
function encodeRouteData(value) {
  const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';
  for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decodeRouteData(value) {
  if(typeof value!=='string'||!value||value.length>4096||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('应用链接的路由配置无效。');
  const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,char=>char.charCodeAt(0))));
}
function runTail(slug,connection) {
  if(!validSlug(slug))throw new Error('应用访问后缀无效。');
  if(connection.mode==='local')return 'local/'+slug;
  const standard=connection.owner.toLowerCase()===DEFAULT_RUN_CONNECTION.owner&&connection.repo.toLowerCase()===DEFAULT_RUN_CONNECTION.repo&&connection.branch===DEFAULT_RUN_CONNECTION.branch;
  // A custom repository is self-describing in the path. This is deliberately
  // not a browser-local alias: another device can resolve it without a registry
  // or the manager tab. Only non-secret repository coordinates are encoded.
  return standard?slug:'~/'+encodeRouteData([connection.owner,connection.repo,connection.branch])+'/'+slug;
}
function rootPath(base) {const value=new URL(base,'https://route.invalid').pathname;return value.endsWith('/')?value:value+'/';}
export function makeRunURL(app,connection={mode:'local'},base=new URL('../',import.meta.url)) {
  return new URL(runTail(app.slug||app.id,runConnection(connection)),base).href;
}
export function parseRunRoute(input,base=getBasePath()) {
  const url=input instanceof URL?input:new URL(input,globalThis.location?.origin||'https://route.invalid');
  base=rootPath(base);if(!url.pathname.startsWith(base))throw new Error('这个应用链接不属于当前网站。');
  const pieces=url.pathname.slice(base.length).split('/').filter(Boolean).map(piece=>decodeURIComponent(piece));
  let slug,connection;
  if(pieces[0]==='local'&&pieces.length>1){
    if(pieces.length!==2)throw new Error('本地应用链接无效。');
    connection={mode:'local'};slug=pieces[1];
  }else if(pieces[0]==='~'){
    if(pieces.length!==3)throw new Error('应用链接无效。');
    const data=decodeRouteData(pieces[1]);if(!Array.isArray(data)||data.length!==3||data.some(value=>typeof value!=='string'))throw new Error('应用链接的仓库配置无效。');
    connection=runConnection({mode:'github',owner:data[0],repo:data[1],branch:data[2]});slug=pieces[2];
  }else{
    const legacy=pieces[0]==='a';if(pieces.length!==(legacy?2:1))throw new Error('应用链接无效。');slug=pieces[legacy?1:0];
    connection=runConnection(url.searchParams.get('mode')==='local'?{mode:'local'}:{mode:'github',owner:url.searchParams.get('owner')||undefined,repo:url.searchParams.get('repo')||undefined,branch:url.searchParams.get('branch')||undefined});
  }
  return {slug,connection,shortPath:base+runTail(slug,connection)};
}
function runDescriptor(route,base=getBasePath()) {
  if(!route||typeof route!=='object')throw new Error('应用运行路由无效。');
  const connection=runConnection(route.connection);
  const result={slug:route.slug,connection,shortPath:rootPath(base)+runTail(route.slug,connection)};
  if(route.entry!==undefined)result.entry=safePath(route.entry);
  if(typeof route.name==='string')result.name=route.name.trim().slice(0,80);
  return result;
}
export function encodeRunDescriptor(route,base=getBasePath()) {return encodeRouteData(runDescriptor(route,base));}
export function decodeRunDescriptor(value,base=getBasePath()) {return runDescriptor(decodeRouteData(value),base);}
export function openLocalDB() {
  return new Promise((resolve,reject)=>{const request=indexedDB.open(LOCAL_DB_NAME,LOCAL_DB_VERSION);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('apps'))db.createObjectStore('apps',{keyPath:'id'});if(!db.objectStoreNames.contains('chunks')){const store=db.createObjectStore('chunks',{keyPath:'id'});store.createIndex('appId','appId');}};request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});
}
export function requestResult(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
export function transactionDone(transaction) { return new Promise((resolve,reject)=>{transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error||new Error('本地保存事务已取消'));}); }
