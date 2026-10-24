// Cloudflare Worker. All durable state lives in the Site's R2 bucket.
export const PART_SIZE = 8 * 1024 * 1024;
export const MAX_APP_BYTES = 2 * 1024 ** 3;
export const MAX_FILES = 2000;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const sandbox = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; frame-ancestors 'self'; object-src 'none'";
const mime = { html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',json:'application/json',wasm:'application/wasm',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',ico:'image/x-icon',avif:'image/avif',mp3:'audio/mpeg',ogg:'audio/ogg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',txt:'text/plain; charset=utf-8',xml:'application/xml',pdf:'application/pdf',map:'application/json',webmanifest:'application/manifest+json' };
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:JSON_HEADERS});
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const now = () => new Date().toISOString();
function cleanPath(path) {
  if(typeof path!=='string'||!path||path.length>1024||path.startsWith('/')||/[\\\x00-\x1f\x7f?#]/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..')) fail(400,'文件路径无效，请保留相对目录结构');
  return path.normalize('NFC');
}
function validSlug(value) { return typeof value==='string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(value) && !value.endsWith('-'); }
async function ownerKey(userId) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(userId)))].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32); }
const appKey = (owner,id) => `accounts/${owner}/apps/${id}.json`;
const dataPrefix = (owner,id) => `accounts/${owner}/data/${id}/`;
const objectKey = (owner,id,index) => dataPrefix(owner,id)+`files/${index}`;
const transferKey = (owner,id,index) => dataPrefix(owner,id)+`transfers/${index}.json`;
const partPrefix = (owner,id,index) => dataPrefix(owner,id)+`parts/${index}/`;
function summary(app) { const {files,...rest}=app; return rest; }
async function saveApp(bucket,owner,app,etag) {
  const result=await bucket.put(appKey(owner,app.id),JSON.stringify(app),{httpMetadata:{contentType:'application/json'},customMetadata:{summary:JSON.stringify(summary(app))},...(etag?{onlyIf:{etagMatches:etag}}:{})});
  if(!result) fail(409,'应用状态已变化，请刷新后重试');
  return result;
}
async function loadApp(bucket,owner,id,allowDeleting=false) {
  if(!validSlug(id)) fail(404,'找不到这个应用');
  const obj=await bucket.get(appKey(owner,id));
  if(!obj) fail(404,'找不到这个应用');
  const app=await obj.json();
  if(app.status==='deleting'&&!allowDeleting) fail(409,'应用正在删除，请稍后重试');
  return {app,etag:obj.etag};
}
async function allObjects(bucket,prefix,include) {
  const objects=[];let cursor;
  do {const page=await bucket.list({prefix,limit:1000,...(cursor?{cursor}:{}),...(include?{include}: {})}); objects.push(...page.objects);cursor=page.truncated?page.cursor:undefined;}while(cursor);
  return objects;
}
async function catalog(bucket,owner) {
  const objects=await allObjects(bucket,`accounts/${owner}/apps/`,['customMetadata']);
  const apps=[];
  for(const object of objects) {
    if(object.customMetadata?.summary) {try{apps.push(JSON.parse(object.customMetadata.summary));}catch{}}
    else {const full=await bucket.get(object.key);if(full) apps.push(summary(await full.json()));}
  }
  return apps.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
async function readJSON(request,max=1024*1024) {
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>max) fail(413,'请求内容过大');
  const reader=request.body?.getReader();const chunks=[];let size=0;
  if(!reader) fail(400,'缺少请求内容');
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();fail(413,'请求内容过大');}chunks.push(value);}
  const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(buffer));}catch{fail(400,'请求格式无效');}
}
async function readBytes(request,expected) {
  if(!Number.isSafeInteger(expected)||expected<0||expected>PART_SIZE) fail(400,'分块大小无效');
  const declared=request.headers.get('content-length');
  if(declared!==null&&Number(declared)!==expected) fail(400,'文件大小与上传清单不符');
  const reader=request.body?.getReader();if(!reader){if(expected===0)return new Uint8Array();fail(400,'缺少文件数据');}
  const buffer=new Uint8Array(expected);let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;if(size+value.byteLength>expected){await reader.cancel();fail(413,'分块超出声明大小');}buffer.set(value,size);size+=value.byteLength;}
  if(size!==expected) fail(400,'文件数据不完整');
  return buffer;
}
async function transfer(bucket,owner,id,index) {
  const object=await bucket.get(transferKey(owner,id,index));return object?await object.json():null;
}
async function parts(bucket,owner,id,index) {
  const listed=await allObjects(bucket,partPrefix(owner,id,index));
  const results=[];
  // At most 256 parts per 2 GiB file. Bound concurrent subrequests.
  for(let i=0;i<listed.length;i+=16){const values=await Promise.all(listed.slice(i,i+16).map(async o=>{const p=await bucket.get(o.key);return p?await p.json():null;}));results.push(...values.filter(Boolean));}
  return results.sort((a,b)=>a.partNumber-b.partNumber);
}
function fileInfo(app,index) {
  if(!/^\d+$/.test(index)||!app.files[Number(index)]) fail(404,'找不到这个文件');
  return app.files[Number(index)];
}
function editable(app) { if(app.status!=='uploading') fail(409,'已经发布的文件不可修改，请新建应用'); }
async function assertActive(bucket,owner,app,cleanup,allowReady=false) {
  const object=await bucket.get(appKey(owner,app.id));
  const current=object?await object.json():null;
  if(!current||current.revision!==app.revision||(current.status!=='uploading'&&!(allowReady&&current.status==='ready'))){
    if(cleanup)await cleanup();
    fail(409,'上传已取消或应用状态已变化');
  }
}
async function removeApp(bucket,owner,app,etag) {
  app.status='deleting';await saveApp(bucket,owner,app,etag);
  const dataId=app.id+'/'+app.revision;
  const state=await allObjects(bucket,dataPrefix(owner,dataId)+'transfers/');
  for(const object of state){try{const o=await bucket.get(object.key);if(o){const t=await o.json();await bucket.resumeMultipartUpload(objectKey(owner,dataId,t.index),t.uploadId).abort();}}catch{}}
  const objects=await allObjects(bucket,dataPrefix(owner,dataId));
  for(let i=0;i<objects.length;i+=100) await bucket.delete(objects.slice(i,i+100).map(o=>o.key));
  await bucket.delete(appKey(owner,app.id));
}
export function parseRange(value,size) {
  if(!value)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!match||(!match[1]&&!match[2])||size===0)fail(416,'请求的范围无效');
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)fail(416,'请求的范围无效');start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)fail(416,'请求的范围无效');
  end=Math.min(end,size-1);return {offset:start,length:end-start+1};
}
async function serveApp(request,bucket,owner,slug,path) {
  const {app}=await loadApp(bucket,owner,slug);
  if(app.status!=='ready')fail(409,'应用尚未上传完成，请回主页继续上传');
  let relative;try{relative=decodeURIComponent(path);}catch{fail(400,'路径编码无效');}
  if(!relative&&app.entry.includes('/'))return Response.redirect(new URL(request.url).origin+'/a/'+slug+'/'+app.entry.split('/').map(encodeURIComponent).join('/'),302);
  if(!relative||relative.endsWith('/'))relative+=relative? 'index.html':app.entry;
  cleanPath(relative);
  let index=app.files.findIndex(f=>f.path===relative);
  if(index<0)fail(404,'应用中没有这个文件，请使用相对路径构建应用');
  const file=app.files[index];const key=objectKey(owner,slug+'/'+app.revision,index);
  let range;
  try{range=parseRange(request.headers.get('range'),file.size);}catch(e){if(e.status===416)return new Response(null,{status:416,headers:{'content-range':`bytes */${file.size}`}});throw e;}
  const object=request.method==='HEAD'?await bucket.head(key):await bucket.get(key,range?{range}:{});
  if(!object)fail(404,'云端文件不存在');
  const contentType=mime[file.path.split('.').pop().toLowerCase()]||'application/octet-stream';
  const headers=new Headers({'content-type':contentType,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':sandbox,'referrer-policy':'no-referrer','accept-ranges':'bytes','content-length':String(range?range.length:file.size),'cross-origin-resource-policy':'cross-origin','vary':'Origin, Cookie'});
  if(object.httpEtag)headers.set('etag',object.httpEtag);
  if(request.headers.get('origin')==='null'){headers.set('access-control-allow-origin','null');headers.set('access-control-allow-credentials','true');}
  if(range)headers.set('content-range',`bytes ${range.offset}-${range.offset+range.length-1}/${file.size}`);
  let response=new Response(request.method==='HEAD'?null:object.body,{status:range?206:200,headers});
  // Preserve streaming: never buffer HTML. Include credentials on local module
  // requests from the opaque sandbox when hosted behind private Site sign-in.
  if(contentType.startsWith('text/html')&&!range&&request.method!=='HEAD'&&typeof HTMLRewriter!=='undefined'){
    response=new HTMLRewriter().on('script[type="module"]',{element(el){const src=el.getAttribute('src');if(!src||(!src.startsWith('http:')&&!src.startsWith('https:')&&!src.startsWith('//')))el.setAttribute('crossorigin','use-credentials');}}).on('link[rel="modulepreload"]',{element(el){el.setAttribute('crossorigin','use-credentials');}}).transform(response);
  }
  return response;
}
export async function handle(request,env,ctx={},page='<!doctype html><html lang="zh-CN"><title>HTML 发布器</title><h1>HTML 发布器</h1></html>') {
  try {
    const url=new URL(request.url);const pathname=url.pathname;
    if(pathname==='/favicon.ico')return new Response(null,{status:204});
    if(pathname==='/'&&['GET','HEAD'].includes(request.method))return new Response(request.method==='HEAD'?null:page,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",'referrer-policy':'same-origin'}});
    const userId=request.headers.get('oai-authenticated-user-id');
    if(!userId)fail(401,'请先登录，再访问你的云端应用');
    if(!env.BUCKET)fail(503,'云端文件存储尚未连接，请完成 R2 部署配置');
    const bucket=env.BUCKET;const owner=await ownerKey(userId);
    if(pathname.startsWith('/a/')) {
      if(request.method==='OPTIONS'&&request.headers.get('origin')==='null')return new Response(null,{status:204,headers:{'access-control-allow-origin':'null','access-control-allow-credentials':'true','access-control-allow-methods':'GET, HEAD','access-control-allow-headers':'Range','vary':'Origin'}});
      if(!['GET','HEAD'].includes(request.method))fail(405,'此路径只允许读取');
      const match=/^\/a\/([^/]+)(?:\/(.*))?$/.exec(pathname);if(!match)fail(404,'应用地址无效');
      if(match[2]===undefined)return Response.redirect(url.origin+'/a/'+encodeURIComponent(match[1])+'/',302);
      return await serveApp(request,bucket,owner,match[1],match[2]);
    }
    if(!pathname.startsWith('/api/')){
      const slug=pathname.slice(1).replace(/\/$/,'');
      if(['GET','HEAD'].includes(request.method)&&validSlug(slug))return Response.redirect(url.origin+'/a/'+slug+'/',302);
      fail(404,'页面不存在');
    }
    if(!['GET','HEAD'].includes(request.method)) {
      if(request.headers.get('x-publisher-request')!=='1'||request.headers.get('origin')!==url.origin)fail(403,'请求来源无效，请从发布器主页操作');
      const site=request.headers.get('sec-fetch-site');if(site&&site!=='same-origin'&&site!=='none')fail(403,'不允许跨站操作');
    }
    if(pathname==='/api/me'&&request.method==='GET'){
      const apps=await catalog(bucket,owner);
      return json({user:{email:request.headers.get('oai-authenticated-user-email')||'已登录账户'},apps,storage:{usedBytes:apps.filter(a=>a.status==='ready').reduce((s,a)=>s+a.totalBytes,0),pendingBytes:apps.filter(a=>a.status!=='ready').reduce((s,a)=>s+a.totalBytes,0)},limits:{maxAppBytes:MAX_APP_BYTES,partSize:PART_SIZE,maxFiles:MAX_FILES},hosting:{private:true,sandbox:true}});
    }
    if(pathname==='/api/apps'&&request.method==='GET')return json({apps:await catalog(bucket,owner)});
    if(pathname==='/api/apps'&&request.method==='POST'){
      const body=await readJSON(request,4*1024*1024);
      if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)fail(400,'应用名称需为 1–80 个字符');
      if(!Array.isArray(body.files)||!body.files.length||body.files.length>MAX_FILES)fail(400,`请选择 1–${MAX_FILES} 个文件`);
      const seen=new Set();let totalBytes=0;
      const files=body.files.map(f=>{const path=cleanPath(f.path);if(seen.has(path))fail(400,'文件路径重复');seen.add(path);if(!Number.isSafeInteger(f.size)||f.size<0)fail(400,'文件大小无效');totalBytes+=f.size;return {path,size:f.size,type:mime[path.split('.').pop().toLowerCase()]||'application/octet-stream',lastModified:Number(f.lastModified)||0};});
      if(totalBytes>MAX_APP_BYTES)fail(413,'单个应用最多 2 GiB，实际存储仍受云服务配额限制');
      const entry=cleanPath(body.entry||'index.html');if(!seen.has(entry)||!/[.]html?$/i.test(entry))fail(400,'请选择应用中的 HTML 入口文件');
      const slug=body.slug||'app-'+crypto.randomUUID().replaceAll('-','').slice(0,12);
      if(!validSlug(slug))fail(400,'后缀需为 3–64 位小写字母、数字或连字符');
      const app={id:slug,slug,revision:crypto.randomUUID(),name:body.name.trim(),status:'uploading',totalBytes,fileCount:files.length,entry,createdAt:now(),updatedAt:now(),type:files.length===1?'html':'app',files};
      const result=await bucket.put(appKey(owner,slug),JSON.stringify(app),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{summary:JSON.stringify(summary(app))}});
      if(!result)fail(409,'这个后缀已被你使用，请换一个');
      return json({app,partSize:PART_SIZE},201);
    }
    const match=/^\/api\/apps\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if(!match)fail(404,'接口不存在');
    const id=match[1];const tail=match[2]||'';const {app,etag}=await loadApp(bucket,owner,id,request.method==='DELETE');const dataId=id+'/'+app.revision;
    if(!tail&&request.method==='DELETE'){await removeApp(bucket,owner,app,etag);return json({ok:true});}
    if(!tail&&request.method==='PATCH'){const body=await readJSON(request);if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>80)fail(400,'应用名称需为 1–80 个字符');app.name=body.name.trim();app.updatedAt=now();await saveApp(bucket,owner,app,etag);return json({app});}
    if(!tail&&request.method==='GET'){
      const objects=await allObjects(bucket,dataPrefix(owner,dataId)+'files/');const uploaded=new Map(objects.map(o=>[Number(o.key.split('/').pop()),o.size]));
      const states=await allObjects(bucket,dataPrefix(owner,dataId)+'transfers/');const transfers={};
      for(const o of states){const state=await bucket.get(o.key);if(state){const t=await state.json();transfers[t.index]={...t,parts:await parts(bucket,owner,dataId,t.index)};}}
      return json({app,files:app.files.map((f,i)=>({...f,uploaded:uploaded.has(i)&&uploaded.get(i)===f.size})),transfers});
    }
    if(tail==='publish'&&request.method==='POST'){
      if(app.status==='ready')return json({app});editable(app);
      const objects=await allObjects(bucket,dataPrefix(owner,dataId)+'files/');const uploaded=new Map(objects.map(o=>[Number(o.key.split('/').pop()),o.size]));
      if(app.files.some((f,i)=>!uploaded.has(i)||uploaded.get(i)!==f.size))fail(409,'文件还没有全部上传完成');
      app.status='ready';app.updatedAt=now();await saveApp(bucket,owner,app,etag);
      return json({app});
    }
    const fm=/^files\/(\d+)\/(init|whole|parts\/(\d+)|complete)$/.exec(tail);
    if(!fm)fail(404,'接口不存在');editable(app);const index=Number(fm[1]);const file=fileInfo(app,fm[1]);const key=objectKey(owner,dataId,index);
    if(fm[2]==='whole'&&request.method==='PUT'){
      if(file.size>PART_SIZE)fail(400,'大文件请分块上传');const bytes=await readBytes(request,file.size);
      const stored=await bucket.put(key,bytes,{httpMetadata:{contentType:file.type},onlyIf:{etagDoesNotMatch:'*'}});
      if(!stored){const existing=await bucket.head(key);if(existing?.size!==file.size)fail(409,'云端文件状态不一致');}
      await assertActive(bucket,owner,app,stored?()=>bucket.delete(key):null,true);return json({ok:true});
    }
    if(fm[2]==='init'&&request.method==='POST'){
      if(file.size<=PART_SIZE)fail(400,'小文件请直接上传');
      let state=await transfer(bucket,owner,dataId,index);
      if(!state){const upload=await bucket.createMultipartUpload(key,{httpMetadata:{contentType:file.type}});state={index,uploadId:upload.uploadId,createdAt:now()};let saved;try{saved=await bucket.put(transferKey(owner,dataId,index),JSON.stringify(state),{onlyIf:{etagDoesNotMatch:'*'}});}catch(error){await upload.abort();throw error;}if(!saved){await upload.abort();state=await transfer(bucket,owner,dataId,index);}}
      await assertActive(bucket,owner,app,async()=>{try{await bucket.resumeMultipartUpload(key,state.uploadId).abort();}catch{}await bucket.delete(transferKey(owner,dataId,index));});
      return json({...state,parts:await parts(bucket,owner,dataId,index)});
    }
    if(fm[3]&&request.method==='PUT'){
      const number=Number(fm[3]);const count=Math.ceil(file.size/PART_SIZE);
      if(file.size<=PART_SIZE||number<1||number>count)fail(400,'分块编号无效');
      const state=await transfer(bucket,owner,dataId,index);if(!state)fail(409,'请先初始化分块上传');
      const expected=Math.min(PART_SIZE,file.size-(number-1)*PART_SIZE);const bytes=await readBytes(request,expected);
      const upload=bucket.resumeMultipartUpload(key,state.uploadId);const uploaded=await upload.uploadPart(number,bytes);
      const recordKey=partPrefix(owner,dataId,index)+String(number).padStart(5,'0')+'.json';
      const part={partNumber:number,etag:uploaded.etag,size:expected};await bucket.put(recordKey,JSON.stringify(part));
      await assertActive(bucket,owner,app,async()=>{try{await upload.abort();}catch{}await bucket.delete(recordKey);});
      return json(part);
    }
    if(fm[2]==='complete'&&request.method==='POST'){
      const existing=await bucket.head(key);if(existing?.size===file.size)return json({ok:true});
      const state=await transfer(bucket,owner,dataId,index);if(!state)fail(409,'找不到分块上传会话');
      const uploaded=await parts(bucket,owner,dataId,index);const count=Math.ceil(file.size/PART_SIZE);
      if(uploaded.length!==count||uploaded.some((p,i)=>p.partNumber!==i+1||p.size!==Math.min(PART_SIZE,file.size-i*PART_SIZE)))fail(409,'分块不完整，请继续上传');
      await bucket.resumeMultipartUpload(key,state.uploadId).complete(uploaded.map(({partNumber,etag})=>({partNumber,etag})));
      const complete=await bucket.head(key);if(!complete||complete.size!==file.size)fail(409,'文件合并校验失败');await assertActive(bucket,owner,app,()=>bucket.delete(key),true);return json({ok:true});
    }
    fail(405,'请求方法不支持');
  }catch(error){
    // Never expose object keys, identity headers, or provider credentials.
    return json({error:error.status?error.message:'云端请求失败，请稍后重试；若持续失败请检查存储配额'},error.status||500);
  }
}
