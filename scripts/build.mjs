import {mkdir,rm,cp} from 'node:fs/promises';
const root=new URL('../',import.meta.url);const output=new URL('dist/',root);
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
for(const item of ['index.html','404.html','run.html','sw.js','assets','.nojekyll','manifest.webmanifest'])await cp(new URL(item,root),new URL(item,output),{recursive:true});
console.log('Built dist/: complete static app, no server or redirect required.');
