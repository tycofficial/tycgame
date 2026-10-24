import { readFile, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const page = await readFile(new URL('ui/index.html', root), 'utf8');
const backend = (await readFile(new URL('worker/backend.js', root), 'utf8')).replace(/^export /gm, '');
const manifest = JSON.parse(await readFile(new URL('.openai/hosting.json', root), 'utf8'));
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/server/', root), { recursive: true });
await mkdir(new URL('dist/.openai/', root), { recursive: true });
await writeFile(new URL('dist/server/index.js', root), 'const PAGE = ' + JSON.stringify(page) + ';\n' + backend + '\nexport default { fetch: (r,e,c) => handle(r,e,c,PAGE) };\n');
await writeFile(new URL('dist/.openai/hosting.json', root), JSON.stringify(manifest, null, 2));
// Import the artifact to validate ESM syntax before packaging.
const mod = await import(new URL('dist/server/index.js', root));
if (typeof mod.default?.fetch !== 'function') throw new Error('Worker must export fetch');
console.log('Built and validated dist/server/index.js');
