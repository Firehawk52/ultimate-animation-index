const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Twelve URL-safe characters give 2^72 possible, non-guessable share IDs.
const ID_PATTERN = /^[A-Za-z0-9_-]{12}$/;
const KINDS = new Set(['recommendation-list', 'editor-review']);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function withinLimit(binding, request) {
  if (!binding?.limit) return true;
  const result = await binding.limit({ key: clientKey(request) });
  return result.success;
}

async function verifyTurnstile(token, request, env) {
  if (!token || !env.TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  form.set('remoteip', clientKey(request));
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const result = await response.json().catch(() => null);
  return Boolean(response.ok && result?.success);
}

function validPackage(kind, packageCode) {
  if (typeof packageCode !== 'string' || !packageCode.trim()) return false;
  if (new TextEncoder().encode(packageCode).byteLength > MAX_PACKAGE_BYTES) return false;
  return (
    (kind === 'recommendation-list' && packageCode.startsWith('UWL.')) ||
    (kind === 'editor-review' && packageCode.startsWith('UAIE.'))
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    if (request.method === 'POST' && url.pathname === '/v1/shares') {
      if (!(await withinLimit(env.PUBLISH_LIMIT, request)))
        return json({ ok: false, error: 'rate-limited' }, 429);
      const body = await request.json().catch(() => null);
      if (!body || !KINDS.has(body.kind) || !validPackage(body.kind, body.package))
        return json({ ok: false, error: 'invalid-share-package' }, 400);
      if (!(await verifyTurnstile(body.turnstileToken, request, env)))
        return json({ ok: false, error: 'turnstile-failed' }, 403);

      const id = crypto.getRandomValues(new Uint8Array(9));
      const shareId = btoa(String.fromCharCode(...id))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + SHARE_TTL_MS).toISOString();
      await env.SHARES.put(
        `shares/${shareId}.json`,
        JSON.stringify({ kind: body.kind, package: body.package, createdAt, expiresAt }),
        {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
        },
      );
      return json({ ok: true, id: shareId, url: `${url.origin}/v1/shares/${shareId}`, expiresAt });
    }

    const match = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{12})$/);
    if (request.method === 'GET' && match) {
      if (!(await withinLimit(env.READ_LIMIT, request)))
        return json({ ok: false, error: 'rate-limited' }, 429);
      const object = await env.SHARES.get(`shares/${match[1]}.json`);
      if (!object) return json({ ok: false, error: 'not-found' }, 404);
      const payload = await object.json().catch(() => null);
      if (!payload || !KINDS.has(payload.kind) || !validPackage(payload.kind, payload.package))
        return json({ ok: false, error: 'not-found' }, 404);
      if (!payload.expiresAt || Date.parse(payload.expiresAt) <= Date.now())
        return json({ ok: false, error: 'not-found' }, 404);
      return json({
        ok: true,
        kind: payload.kind,
        package: payload.package,
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
      });
    }

    return json({ ok: false, error: 'not-found' }, 404);
  },
};
