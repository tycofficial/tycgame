import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, MAX_APP_BYTES } from '../assets/github-store.js';
import { GitHubMock, TOKEN } from './helpers/github-mock.mjs';

const html = (text='<!doctype html><h1>Hello</h1>') => new File([text],'index.html',{type:'text/html'});
const options = (slug='hello-app',file=html()) => ({files:[{file,path:'index.html'}],name:'Hello app',slug,entry:'index.html',concurrency:1});

test('anonymous read of an uninitialized data branch is empty and never writes',async()=>{
  const api=new GitHubMock();const store=api.store({token:''});const conn=await store.connect();assert.equal(conn.user,null);assert.deepEqual(await store.listApps(),[]);assert.ok(api.calls.every(c=>c.method==='GET'));await assert.rejects(store.upload(options()),e=>e.status===401);
});

test('connect verifies real profile, repository visibility and wrong token errors',async()=>{
  const api=new GitHubMock({privateRepo:true});const store=api.store();const c=await store.connect();assert.equal(c.user.login,'qa-user');assert.equal(c.repository.private,true);assert.equal(c.limits.chunkSize,CHUNK_SIZE);await assert.rejects(api.store({token:'invalid'}).connect(),e=>e.status===401);
});

test('single HTML publishes to the data branch and is visible to another adapter',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();const app=await store.upload(options());assert.equal(app.status,'ready');assert.equal(api.refs.get('main'),api.main);assert.equal(api.at('index.html','main').toString(), '<!doctype html><title>Original source</title>');assert.equal(api.at('index.html'),null,'data tree excludes source');
  const other=api.store();await other.connect();const list=await other.listApps();assert.equal(list.length,1);assert.equal(list[0].id,'hello-app');assert.ok(!('_objects' in list[0]));assert.equal((await other.getApp(app.id)).files.length,1);assert.equal(await (await other.readFile(app.id,'index.html')).text(),await html().text());
  const tree=api.trees.get(api.commits.get(api.head()).tree.sha);assert.ok([...tree.keys()].some(p=>p.startsWith('objects/')));assert.ok(tree.has('catalog.json'));
});

test('large file uses bounded 8 MiB blobs and reassembles binary exactly',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();const bytes=new Uint8Array(CHUNK_SIZE+31);bytes.fill(65,0,CHUNK_SIZE);bytes.fill(90,CHUNK_SIZE);const file=new File([bytes],'index.html',{type:'text/html'});const app=await store.upload(options('large-app',file));assert.deepEqual(app.files[0].chunks.map(c=>c.size),[CHUNK_SIZE,31]);
  const uploads=api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/git/blobs'));assert.equal(uploads.length,2);assert.ok(uploads.every(c=>Buffer.from(c.body.content,'base64').length<=CHUNK_SIZE));const blob=await store.readFile(app.id,'index.html');assert.match(blob.type,/^text\/html(?:;|$)/);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
});

test('pause checkpoints completed chunks; resume verifies originals and skips saved chunks',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();const file=new File([new Uint8Array(CHUNK_SIZE+7).fill(9)],'index.html',{type:'text/html'});const controller=new AbortController();let id;
  await assert.rejects(store.upload({...options('paused-app',file),signal:controller.signal,onProgress(p){id=p.appId||id;if(p.stage==='uploading'&&p.loaded>0)controller.abort();}}),e=>e.name==='AbortError');
  const paused=await store.getApp(id);assert.equal(paused.status,'uploading');assert.ok(paused.files[0].chunks[0]);assert.equal(paused.files[0].chunks[1],null);const before=api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/git/blobs')).length;
  const resumed=await api.store().upload({...options('paused-app',file),resumeId:id});assert.equal(resumed.status,'ready');assert.equal(api.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/git/blobs')).length-before,1);
});

test('resume rejects changed contents even when path and size match',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();const file=new File([new Uint8Array(CHUNK_SIZE+1).fill(4)],'index.html',{type:'text/html'});const controller=new AbortController();await assert.rejects(store.upload({...options('changed-app',file),signal:controller.signal,onProgress(p){if(p.loaded>0)controller.abort();}}),e=>e.name==='AbortError');
  const changed=new File([new Uint8Array(CHUNK_SIZE+1).fill(5)],'index.html',{type:'text/html'});await assert.rejects(store.upload({...options('changed-app',changed),resumeId:'changed-app'}),e=>e.status===409);
});

