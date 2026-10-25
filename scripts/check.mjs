import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const files=['sw.js',...(await readdir('assets')).filter(x=>x.endsWith('.js')).map(x=>'assets/'+x)];
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status){process.stderr.write(result.stderr);process.exit(result.status);}}
for(const file of ['index.html','run.html',...files]){const source=await readFile(file,'utf8');if(/chatgpt[.]site|signin-with-chatgpt|http-equiv=["']refresh/i.test(source))throw new Error('Unexpected legacy redirect or dependency: '+file);}
const home=await readFile('index.html','utf8');if(!home.includes('TycGame'))throw new Error('Missing app brand');
console.log('ES modules, service worker, app pages and absence of external redirects checked.');
