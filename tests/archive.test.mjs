import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from '../assets/vendor/fflate.js';
import {unpackZip} from '../assets/archive.js';
test('ZIP upload unpacks files, strips a common folder and preserves binary',async()=>{
 const bytes=zipSync({'build/index.html':strToU8('<h1>ZIP</h1>'),'build/assets/test.bin':new Uint8Array([0,255,1]),'__MACOSX/a':new Uint8Array([1])});
 const result=await unpackZip(new File([bytes],'app.zip'));assert.deepEqual(result.map(f=>f.path),['index.html','assets/test.bin']);assert.equal(await result[0].file.text(),'<h1>ZIP</h1>');assert.deepEqual([...new Uint8Array(await result[1].file.arrayBuffer())],[0,255,1]);
});
test('ZIP rejects path traversal and an archive with no files',async()=>{
 const bad=zipSync({'../index.html':strToU8('bad')});await assert.rejects(()=>unpackZip(new File([bad],'bad.zip')),/路径/);
 const empty=zipSync({});await assert.rejects(()=>unpackZip(new File([empty],'empty.zip')),/没有/);
});
