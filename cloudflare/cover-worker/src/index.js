const MANIFESTS = new Set(['cover-pack.json', 'catalog-source.json', 'catalog-source-manifest.json']);
const PACKAGE_PATH = /^packages\/covers-[A-Za-z0-9._-]+\.zip$/;

function keyFor(pathname) {
  const key = pathname.replace(/^\/+/, '');
  return MANIFESTS.has(key) || PACKAGE_PATH.test(key) ? key : '';
}

function contentType(key) {
  if (key.endsWith('.zip')) return 'application/zip';
  return 'application/json; charset=utf-8';
}

function cacheControl(key) {
  return key.startsWith('packages/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const key = keyFor(new URL(request.url).pathname);
    if (!key) return new Response('Not found', { status: 404 });
    const object = await env.COVERS.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type': contentType(key),
      'Cache-Control': cacheControl(key),
      'X-Content-Type-Options': 'nosniff',
      ETag: object.httpEtag,
    });
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
