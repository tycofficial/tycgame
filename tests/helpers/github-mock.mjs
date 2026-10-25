import { createHash } from 'node:crypto';
import { GitHubStore } from '../../assets/github-store.js';

export const TOKEN = 'qa-only-not-a-real-access-token';
const hash = value => createHash('sha1').update(value).digest('hex');
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const json = (body, status=200) => new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json'}});

export class GitHubMock {
  constructor({privateRepo=false}={}) {
    this.privateRepo=privateRepo;this.refs=new Map();this.blobs=new Map();this.trees=new Map();this.commits=new Map();this.calls=[];this.count=0;this.conflictOnce=null;
    const index=this.blob(Buffer.from('<!doctype html><title>Original source</title>'));
    const tree=this.tree(new Map([['index.html',index]]));this.main=this.commit(tree,[],'Initial source');this.refs.set('main',this.main);
  }
  blob(bytes){bytes=Buffer.from(bytes);const sha=blobHash(bytes);this.blobs.set(sha,bytes);return sha;}
  tree(map){const sha=hash(JSON.stringify([...map]));this.trees.set(sha,new Map(map));return sha;}
  commit(tree,parents,message){const sha=hash(JSON.stringify({tree,parents,message,n:this.count++}));this.commits.set(sha,{sha,tree:{sha:tree},parents:parents.map(sha=>({sha}))});return sha;}
  head(branch='tycgame-data'){return this.refs.get(branch);}
  at(path,ref='tycgame-data'){const sha=this.refs.get(ref)||ref;const c=this.commits.get(sha);const b=this.trees.get(c?.tree.sha)?.get(path);return b?this.blobs.get(b):null;}
  catalog(){const bytes=this.at('catalog.json');return bytes?JSON.parse(bytes):null;}
  manifest(id){const bytes=this.at(`apps/${id}/manifest.json`);return bytes?JSON.parse(bytes):null;}
  injectForeignApp(id='another-device'){
    const head=this.head();const current=this.commits.get(head);const map=new Map(this.trees.get(current.tree.sha));const catalog=this.catalog();
    const app={id,slug:id,revision:'foreign-revision',name:'Other device',type:'html',status:'ready',storage:'github',entry:'index.html',totalBytes:0,fileCount:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),files:[{path:'index.html',size:0,type:'text/html',chunks:[]}]};
    const {files,...summary}=app;catalog.apps.push({...summary,_objects:[]});map.set('catalog.json',this.blob(Buffer.from(JSON.stringify(catalog))));map.set(`apps/${id}/manifest.json`,this.blob(Buffer.from(JSON.stringify(app))));this.refs.set('tycgame-data',this.commit(this.tree(map),[head],'Other device update'));
  }
  fetch = async (url, options={}) => {
    if(options.signal?.aborted)throw new DOMException('aborted','AbortError');
    const u=new URL(url);const method=options.method||'GET';const body=options.body?JSON.parse(options.body):null;const headers=new Headers(options.headers);this.calls.push({url:String(url),method,body,headers:Object.fromEntries(headers)});
    const authorized=headers.get('authorization')===`Bearer ${TOKEN}`;
    if(u.hostname!=='api.github.com')return json({message:'Unexpected destination'},500);
    if(u.pathname==='/user')return authorized?json({login:'qa-user',name:'QA User',avatar_url:''}):json({message:'Bad credentials'},401);
    if((method!=='GET'||this.privateRepo)&&!authorized)return json({message:'Bad credentials'},401);
    const prefix='/repos/qa-user/qa-repo';if(!u.pathname.startsWith(prefix))return json({message:'Not found'},404);const path=decodeURIComponent(u.pathname.slice(prefix.length));
    if(path===''&&method==='GET')return json({full_name:'qa-user/qa-repo',private:this.privateRepo,default_branch:'main',permissions:{push:true}});
    let m;
    if(method==='GET'&&(m=/^\/git\/ref\/heads\/(.+)$/.exec(path))){const sha=this.refs.get(m[1]);return sha?json({ref:`refs/heads/${m[1]}`,object:{sha}}):json({message:'Not Found'},404);}
    if(method==='GET'&&(m=/^\/git\/commits\/([a-f0-9]+)$/.exec(path))){const c=this.commits.get(m[1]);return c?json(c):json({message:'Not Found'},404);}
    if(method==='GET'&&(m=/^\/contents\/(.+)$/.exec(path))){const bytes=this.at(m[1],u.searchParams.get('ref'));return bytes?json({encoding:'base64',content:bytes.toString('base64'),sha:blobHash(bytes),size:bytes.length}):json({message:'Not Found'},404);}
    if(method==='GET'&&(m=/^\/git\/blobs\/([a-f0-9]+)$/.exec(path))){const bytes=this.blobs.get(m[1]);if(!bytes)return json({message:'Not Found'},404);if(headers.get('accept')?.includes('raw'))return new Response(bytes,{headers:{'content-type':'application/octet-stream'}});return json({encoding:'base64',content:bytes.toString('base64'),sha:m[1],size:bytes.length});}
    if(method==='POST'&&path==='/git/blobs'){const bytes=Buffer.from(body.content,body.encoding==='base64'?'base64':'utf8');return json({sha:this.blob(bytes)},201);}
    if(method==='POST'&&path==='/git/trees'){
      if(body.base_tree&&!this.trees.has(body.base_tree))return json({message:'Missing base tree'},422);
      const map=new Map(body.base_tree?this.trees.get(body.base_tree):[]);
      for(const e of body.tree){if(e.sha===null)map.delete(e.path);else if(e.content!==undefined)map.set(e.path,this.blob(Buffer.from(e.content)));else if(this.blobs.has(e.sha))map.set(e.path,e.sha);else return json({message:'Missing blob'},422);}
      return json({sha:this.tree(map)},201);
    }
    if(method==='POST'&&path==='/git/commits'){if(!this.trees.has(body.tree))return json({message:'Missing tree'},422);const sha=this.commit(body.tree,body.parents,body.message);return json(this.commits.get(sha),201);}
    if(method==='POST'&&path==='/git/refs'){const branch=body.ref.replace('refs/heads/','');if(this.refs.has(branch))return json({message:'Reference already exists'},422);this.refs.set(branch,body.sha);return json({object:{sha:body.sha}},201);}
    if(method==='PATCH'&&(m=/^\/git\/refs\/heads\/(.+)$/.exec(path))){
      if(this.conflictOnce){const fn=this.conflictOnce;this.conflictOnce=null;fn();}
      const current=this.refs.get(m[1]);const target=this.commits.get(body.sha);if(!target||body.force||!target.parents.some(p=>p.sha===current))return json({message:'Update is not a fast forward'},422);
      this.refs.set(m[1],body.sha);return json({object:{sha:body.sha}});
    }
    return json({message:`Unhandled mock route ${method} ${path}`},500);
  };
  store(extra={}){return new GitHubStore({owner:'qa-user',repo:'qa-repo',branch:'tycgame-data',token:TOKEN,fetch:this.fetch,writeInterval:0,...extra});}
}
