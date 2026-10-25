import 'fake-indexeddb/auto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalStore} from '../assets/local-store.js';
import {CHUNK_SIZE,openLocalDB,requestResult} from '../assets/shared.js';
const file=(text,name='index.html')=>new File([text],name,{type:'text/html'});
const opts=(slug,files=[{path:'index.html',file:file('<h1>Hello</h1>')}])=>({name:'测试应用',slug,entry:'index.html',files});
test('local storage is explicit, persistent across adapter instances, and keeps binary files',async()=>{
 const a=new LocalStore();const connected=await a.connect();assert.match(connected.user.login,/本地/);
 const files=[{path:'index.html',file:file('<h1>Hello</h1>')},{path:'assets/raw.bin',file:new File([new Uint8Array([0,255,1,2])],'raw.bin')}];
 const app=await a.upload(opts('local-basics',files));assert.equal(app.status,'ready');assert.equal(app.fileCount,2);
 const b=new LocalStore();assert.ok((await b.listApps()).find(x=>x.id===app.id));assert.equal(await(await b.readFile(app.id,'index.html')).text(),'<h1>Hello</h1>');assert.deepEqual([...new Uint8Array(await(await b.readFile(app.id,'assets/raw.bin')).arrayBuffer())],[0,255,1,2]);
 await b.renameApp(app.id,'新的名称');assert.equal((await a.getApp(app.id)).name,'新的名称');await b.deleteApp(app.id);await assert.rejects(()=>a.getApp(app.id),/找不到/);
});
test('pause commits completed chunks and resume keeps the same app revision',async()=>{
 const store=new LocalStore();const controller=new AbortController();const data=new Uint8Array(CHUNK_SIZE+301);data.fill(66,CHUNK_SIZE);
 const input=opts('resume-test',[{path:'index.html',file:new File([data],'index.html')}]);
 await assert.rejects(()=>store.upload({...input,signal:controller.signal,onProgress:p=>{if(p.stage==='uploading'&&p.loaded>=CHUNK_SIZE)controller.abort();}}),{name:'AbortError'});
 const partial=await store.getApp('resume-test');assert.equal(partial.status,'uploading');assert.equal(partial.files[0].chunks.length,1);
 const result=await store.upload({...input,resumeId:partial.id});assert.equal(result.revision,partial.revision);assert.equal(result.files[0].chunks.length,2);assert.equal(result.status,'ready');
 const db=await openLocalDB();const chunks=await requestResult(db.transaction('chunks').objectStore('chunks').index('appId').getAll('resume-test'));db.close();assert.equal(chunks.length,2);
 const blob=await store.readFile(result.id,'index.html');assert.equal(blob.size,data.length);assert.deepEqual([...new Uint8Array(await blob.slice(-3).arrayBuffer())],[66,66,66]);await store.deleteApp(result.id);
});
test('rejects unsafe paths, duplicates, bad entry and oversized manifests before persisting',async()=>{
 const store=new LocalStore();
 for(const path of ['../index.html','a/../index.html','/index.html','a\\index.html'])await assert.rejects(()=>store.upload(opts('bad-path',[{path,file:file('x')}])),/路径/);
 await assert.rejects(()=>store.upload(opts('bad-dupe',[{path:'index.html',file:file('1')},{path:'index.html',file:file('2')}])),/重复/);
 await assert.rejects(()=>store.upload({...opts('bad-entry'),entry:'other.html'}),/入口/);
 const huge={size:3*1024**3,slice(){throw Error('should not read');},name:'index.html'};await assert.rejects(()=>store.upload(opts('huge-file',[{path:'index.html',file:huge}])),/2 GiB/);
});
test('concurrent duplicate slug creation is atomic and deletion clears all chunks',async()=>{
 const store=new LocalStore();const result=await Promise.allSettled([store.upload(opts('same-slug')),store.upload(opts('same-slug'))]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.filter(x=>x.status==='rejected').length,1);
 await store.deleteApp('same-slug');const db=await openLocalDB();const chunks=await requestResult(db.transaction('chunks').objectStore('chunks').index('appId').getAll('same-slug'));db.close();assert.equal(chunks.length,0);
});
test('deleting between completed chunks and publication cannot resurrect a local app',async()=>{
 const store=new LocalStore();const original=store._saveApp.bind(store);store._saveApp=async app=>{await store.deleteApp(app.id);return original(app);};
 await assert.rejects(()=>store.upload(opts('delete-race')),/删除/);await assert.rejects(()=>store.getApp('delete-race'),/找不到/);
});

test('existing local files can be republished from stored Blob parts without decoding the whole application',async()=>{
 const store=new LocalStore();const input=opts('migrate-local',[{path:'index.html',file:file('<h1>Keep my existing app</h1>')},{path:'assets/image.bin',file:new File([new Uint8Array([0,255,7])],'image.bin')}]);
 const saved=await store.upload(input);
 const result=await store.sourceFiles(saved.id);assert.equal(result.app.revision,saved.revision);
 assert.deepEqual(result.files.map(f=>f.path),['index.html','assets/image.bin']);
 assert.equal(await result.files[0].file.text(),'<h1>Keep my existing app</h1>');
 assert.deepEqual([...new Uint8Array(await result.files[1].file.arrayBuffer())],[0,255,7]);
 await store.deleteApp(saved.id);
});
