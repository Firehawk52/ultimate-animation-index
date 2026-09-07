import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.find((argument) => argument.startsWith('--output='));
const catalogFlag = process.argv.find((argument) => argument.startsWith('--catalog='));
const catalogOnly = process.argv.includes('--catalog-only');
const OUTPUT_DIR = outputFlag
  ? resolve(String(outputFlag.slice('--output='.length)))
  : resolve(ROOT, 'data', 'cover-package-output');
const ENV_FILE = resolve(ROOT, '.env.cover-publisher');
const DEFAULT_BUCKET = 'ultimate-anime-index';
const REGION = 'auto';
const SERVICE = 's3';
const TERMINATOR = 'aws4_request';

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

function awsDate(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) fail(`Invalid environment line: ${rawLine}`);
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

async function environment() {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(ENV_FILE, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const value = (name, fallback = '') => process.env[name] || fileValues[name] || fallback;
  const required = (name, fallback) => {
    const result = value(name, fallback);
    if (!result) fail(`Missing ${name}. Add it to ${basename(ENV_FILE)}.`);
    return result;
  };

  return {
    accountId: required('R2_ACCOUNT_ID'),
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET', DEFAULT_BUCKET),
  };
}

function encodedPath(bucket, key) {
  const encode = (part) =>
    encodeURIComponent(part).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return `/${encode(bucket)}/${key.split('/').map(encode).join('/')}`;
}

function encodedQuery(entries) {
  const encode = (value) =>
    encodeURIComponent(String(value)).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return entries
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function decodeXml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function signingKey(secret, date) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, TERMINATOR);
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function inside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function loadPackage() {
  const manifestPath = resolve(OUTPUT_DIR, 'cover-pack.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const archiveKey = String(manifest?.archive?.path || '').replace(/\\/g, '/');
  if (!archiveKey || archiveKey.startsWith('/') || archiveKey.includes('..'))
    fail('Invalid cover-pack archive path.');

  const archivePath = resolve(OUTPUT_DIR, archiveKey);
  if (!inside(OUTPUT_DIR, archivePath)) fail('Cover archive escapes the package directory.');
  await access(archivePath);

  const archiveStat = await stat(archivePath);
  const archiveHash = await fileHash(archivePath);
  if (archiveHash !== String(manifest?.archive?.sha256 || '').toLowerCase()) {
    fail('Archive checksum does not match cover-pack.json. Rebuild the cover package before publishing.');
  }
  if (archiveStat.size !== Number(manifest?.archive?.bytes)) {
    fail('Archive size does not match cover-pack.json. Rebuild the cover package before publishing.');
  }
  const catalog = manifest?.catalog || {};
  const modernCatalog =
    String(catalog.path || '').replace(/\\/g, '/') === 'catalog-source.json' &&
    /^[a-f0-9]{64}$/i.test(String(catalog.sha256 || ''));
  const catalogKey = 'catalog-source.json';
  const catalogPath = modernCatalog
    ? resolve(OUTPUT_DIR, catalogKey)
    : resolve(ROOT, 'data', 'catalog-source.json');
  if (modernCatalog && !inside(OUTPUT_DIR, catalogPath))
    fail('Catalog source escapes the package directory.');
  await access(catalogPath);
  const catalogStat = await stat(catalogPath);
  const catalogSha256 = await fileHash(catalogPath);
  if (
    modernCatalog &&
    (catalogStat.size !== Number(catalog.bytes) || catalogSha256 !== String(catalog.sha256).toLowerCase())
  )
    fail(
      'Catalog source checksum does not match cover-pack.json. Rebuild the cover package before publishing.',
    );

  return {
    manifest,
    manifestPath,
    archiveKey,
    archivePath,
    archiveStat,
    catalogKey,
    catalogPath,
    catalogStat,
    catalogSha256,
  };
}

async function loadCatalogOnly() {
  const catalogPath = catalogFlag
    ? resolve(String(catalogFlag.slice('--catalog='.length)))
    : resolve(ROOT, 'data', 'catalog-source.json');
  const raw = await readFile(catalogPath, 'utf8');
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    fail('Catalog source is not valid JSON.');
  }
  if (!Array.isArray(catalog?.items)) fail('Catalog source has no items array.');
  const details = await stat(catalogPath);
  return { catalogPath, sha256: await fileHash(catalogPath), bytes: details.size };
}

async function putObject(
  { accountId, accessKeyId, secretAccessKey, bucket },
  key,
  path,
  contentType,
  cacheControl,
) {
  const payloadHash = await fileHash(path);
  const now = new Date();
  const timestamp = awsDate(now);
  const date = timestamp.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = encodedPath(bucket, key);
  const credentialScope = `${date}/${REGION}/${SERVICE}/${TERMINATOR}`;
  const canonicalHeaders =
    [
      `content-type:${contentType}`,
      `host:${host}`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${timestamp}`,
    ].join('\n') + '\n';
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, date), stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const objectStat = await stat(path);
  const response = await fetch(`https://${host}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'Content-Length': String(objectStat.size),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      'Cache-Control': cacheControl,
    },
    body: createReadStream(path),
    duplex: 'half',
  });

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
    fail(`Upload failed for ${key}: ${response.status} ${detail}`);
  }
  return response.headers.get('etag') || '(no ETag returned)';
}

