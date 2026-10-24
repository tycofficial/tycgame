// Local Wrangler entrypoint only. Never package or deploy this module.
import worker from '../dist/server/index.js';
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return new Response('Local development only', {status:403});
    const headers = new Headers(request.headers);
    headers.set('oai-authenticated-user-id', 'local-development-only');
    headers.set('oai-authenticated-user-email', '本地开发（数据仅在本机）');
    return worker.fetch(new Request(request, {headers}), env, ctx);
  }
};
