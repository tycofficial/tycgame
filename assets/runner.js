/* Credentials are passed directly from the manager to the Service Worker.
 * The runtime window and uploaded document receive only a random read-only
 * session capability. This module never persists credentials or sends them to
 * the runtime window, an application, or a BroadcastChannel.
 */
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
  const registration=await navigator.serviceWorker.register(new URL('sw.js',siteRoot),{scope:siteRoot.pathname,updateViaCache:'none'});
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
    const config={mode:connection.mode || source.mode || 'github',owner:source.owner,repo:source.repo,branch:source.branch || 'tycgame-data',token:connection.token || source.token || ''};
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
    const url=new URL('run.html',siteRoot);
    if(config.owner)url.searchParams.set('owner',config.owner);
    if(config.repo)url.searchParams.set('repo',config.repo);
    if(config.mode!=='local')url.searchParams.set('branch',config.branch);
    url.searchParams.set('app',app.slug || app.id);
    url.searchParams.set('entry',app.entry);
    url.searchParams.set('name',app.name || '应用');
    if(config.mode==='local')url.searchParams.set('mode','local');
    url.hash='session='+session;
    opened.location.replace(url.href);
    return url.href;
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
  let response=await fetch(`https://raw.githubusercontent.com/${prefix}/${encodeURIComponent(branch)}/${path}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
  if(!response.ok)response=await fetch(`https://api.github.com/repos/${prefix}/contents/${path}?ref=${encodeURIComponent(branch)}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{Accept:'application/vnd.github.raw+json'}});
  if(!response.ok)throw new Error('此应用暂时无法匿名访问。私有仓库请返回主页连接 GitHub，再从应用卡片打开；公开仓库也可能受到 GitHub 请求配额限制。');
  let app=await response.json();
  if(app.encoding==='base64' && app.content){const binary=atob(app.content.replace(/\s/g,''));app=JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));}
  if(app.status!=='ready')throw new Error('应用尚未发布完成，请返回主页继续上传。');
  return app;
}

async function bootRunner() {
  const byId=id=>document.getElementById(id);
  const fail=message=>{byId('spinner').classList.add('hidden');byId('statusTitle').textContent='应用还需要一次连接';byId('statusText').textContent=message;byId('homeButton').classList.remove('hidden');byId('retry').classList.remove('hidden');};
  const url=new URL(location.href);
  const owner=url.searchParams.get('owner'),repo=url.searchParams.get('repo'),slug=url.searchParams.get('app');
  const branch=url.searchParams.get('branch') || 'tycgame-data';
  let session=new URLSearchParams(url.hash.slice(1)).get('session') || history.state?.tycgameSession;
  const local=url.searchParams.get('mode')==='local';
  let entry=url.searchParams.get('entry');
  byId('appLabel').textContent=url.searchParams.get('name') || slug || '云端应用运行器';
  document.title=(url.searchParams.get('name') || slug || '运行应用')+' · TycGame';
  url.hash='';history.replaceState(session?{tycgameSession:session}:null,'',url);
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
      const app=local ? await new (await import('./local-store.js')).LocalStore().getApp(slug) : await publicManifest(owner,repo,slug,branch);
      entry=app.entry;session=randomSession();
      await configure(worker,session,app,{mode:local?'local':'github',owner,repo,branch});
      history.replaceState({tycgameSession:session},'',url);
    }
    if(!validPath(entry))throw new Error('应用入口无效，请从应用库重新打开。');
    const frame=byId('appFrame');
    frame.onload=()=>{byId('status').classList.add('hidden');frame.classList.remove('hidden');};
    frame.src=new URL('__tyc_runtime/'+session+'/'+encodedPath(entry),siteRoot).href;
    // Message traffic contains only a random session capability and status.
    // The manager may reconnect this same immutable manifest after a browser
    // terminates an idle SW, without giving its token to the runtime window.
    setInterval(async()=>{try{const current=await runtimeWorker();if(!await exists(current,session)){if(!await reconnect()){fail('浏览器已释放运行连接。请返回主页重新打开应用；私有仓库的令牌不会长期保存在浏览器。');byId('status').classList.remove('hidden');frame.classList.add('hidden');}}}catch{}},15000);
  } catch(error) {fail(error.message || '暂时无法打开此应用。');}
}

if(document.getElementById('appFrame'))bootRunner();