async function signedEmptyRequest(
  { accountId, accessKeyId, secretAccessKey, bucket },
  method,
  key,
  queryEntries = [],
) {
  const payloadHash = sha256('');
  const now = new Date();
  const timestamp = awsDate(now);
  const date = timestamp.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = encodedPath(bucket, key);
  const canonicalQuery = encodedQuery(queryEntries);
  const credentialScope = `${date}/${REGION}/${SERVICE}/${TERMINATOR}`;
  const canonicalHeaders =
    [`host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${timestamp}`].join('\n') + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, date), stringToSign, 'hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(`https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`, {
    method,
    headers: {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
    },
  });
}

async function oldCoverArchives(config, activeKey) {
  const retained = [];
  let continuationToken = '';
  do {
    const query = [
      ['list-type', '2'],
      ['prefix', 'packages/covers-'],
    ];
    if (continuationToken) query.push(['continuation-token', continuationToken]);
    const response = await signedEmptyRequest(config, 'GET', '', query);
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
      fail(`Could not list previous cover packages: ${response.status} ${detail}`);
    }
    const body = await response.text();
    for (const match of body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const key = decodeXml(match[1]);
      if (/^packages\/covers-[A-Za-z0-9._-]+\.zip$/i.test(key) && key !== activeKey) retained.push(key);
    }
    const next = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    continuationToken = next ? decodeXml(next[1]) : '';
  } while (continuationToken);
  return retained;
}

async function removeOldCoverArchives(config, activeKey) {
  const oldArchives = await oldCoverArchives(config, activeKey);
  for (const key of oldArchives) {
    const response = await signedEmptyRequest(config, 'DELETE', key);
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
      fail(`Could not remove obsolete cover package ${key}: ${response.status} ${detail}`);
    }
  }
  return oldArchives;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (catalogOnly) {
    const catalog = await loadCatalogOnly();
    console.log(`Validated ${catalog.bytes.toLocaleString('en-US')} byte catalog source.`);
    if (dryRun) {
      console.log('Dry run complete. Nothing was uploaded.');
      return;
    }
    const config = await environment();
    console.log('Uploading catalog-source.json…');
    const catalogEtag = await putObject(
      config,
      'catalog-source.json',
      catalog.catalogPath,
      'application/json; charset=utf-8',
      'no-cache',
    );
    await (await import('node:fs/promises')).mkdir(OUTPUT_DIR, { recursive: true });
    const manifestPath = resolve(OUTPUT_DIR, `.catalog-source-${Date.now()}.json`);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      path: 'catalog-source.json',
      sha256: catalog.sha256,
      bytes: catalog.bytes,
    };
    await (await import('node:fs/promises')).writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    try {
      const manifestEtag = await putObject(
        config,
        'catalog-source-manifest.json',
        manifestPath,
        'application/json; charset=utf-8',
        'no-cache',
      );
      console.log(`Catalog source published (${catalogEtag}); manifest published (${manifestEtag}).`);
    } finally {
      await (await import('node:fs/promises')).rm(manifestPath, { force: true });
    }
    return;
  }
  const pack = await loadPackage();
  console.log(`Validated ${pack.manifest.archive.coverCount.toLocaleString('en-US')} covers.`);
  console.log(`Archive: ${pack.archiveKey} (${pack.archiveStat.size.toLocaleString('en-US')} bytes)`);

  if (dryRun) {
    console.log('Dry run complete. Nothing was uploaded.');
    return;
  }

  const config = await environment();
  console.log(`Uploading ${pack.archiveKey} to ${config.bucket}…`);
  const archiveEtag = await putObject(
    config,
    pack.archiveKey,
    pack.archivePath,
    'application/zip',
    'public, max-age=31536000, immutable',
  );
  console.log(`Archive uploaded (${archiveEtag}).`);

  console.log('Publishing catalog-source.json…');
  const catalogEtag = await putObject(
    config,
    pack.catalogKey,
    pack.catalogPath,
    'application/json; charset=utf-8',
    'no-cache',
  );
  console.log(`Catalog source published (${catalogEtag}).`);

  const catalogManifestPath = resolve(OUTPUT_DIR, `.catalog-source-${Date.now()}.json`);
  const catalogManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    path: pack.catalogKey,
    sha256: pack.catalogSha256,
    bytes: pack.catalogStat.size,
  };
  await (
    await import('node:fs/promises')
  ).writeFile(catalogManifestPath, `${JSON.stringify(catalogManifest)}\n`, 'utf8');
  try {
    await putObject(
      config,
      'catalog-source-manifest.json',
      catalogManifestPath,
      'application/json; charset=utf-8',
      'no-cache',
    );
  } finally {
    await (await import('node:fs/promises')).rm(catalogManifestPath, { force: true });
  }

  console.log('Publishing cover-pack.json…');
  const manifestEtag = await putObject(
    config,
    'cover-pack.json',
    pack.manifestPath,
    'application/json; charset=utf-8',
    'no-cache',
  );
  console.log(`Manifest published (${manifestEtag}).`);

  const removed = await removeOldCoverArchives(config, pack.archiveKey);
  if (removed.length)
    console.log(`Removed ${removed.length.toLocaleString('en-US')} obsolete cover package(s).`);
  else console.log('No obsolete cover packages found.');
  console.log(
    'Cover package is live. The active manifest was published before obsolete archives were removed.',
  );
}

main().catch((error) => {
  console.error(`Cover package publish failed: ${error.message}`);
  process.exitCode = 1;
});
