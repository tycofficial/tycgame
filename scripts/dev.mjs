import { spawnSync, spawn } from 'node:child_process';
const build = spawnSync(process.execPath, ['scripts/build.mjs'], {stdio:'inherit'});
if (build.status) process.exit(build.status);
console.log('Local development: data stays in local Wrangler R2; this does not publish.');
const child=spawn(process.platform==='win32'?'npx.cmd':'npx', ['--yes','wrangler@4','dev','worker/local.js','--local','--ip','127.0.0.1','--config','wrangler.toml'], {stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code||0));
