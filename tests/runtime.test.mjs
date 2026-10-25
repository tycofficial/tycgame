import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const MiB=1024**2;
const workerSource=await readFile(new URL('../sw.js',import.meta.url),'utf8');
const origin='http://localhost';
const base=origin+'/TycGame/';
const token='unit-test-memory-only-credential';

// Run the actual shipped Worker and its handlers. Only the browser platform
// boundary and GitHub network are replaced; stream/Range/capability logic is
// not copied into this test harness.
function runtime({failPart=-1,size=8*MiB,count=3,requireAuthorization=false}={}) {
  const stats={started:[],calls:[],active:0,maxActive:0,aborted:[]};
  const shas=Array.from({length:count},(_,index)=>(index+1).toString(16).repeat(40));
  const listeners=new Map();
  const fetch=async(url,options={})=>{
    const sha=String(url).split('/').pop();
    const index=shas.indexOf(sha);
    assert.ok(index>=0,'Worker requested a blob outside the network fixture');
    const authorized=options.headers?.Authorization===`Bearer ${token}`;
    stats.calls.push({index,authorized});
    if(requireAuthorization && !authorized)return new Response('private repository',{status:404});
    stats.started.push(index);
    if(index===failPart)throw new Error('simulated prefetch failure');
    stats.active++;stats.maxActive=Math.max(stats.maxActive,stats.active);
    let remaining=size,closed=false,streamController;
    const finish=()=>{if(!closed){closed=true;stats.active--;}};
    const abort=()=>{
      if(!closed){stats.aborted.push(index);finish();streamController?.error(new DOMException('Aborted','AbortError'));}
    };
    options.signal?.addEventListener('abort',abort,{once:true});
    return new Response(new ReadableStream({
      start(controller){streamController=controller;},
      pull(controller){
        if(!remaining){finish();controller.close();return;}
        const length=Math.min(remaining,64*1024);remaining-=length;
        controller.enqueue(new Uint8Array(length).fill(65+index));
      },
      cancel(){finish();},
    },{highWaterMark:0}),{headers:{'Content-Type':'application/octet-stream'}});
  };
  const context=vm.createContext({
    self:{registration:{scope:base},location:{origin},addEventListener(type,handler){listeners.set(type,handler);}},
    URL,Response,Headers,ReadableStream,AbortController,Blob,fetch,atob,
  });
  vm.runInContext(workerSource+'\nglobalThis.runtimeUnderTest={fileStream,rangeOf};',context,{filename:'sw.js'});
  const file={size:size*count,chunks:shas.map(sha=>({sha,size}))};
  const connection={mode:'github',owner:'owner',repo:'repo',branch:'data',token};
  return {
    stats,shas,
    stream(range={offset:0,length:file.size}){return context.runtimeUnderTest.fileStream(connection,file,range);},
    range(header,length){return {...context.runtimeUnderTest.rangeOf(header,length)};},
    manifest(index=0,path='index.html'){
      return {id:'approved-app',revision:'test-revision',status:'ready',entry:path,files:[{path,size,chunks:[{sha:shas[index],size}]}]};
    },
    async message(data){
      let reply,pending;
      listeners.get('message')({data,ports:[{postMessage(value){reply=structuredClone(value);},close(){}}],waitUntil(value){pending=value;}});
      await pending;return reply;
    },
    async request(path,options={}){
      let pending;
      listeners.get('fetch')({request:new Request(new URL(path,base),options),respondWith(value){pending=value;}});
      assert.ok(pending,'Worker should intercept its virtual runtime path');
      return pending;
    },
  };
}

async function consume(stream){let size=0;for await(const chunk of stream)size+=chunk.byteLength;return size;}

test('large runtime files stream with at most the current and next chunk in flight',async()=>{
  const r=runtime();
  assert.equal(await consume(r.stream()),24*MiB);
  assert.deepEqual(r.stats.started,[0,1,2]);
  assert.equal(r.stats.maxActive,2);
  assert.equal(r.stats.active,0);
});

