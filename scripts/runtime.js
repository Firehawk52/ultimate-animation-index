import { get } from 'node:http';

export const SUPPORTED_NODE_RELEASES = '22.16+ or 24+';

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor, patch] = String(version).split('.').slice(0, 3).map(Number);
  const supported =
    [major, minor, patch].every(Number.isInteger) && ((major === 22 && minor >= 16) || major >= 24);
  if (!supported) {
    throw new Error(`Node.js ${SUPPORTED_NODE_RELEASES} is required. Detected: ${version || 'unknown'}.`);
  }
}

export function parsePort(value = '8787', { allowZero = false } = {}) {
  const port = Number(value || 8787);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`PORT must be a whole number between ${minimum} and 65535.`);
  }
  return port;
}

export function readLocalHealth(port, timeout = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
        agent: false,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            response.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const isUltimateAnimationIndex =
              response.statusCode === 200 &&
              health?.ok === true &&
              health?.format === 'UWL' &&
              typeof health?.version === 'string' &&
              Number.isInteger(health?.userListSchema);
            finish(isUltimateAnimationIndex ? health : null);
          } catch {
            finish(null);
          }
        });
        response.once('error', () => finish(null));
      },
    );
    request.setTimeout(timeout, () => request.destroy());
    request.once('error', () => finish(null));
    request.end();
  });
}
