import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const argv=process.argv.slice(2);const option=name=>argv[argv.indexOf(name)+1];
const port=argv.includes('--port')?Number(option('--port')):4173;
let base=argv.includes('--base')?option('--base'):'/';base='/'+base.replace(/^\/+|\/+$/g,'')+'/';if(base==='//')base='/';
const root=resolve(new URL('../',import.meta.url).pathname);
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');let path=decodeURIComponent(url.pathname);
  if(!path.startsWith(base)){res.writeHead(404);res.end('Not found');return;}
  path=path.slice(base.length);const file=resolve(root,path||'index.html');if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  const info=await stat(file);if(!info.isFile())throw new Error('Not a file');
  const data=await readFile(file);res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff',...(file.endsWith('/sw.js')?{'service-worker-allowed':base}: {})});res.end(data);
}catch{if((req.headers.accept||'').includes('text/html')){const page=(await readFile(resolve(root,'404.html'),'utf8')).replace("const project=location.hostname.endsWith('.github.io')&&pieces.length>1;",'const project='+JSON.stringify(base!=='/')+';');res.writeHead(404,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(page);}else{res.writeHead(404,{'content-type':'text/plain;charset=utf-8'});res.end('Not found');}}});
server.listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}${base}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