test('runtime Range reads do not prefetch outside the requested chunk coverage',async()=>{
  const single=runtime();
  const bytes=await new Response(single.stream({offset:8*MiB+100,length:200})).arrayBuffer();
  assert.equal(bytes.byteLength,200);
  assert.deepEqual(single.stats.started,[1]);
  assert.equal(single.stats.active,0);

  const crossing=runtime();
  const boundary=new Uint8Array(await new Response(crossing.stream({offset:8*MiB-10,length:20})).arrayBuffer());
  assert.deepEqual([...boundary],[...new Uint8Array(10).fill(65),...new Uint8Array(10).fill(66)]);
  assert.deepEqual(crossing.stats.started,[0,1]);
  assert.equal(crossing.stats.active,0);
});

test('canceling a runtime read aborts both the active and prefetched chunk',async()=>{
  const r=runtime();
  const reader=r.stream().getReader();
  await reader.read();
  await reader.cancel('user canceled');
  assert.deepEqual(r.stats.started,[0,1]);
  assert.deepEqual(r.stats.aborted.sort(),[0,1]);
  assert.equal(r.stats.active,0);
});

test('a failed prefetch rejects its consumer without leaving a request or unhandled promise',async()=>{
  const r=runtime({failPart:1});
  await assert.rejects(consume(r.stream()),/simulated prefetch failure/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.stats.active,0);
});

test('small runtime files retain serial chunk loading',async()=>{
  const r=runtime({size:512,count:2});
  assert.equal(await consume(r.stream()),1024);
  assert.equal(r.stats.maxActive,1);
  assert.equal(r.stats.active,0);
});

test('runtime Range parsing handles suffixes and rejects invalid or multiple ranges',()=>{
  const r=runtime();
  assert.deepEqual(r.range('bytes=2-5',10),{offset:2,length:4,partial:true});
  assert.deepEqual(r.range('bytes=-3',10),{offset:7,length:3,partial:true});
  assert.deepEqual(r.range('bytes=7-99',10),{offset:7,length:3,partial:true});
  for(const header of ['bytes=10-','bytes=5-2','bytes=-0','bytes=0-1,3-4','bytes=-'])assert.throws(()=>r.range(header,10));
});

test('runtime capabilities are immutable, cannot return credentials, and cannot borrow another session token',async()=>{
  const r=runtime({size:512,count:2,requireAuthorization:true});
  const session='a'.repeat(64),otherSession='b'.repeat(64);
  const configured=await r.message({type:'TYC_CONFIGURE',session,app:r.manifest(),connection:{mode:'github',owner:'owner',repo:'repo',branch:'data',token}});
  assert.equal(configured.ok,true);
  const rejected=await r.message({type:'TYC_GET_TOKEN',session});
  assert.equal(rejected.ok,false);
  const changed=await r.message({type:'TYC_CONFIGURE',session,app:r.manifest(1,'secret.html'),connection:{mode:'github',owner:'owner',repo:'repo'}});
  assert.equal(changed.ok,true);
  assert.equal(JSON.stringify([configured,rejected,changed]).includes(token),false);

  const prefix='__tyc_runtime/'+session+'/';
  const head=await r.request(prefix+'index.html',{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(head.headers.get('Content-Length'),'512');
  assert.equal(r.stats.calls.length,0);
  assert.equal((await r.request(prefix+'secret.html')).status,404);
  const approved=await r.request(prefix+'index.html',{headers:{Range:'bytes=510-511'}});
  assert.equal(approved.status,206);
  assert.equal(await approved.text(),'AA');
  assert.equal(r.stats.calls.some(call=>call.index===0 && call.authorized),true);

  await r.message({type:'TYC_CONFIGURE',session:otherSession,app:r.manifest(1),connection:{mode:'github',owner:'owner',repo:'repo'}});
  const tokenless=await r.request('__tyc_runtime/'+otherSession+'/index.html');
  await assert.rejects(tokenless.text());
  assert.equal(r.stats.calls.some(call=>call.index===1 && call.authorized),false);
  assert.equal(r.stats.calls.some(call=>call.index===1 && !call.authorized),true);

  assert.equal((await r.message({type:'TYC_CLOSE',session})).ok,true);
  assert.equal((await r.request(prefix+'index.html')).status,410);
});
