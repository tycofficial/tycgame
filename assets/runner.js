/* Credentials are passed directly from the manager to the Service Worker.
 * The runtime window and uploaded document receive only a random read-only
 * session capability. This module never persists credentials or sends them to
 * the runtime window, an application, or a BroadcastChannel.
 */
import {makeRunURL,encodeRunDescriptor,decodeRunDescriptor,parseRunRoute,DEFAULT_RUN_CONNECTION} from './shared.js?v=3';
const siteRoot = new URL('../',import.meta.url);
const CAP_PATTERN = /^[a-f0-9]{64}$/;
const randomSession = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
const validPath = path => typeof path==='string' && path && !path.startsWith('/') && !/[\\\x00-\x1f\x7f?#]/.test(path) && path.split('/').every(piece=>piece && piece!=='.' && piece!=='..');
const encodedPath = path => path.split('/').map(encodeURIComponent).join('/');
const channelName = session => 'tycgame-runtime-'+session;
const managerSessions = new Map();
let runtimeEpoch = 0;

async function runtimeWorker() {
  if (!isSecureContext || !('serviceWorker' in navigator)) throw new Error('运行应用需要 HTTPS 与支持 Service Worker 的浏览器。请使用 GitHub Pages 地址打开。');
  const registration=await navigator.serviceWorker.register(new URL('sw.js?v=3',siteRoot),{scope:siteRoot.pathname,updateViaCache:'none'});
  const worker=registration.installing || registration.waiting || registration.active;
  if (!worker) throw new Error('运行环境未能启动，请刷新后重试。');
  if (worker.state!=='activated') await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('运行环境启动超时，请刷新后重试。')),15000);
    const changed=()=>{if(worker.state==='activated'){clearTimeout(timer);resolve();}else if(worker.state==='redundant'){clearTimeout(timer);reject(new Error('运行环境更新未完成，请刷新后重试。'));}};
    worker.addEventListener('statechange',changed);changed();
  });
  return registration.active || worker;
}

function workerMessage(worker,message) {
  return new Promise((resolve,reject)=>{
    const channel=new MessageChannel();
    const timer=setTimeout(()=>{channel.port1.close();reject(new Error('运行环境响应超时，请重新打开应用。'));},12000);
    channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.ok?resolve(event.data):reject(new Error(event.data?.error || '无法配置运行环境'));};
    worker.postMessage(message,[channel.port2]);
  });
}

const configure = (worker,session,app,connection) => workerMessage(worker,{type:'TYC_CONFIGURE',session,app,connection});
const exists = async(worker,session)=>(await workerMessage(worker,{type:'TYC_STATUS',session})).exists;

/** Disconnect the current manager's runtime grants as well as its saved token.
 * No credential is returned, and unrelated tabs' random capabilities are never
 * listed or inspected. Call when disconnecting or switching GitHub accounts.
 */
export async function clearRuntimeSessions() {
  runtimeEpoch++;
  const records=[...managerSessions.entries()];
  for(const [session,record] of records){record.close();managerSessions.delete(session);}
  let worker;
  try{worker=(await navigator.serviceWorker.getRegistration(siteRoot.href))?.active;}catch{}
  if(worker)await Promise.all(records.map(([session])=>workerMessage(worker,{type:'TYC_CLOSE',session}).catch(()=>{})));
}

/** Called directly by a user click, with a complete ready application manifest.
 * connection = { mode:'github'|'local', owner,repo,branch,token }.
 * Opens a separate window synchronously to avoid popup blockers.
 */
export async function launchApp(app,connection={}) {
  const launchEpoch=runtimeEpoch;
  const opened=window.open('about:blank','_blank');
  if(!opened)throw new Error('浏览器拦截了运行窗口，请允许本站弹出窗口后重试。');
  opened.opener=null;
  try {
    opened.document.title='正在打开应用 · TycGame';
    opened.document.body.textContent='正在准备 TycGame 运行环境…';
    app=await Promise.resolve(app);
    if(!app || app.status!=='ready' || !Array.isArray(app.files) || !validPath(app.entry))throw new Error('请先完成应用上传，再打开运行。');
    const session=randomSession();
    const source=connection.config || connection;
    const config={mode:connection.mode || source.mode || 'github',owner:source.owner,repo:source.repo,branch:source.branch || 'tycgame-data',token:connection.token || source.token || '',private:connection.private ?? source.private};
    // A private token is held only in this manager's closure and the SW's
    // volatile session. Incoming reconnect requests cannot alter the manifest,
    // repository, session, token, or approved blob list captured here.
    const manifest=structuredClone(app);
    const worker=await runtimeWorker();
    await configure(worker,session,manifest,config);
    if(launchEpoch!==runtimeEpoch){config.token='';await workerMessage(worker,{type:'TYC_CLOSE',session});throw new Error('连接已经断开，请重新连接后打开应用。');}
    const channel=new BroadcastChannel(channelName(session));
    let reconnecting=false,lastReconnect=0,active=true;
    const close=()=>{active=false;config.token='';channel.close();};
    managerSessions.set(session,{close});
    channel.onmessage=async event=>{
      if(!active || event.data?.type!=='reconnect' || reconnecting || Date.now()-lastReconnect<1500)return;
      reconnecting=true;lastReconnect=Date.now();
      try{const current=await runtimeWorker();if(active){await configure(current,session,manifest,config);if(active)channel.postMessage({type:'connected'});else await workerMessage(current,{type:'TYC_CLOSE',session});}}catch{if(active)channel.postMessage({type:'unavailable'});}finally{reconnecting=false;}
    };
    setTimeout(()=>{close();managerSessions.delete(session);},4*60*60*1000);
    const shortURL=makeRunURL(app,config),route={slug:app.slug || app.id,connection:config,shortPath:new URL(shortURL).pathname,entry:app.entry,name:app.name || '应用'};
    const url=new URL('run.html',siteRoot);url.hash=new URLSearchParams({route:encodeRunDescriptor(route),session}).toString();
    opened.location.replace(url.href);
    return shortURL;
  } catch(error) {
    try{opened.document.body.textContent=error.message || '应用打开失败，请返回主页重试。';}catch{}
    throw error;
  }
}

