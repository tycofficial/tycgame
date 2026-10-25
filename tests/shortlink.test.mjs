import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRunURL,parseRunRoute,encodeRunDescriptor,decodeRunDescriptor,DEFAULT_RUN_CONNECTION} from '../assets/shared.js';

const base='https://tycofficial.github.io/TycGame/';
const pathname='/TycGame/';
const app={id:'my-tool',slug:'my-tool'};

test('cloud short suffixes and explicit local routes never overlap',()=>{
  assert.equal(makeRunURL(app,DEFAULT_RUN_CONNECTION,base),base+'my-tool');
  assert.equal(makeRunURL(app,{...DEFAULT_RUN_CONNECTION,owner:'TYCOFFICIAL',repo:'TycGame',token:'must-not-appear'},base),base+'my-tool');
  assert.equal(makeRunURL(app,{mode:'local'},base),base+'local/my-tool');
  const route=parseRunRoute(base+'my-tool',pathname);
  assert.deepEqual(route,{slug:'my-tool',connection:{...DEFAULT_RUN_CONNECTION},shortPath:'/TycGame/my-tool'});
  assert.deepEqual(parseRunRoute(base+'local/my-tool',pathname),{slug:'my-tool',connection:{mode:'local'},shortPath:'/TycGame/local/my-tool'});
  assert.deepEqual(parseRunRoute(base+'local',pathname),{slug:'local',connection:{...DEFAULT_RUN_CONNECTION},shortPath:'/TycGame/local'});
});

test('custom repository paths carry portable coordinates without tokens or browser mappings',()=>{
  const connection={mode:'github',owner:'another-owner',repo:'another-repository',branch:'apps/公开',token:'must-not-appear'};
  const url=makeRunURL(app,connection,base);
  assert.equal(new URL(url).search,'');
  assert.match(new URL(url).pathname,/^\/TycGame\/~\/[A-Za-z0-9_-]+\/my-tool$/);
  assert.equal(url.includes(connection.token),false);
  assert.deepEqual(parseRunRoute(url,pathname).connection,{mode:'github',owner:connection.owner,repo:connection.repo,branch:connection.branch});
});

test('legacy a/suffix and owner/repo queries canonicalize to portable short paths',()=>{
  const legacy=parseRunRoute(base+'a/my-tool',pathname);
  assert.equal(legacy.shortPath,'/TycGame/my-tool');
  const custom=parseRunRoute(base+'my-tool?owner=someone&repo=other&branch=files',pathname);
  assert.deepEqual(custom.connection,{mode:'github',owner:'someone',repo:'other',branch:'files'});
  assert.match(custom.shortPath,/^\/TycGame\/~\//);
});

test('transient runtime descriptors preserve entry/name while dropping credentials and arbitrary metadata',()=>{
  const encoded=encodeRunDescriptor({slug:app.slug,connection:{...DEFAULT_RUN_CONNECTION,token:'secret-value'},entry:'pages/home.html',name:'我的应用',token:'secret-value',arbitrary:'never-copy'},pathname);
  const decoded=decodeRunDescriptor(encoded,pathname);
  assert.deepEqual(decoded,{slug:app.slug,connection:{...DEFAULT_RUN_CONNECTION},shortPath:'/TycGame/my-tool',entry:'pages/home.html',name:'我的应用'});
  assert.equal(JSON.stringify(decoded).includes('secret-value'),false);
  assert.equal(JSON.stringify(decoded).includes('never-copy'),false);
});

test('short links reject invalid paths and forged descriptor entries',()=>{
  for(const url of [base+'../outside',base+'my-tool/extra',base+'a/my-tool/extra',base+'~/invalid/my-tool',base+'%2fmy-tool'])assert.throws(()=>parseRunRoute(url,pathname));
  assert.throws(()=>makeRunURL({slug:'../other'},DEFAULT_RUN_CONNECTION,base));
  assert.throws(()=>encodeRunDescriptor({slug:app.slug,connection:DEFAULT_RUN_CONNECTION,entry:'../secret.html'},pathname));
});