test('shared chunk deletion preserves the other app and rename changes no file bytes',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();const first=await store.upload(options('first-app'));const second=await store.upload(options('second-app'));assert.equal(first.files[0].chunks[0].sha,second.files[0].chunks[0].sha);const sha=first.files[0].chunks[0].sha;
  await store.renameApp('second-app','Renamed');await store.deleteApp('first-app');assert.equal((await store.getApp('second-app')).name,'Renamed');assert.ok(api.at(`objects/${sha}`));assert.equal(await (await store.readFile('second-app','index.html')).text(),await html().text());await store.deleteApp('second-app');assert.equal(api.at(`objects/${sha}`),null);assert.deepEqual(await store.listApps(),[]);
});

test('fast-forward conflict retries and preserves another device catalog update',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();await store.upload(options('base-app'));api.conflictOnce=()=>api.injectForeignApp();await store.renameApp('base-app','After race');const apps=await store.listApps();assert.deepEqual(apps.map(a=>a.id).sort(),['another-device','base-app']);assert.equal((await store.getApp('base-app')).name,'After race');
});

test('unsafe paths, duplicate slugs and oversized manifests fail without source writes',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();for(const path of ['../index.html','/index.html','folder\\index.html','foo//index.html','a/./index.html','x\u0000.html'])await assert.rejects(store.upload({...options('bad-path'),entry:path,files:[{path,file:html()}]}),e=>e.status===400);
  await store.upload(options('unique-app'));await assert.rejects(store.upload(options('unique-app')),e=>e.status===409);const virtual={size:MAX_APP_BYTES+1,name:'index.html',slice(){throw new Error('must not read oversized data');}};await assert.rejects(store.upload({...options('oversized-app'),files:[{path:'index.html',file:virtual}]}),e=>e.status===413);assert.equal(api.refs.get('main'),api.main);
});

test('tokens appear only in Authorization, never URLs, catalog, manifest or tree content',async()=>{
  const api=new GitHubMock({privateRepo:true});const store=api.store();await store.connect();await store.upload(options('private-app'));await store.readFile('private-app','index.html');
  for(const c of api.calls){assert.ok(!c.url.includes(TOKEN));assert.ok(!JSON.stringify(c.body).includes(TOKEN));assert.equal(c.headers.authorization,`Bearer ${TOKEN}`);assert.equal(new URL(c.url).hostname,'api.github.com');}for(const bytes of api.blobs.values())assert.ok(!bytes.toString().includes(TOKEN));assert.ok(!JSON.stringify(store.connection).includes(TOKEN));
});

test('the source branch is rejected even when upload is called before connect',async()=>{
  const api=new GitHubMock();const store=api.store({branch:'main'});await assert.rejects(store.upload(options('unsafe-main')),e=>e.status===400);assert.equal(api.refs.get('main'),api.main);
});


test('1 GiB upload plan is accepted without reading large file contents',async()=>{
  const api=new GitHubMock();const store=api.store();await store.connect();let reads=0;const file={size:1024**3,name:'index.html',type:'text/html',slice(){reads++;throw new Error('upload was paused before any data read');}};const controller=new AbortController();
  await assert.rejects(store.upload({...options('one-gib-plan'),files:[{path:'index.html',file}],signal:controller.signal,onProgress(p){if(p.appId&&p.stage==='uploading'&&p.loaded===0)controller.abort();}}),e=>e.name==='AbortError');
  const manifest=await store.getApp('one-gib-plan');assert.equal(manifest.totalBytes,1024**3);assert.equal(manifest.files[0].chunks.length,128);assert.equal(reads,0);assert.ok(manifest.files[0].chunks.every(c=>c===null));assert.equal(api.refs.get('main'),api.main);
});

test('two devices can initialize and publish different apps without losing either app',async()=>{
  const api=new GitHubMock();const one=api.store(),two=api.store();await Promise.all([one.connect(),two.connect()]);const result=await Promise.all([one.upload(options('device-one')),two.upload(options('device-two'))]);assert.ok(result.every(a=>a.status==='ready'));assert.deepEqual((await one.listApps()).map(a=>a.id).sort(),['device-one','device-two']);assert.equal(api.refs.get('main'),api.main);
});

test('concurrent devices reserve a duplicate slug atomically',async()=>{
  const api=new GitHubMock();const one=api.store(),two=api.store();await Promise.all([one.connect(),two.connect()]);const result=await Promise.allSettled([one.upload(options('shared-slug')),two.upload(options('shared-slug'))]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);assert.equal((await one.listApps()).length,1);assert.equal((await one.getApp('shared-slug')).status,'ready');
});