async function publicManifest(owner,repo,slug,branch='tycgame-data') {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(owner || '') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo || '') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(slug || ''))throw new Error('应用链接缺少有效的 GitHub 仓库或访问后缀。');
  const prefix=`${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const path=`apps/${encodeURIComponent(slug)}/manifest.json`;
  if(typeof branch!=='string' || !branch || branch.length>255 || /[\x00-\x1f\x7f]/.test(branch))throw new Error('应用链接的数据分支无效。');
  const key=new URL(`__tyc_manifest/${prefix}/${encodeURIComponent(branch)}/${encodeURIComponent(slug)}`,siteRoot).href;
  let cache,cached;try{if(typeof caches!=='undefined'){cache=await caches.open('tycgame-public-manifests-v1');cached=await cache.match(key);if(cached && Date.now()-Number(cached.headers.get('x-tyc-saved'))<60000)return await cached.json();}}catch{}
  let app,lastError;
  for(const [url,headers] of [[`https://raw.githubusercontent.com/${prefix}/${encodeURIComponent(branch)}/${path}`,{}],[`https://api.github.com/repos/${prefix}/contents/${path}?ref=${encodeURIComponent(branch)}`,{Accept:'application/vnd.github.raw+json'}]]){
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
    try{const response=await fetch(url,{cache:'no-cache',credentials:'omit',referrerPolicy:'no-referrer',headers,signal:abort.signal});if(!response.ok)throw new Error(`GitHub 返回 ${response.status}`);app=await response.json();break;}catch(error){lastError=error;}finally{clearTimeout(timer);}
  }
  if(!app){if(cached)return cached.json();throw new Error('此应用无法匿名读取或网络连续 15 秒无响应。私有仓库请回主页连接令牌；公开仓库请检查网络或稍后重试。'+(lastError?.message || ''));}
  if(app.encoding==='base64' && app.content){const binary=atob(app.content.replace(/\s/g,''));app=JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));}
  if(app.status!=='ready')throw new Error('应用尚未发布完成，请返回主页继续上传。');
  if(cache)cache.put(key,new Response(JSON.stringify(app),{headers:{'Content-Type':'application/json','x-tyc-saved':String(Date.now())}})).catch(()=>{});
  return app;
}

async function bootRunner() {
  const byId=id=>document.getElementById(id);
  document.querySelectorAll('a[href="./"]').forEach(anchor=>{anchor.href=siteRoot.href;});
  const fail=message=>{byId('spinner').classList.add('hidden');byId('statusTitle').textContent='应用还需要一次连接';byId('statusText').textContent=message;byId('homeButton').classList.remove('hidden');byId('retry').classList.remove('hidden');};
  const url=new URL(location.href),fragment=new URLSearchParams(url.hash.slice(1));
  let route;
  try{route=fragment.has('route')?decodeRunDescriptor(fragment.get('route')):history.state?.tycgameRoute || (url.pathname.endsWith('/run.html')?{slug:url.searchParams.get('app'),connection:{mode:url.searchParams.get('mode')==='local'?'local':'github',owner:url.searchParams.get('owner') || DEFAULT_RUN_CONNECTION.owner,repo:url.searchParams.get('repo') || DEFAULT_RUN_CONNECTION.repo,branch:url.searchParams.get('branch') || DEFAULT_RUN_CONNECTION.branch},entry:url.searchParams.get('entry') || undefined,name:url.searchParams.get('name') || undefined}:parseRunRoute(url));route=decodeRunDescriptor(encodeRunDescriptor(route));}catch(error){fail(error.message);return;}
  const {owner,repo,branch}=route.connection,slug=route.slug,local=route.connection.mode==='local';
  let session=fragment.get('session') || history.state?.tycgameSession,entry=route.entry;
  byId('appLabel').textContent=route.name || slug || '云端应用运行器';
  document.title=(route.name || slug || '运行应用')+' · TycGame';
  const saveRoute=()=>history.replaceState({tycgameSession:session,tycgameRoute:{...route,entry}},'',route.shortPath);
  saveRoute();
  byId('retry').onclick=()=>location.reload();
  try {
    const worker=await runtimeWorker();
    let channel;
    async function reconnect() {
      if(!channel)channel=new BroadcastChannel(channelName(session));
      return new Promise(resolve=>{
        const timer=setTimeout(()=>{channel.removeEventListener('message',connected);resolve(false);},6000);
        const connected=event=>{if(['connected','unavailable'].includes(event.data?.type)){clearTimeout(timer);channel.removeEventListener('message',connected);resolve(event.data.type==='connected');}};
        channel.addEventListener('message',connected);channel.postMessage({type:'reconnect'});
      });
    }
    if(session && !CAP_PATTERN.test(session))throw new Error('运行会话无效，请从应用库重新打开。');
    let connected=session?await exists(worker,session):false;
    if(session && !connected)connected=await reconnect();
    if(!connected){
      const app=local ? await new (await import('./local-store.js?v=3')).LocalStore().getApp(slug) : await publicManifest(owner,repo,slug,branch);
      entry=app.entry;session=randomSession();
      await configure(worker,session,app,{mode:local?'local':'github',owner,repo,branch});
      route.name=app.name;route.entry=entry;saveRoute();
    }
    if(!validPath(entry))throw new Error('应用入口无效，请从应用库重新打开。');
    const frame=byId('appFrame');
    const status=byId('status');status.classList.add('hud');
    frame.classList.remove('hidden');
    byId('statusTitle').textContent='正在读取应用文件';
    byId('statusText').textContent='应用会边读取边显示。外部脚本或字体较慢时，不会遮住已经显示的内容。';
    let lastProgress=Date.now(),loadFailed=false,transferReady=false;
    navigator.serviceWorker.addEventListener('message',event=>{
      const progress=event.data;if(progress?.type!=='TYC_PROGRESS' || progress.session!==session || (progress.path && progress.path!==entry))return;
      lastProgress=Date.now();
      const loaded=Number(progress.loaded)||0,total=Number(progress.total)||0,percent=total?Math.min(100,loaded/total*100):0;
      byId('runProgress').value=percent;byId('runStats').textContent=`${(loaded/1024**2).toFixed(1)} / ${(total/1024**2).toFixed(1)} MB · ${Math.round(percent)}%`;
      if(progress.state==='error'){loadFailed=true;byId('statusTitle').textContent='应用文件读取中断';byId('statusText').textContent=progress.error || '请重新加载，已缓存的公开分块会直接复用。';byId('spinner').classList.add('hidden');byId('retry').classList.remove('hidden');}
      else if(progress.state==='ready'){transferReady=true;byId('statusTitle').textContent='HTML 文件已读取完成';byId('statusText').textContent='文件传输完成；浏览器仍可能在解析较大的 HTML 或等待外部资源。';byId('spinner').classList.add('hidden');}
    });
    const watch=()=>workerMessage(navigator.serviceWorker.controller || worker,{type:'TYC_WATCH',session}).catch(()=>{});
    await watch();
    frame.onload=()=>{if(!loadFailed){transferReady=true;byId('statusTitle').textContent='应用已显示';}byId('spinner').classList.add('hidden');byId('retry').classList.remove('hidden');};
    frame.src=new URL('__tyc_runtime/'+session+'/'+encodedPath(entry),siteRoot).href;
    // Message traffic contains only a random session capability and status.
    // The manager may reconnect this same immutable manifest after a browser
    // terminates an idle SW, without giving its token to the runtime window.
    setInterval(async()=>{try{const current=(await navigator.serviceWorker.getRegistration(siteRoot.href))?.active || await runtimeWorker();if(!await exists(current,session)){let restored=local?false:await reconnect();if(!restored){const app=local?await new(await import('./local-store.js?v=3')).LocalStore().getApp(slug):await publicManifest(owner,repo,slug,branch);await configure(current,session,app,{mode:local?'local':'github',owner,repo,branch});restored=true;}if(restored){transferReady=false;await watch();frame.src=new URL('__tyc_runtime/'+session+'/'+encodedPath(entry),siteRoot).href;}}else await watch();if(!transferReady && !loadFailed && Date.now()-lastProgress>20000){byId('statusText').textContent='暂未收到新的文件进度。页面保持可见；如果应用依赖外部 CDN，可能仍在等待那些资源。';byId('retry').classList.remove('hidden');}}catch(error){fail(error.message || '运行连接已释放，请返回主页重新打开。');}},15000);
  } catch(error) {fail(error.message || '暂时无法打开此应用。');}
}

if(document.getElementById('appFrame'))bootRunner();
