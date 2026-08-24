import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePort } from '../scripts/runtime.js';
import {
  generateKeyPairSync,
  randomBytes,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
} from 'node:crypto';
import { buildCatalog, validateCatalog } from '../scripts/build-catalog.js';
import {
  applyCorrectionPackage,
  parseCorrectionCode,
  validateCorrectionPackage,
} from '../scripts/catalog-corrections.js';
import { applyReleaseUpdatePackage, previewReleaseUpdatePackage } from '../scripts/release-updates.js';

// Runtime paths and resource limits
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = dirname(__dirname);
const PUBLIC = join(ROOT, 'public');
const PRIVATE = join(ROOT, '.userlist-keys');
const CACHE_DIR = join(ROOT, '.cache');
const DATA_DIR = join(ROOT, 'data');
const LOCAL_DATA_DIR = join(DATA_DIR, 'local');
const LOCAL_USER_DATA = join(LOCAL_DATA_DIR, 'user-data.json');
const LOCAL_CACHE_DATA = join(LOCAL_DATA_DIR, 'cache.json');
const LEGACY_COVER_DIR = join(ROOT, 'covers');
const CATALOG_SOURCE = join(DATA_DIR, 'catalog-source.json');
const CATALOG_DATABASE = join(DATA_DIR, 'catalog.sqlite');
const PORT = parsePort(process.env.PORT);
const HOST = process.env.UAI_HOST || '127.0.0.1';
const USERLIST_SCHEMA = 3;
const MAX_BODY = 1024 * 1024;
const MAX_LOCAL_DATA_BODY = 10 * 1024 * 1024;
const META_TTL = 1000 * 60 * 60 * 24 * 30;
const SERIES_REFRESH_TTL = 1000 * 60 * 60 * 24;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const LATEST_RELEASE_API = 'https://api.github.com/repos/Firehawk52/ultimate-animation-index/releases/latest';
const RELEASE_BASE_URL = 'https://github.com/Firehawk52/ultimate-animation-index/releases/tag/';
const RELEASE_TTL = 1000 * 60 * 60;
const TRUST_DOCKER_CLIENT = process.env.UAI_TRUST_DOCKER_CLIENT === '1';
const UPDATE_SUPPORTED = existsSync(join(ROOT, '.git'));
const UPDATE_TOKEN = randomBytes(24).toString('base64url');
let updateRunning = false;
let catalogDatabase = null;

mkdirSync(PRIVATE, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOCAL_DATA_DIR, { recursive: true });
let coverDirectory = join(DATA_DIR, 'covers');
if (existsSync(LEGACY_COVER_DIR) && !existsSync(coverDirectory)) {
  try {
    renameSync(LEGACY_COVER_DIR, coverDirectory);
    console.log('Moved the cover cache from covers/ to data/covers/.');
  } catch {}
}
mkdirSync(coverDirectory, { recursive: true });
if (existsSync(LEGACY_COVER_DIR)) {
  try {
    let copied = 0;
    for (const name of readdirSync(LEGACY_COVER_DIR)) {
      const source = join(LEGACY_COVER_DIR, name);
      const destination = join(coverDirectory, name);
      if (!statSync(source).isFile() || existsSync(destination)) continue;
      copyFileSync(source, destination);
      copied += 1;
    }
    if (copied) console.log(`Copied ${copied} legacy covers into data/covers/.`);
  } catch (error) {
    console.warn(`Could not copy every legacy cover: ${error.message}`);
  }
}
const COVER_DIR = coverDirectory;
mkdirSync(COVER_DIR, { recursive: true });

// Installation-specific UserList signing identity
const privPath = join(PRIVATE, 'ed25519-private.pem');
const pubPath = join(PRIVATE, 'ed25519-public.pem');
if (!existsSync(privPath) || !existsSync(pubPath)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
}
const PRIVATE_KEY = readFileSync(privPath, 'utf8');
const publicKeyPem = readFileSync(pubPath, 'utf8');
const publicDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
const KEY_ID = createHash('sha256').update(publicDer).digest('hex').slice(0, 16);
const PUBLIC_DER_CODE = b64url(publicDer);

// Persistent metadata cache
const cachePath = join(CACHE_DIR, 'metadata.json');
let metadataCache = {};
try {
  metadataCache = JSON.parse(readFileSync(cachePath, 'utf8'));
} catch {}
let cacheTimer = null;
// A failed image download should not leave a title without a cover for the full
// metadata TTL. Retry later, while still avoiding repeated provider requests.
const MISSING_COVER_RETRY_TTL = 1000 * 60 * 60;
function persistCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try {
      writeFileSync(cachePath, `${JSON.stringify(metadataCache, null, 2)}\n`);
    } catch {}
  }, 500);
}

// Cached GitHub release check. A network failure never prevents the local app from loading.
let releaseCache = { checkedAt: 0, data: null };
function versionParts(value) {
  const match = String(value || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}
export function isNewerVersion(latest, current) {
  const next = versionParts(latest);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}
async function getLatestRelease() {
  if (releaseCache.data && Date.now() - releaseCache.checkedAt < RELEASE_TTL) return releaseCache.data;
  const response = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Ultimate-Animation-Index',
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error('release-check-failed');
  const release = await response.json();
  const parts = versionParts(release.tag_name);
  if (!parts) throw new Error('release-check-failed');
  const latest = parts.join('.');
  releaseCache = {
    checkedAt: Date.now(),
    data: {
      latest,
      releaseUrl: `${RELEASE_BASE_URL}${encodeURIComponent(`v${latest}`)}`,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    },
  };
  return releaseCache.data;
}

// Shared HTTP helpers and security headers
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function isSameOriginRequest(req) {
  try {
    const origin = new URL(req.headers.origin || '');
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch {
    return false;
  }
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isTrustedLocalRequest(req) {
  return isLoopbackRequest(req) || TRUST_DOCKER_CLIENT;
}

async function readCatalogSource() {
  const catalog = JSON.parse(await readFile(CATALOG_SOURCE, 'utf8'));
  return validateCatalog(catalog);
}

async function applyCatalogCorrectionCode(code) {
  const current = await readCatalogSource();
  const input = parseCorrectionCode(code);
  const { catalog, correction } = applyCorrectionPackage(current, input);
  validateCatalog(catalog);
  const temporary = `${CATALOG_SOURCE}.next`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await rename(temporary, CATALOG_SOURCE);
  buildCatalog();
  return correction;
}

async function applyReleaseUpdates(input, selectedUpdateIds) {
  const current = await readCatalogSource();
  const result = applyReleaseUpdatePackage(current, input, selectedUpdateIds);
  // Validate before replacing the source file: no selected change can leave a partial catalog behind.
  validateCatalog(result.catalog);
  const temporary = `${CATALOG_SOURCE}.next`;
  await writeFile(temporary, `${JSON.stringify(result.catalog, null, 2)}\n`, 'utf8');
  await rename(temporary, CATALOG_SOURCE);
  buildCatalog();
  return result;
}

function restartServerAfterUpdate() {
  server.close(() => {
    const replacement = spawn(process.execPath, [join(ROOT, 'scripts', 'start.js')], {
      cwd: ROOT,
      detached: true,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    replacement.unref();
    process.exit(0);
  });
  setTimeout(() => server.closeAllConnections?.(), 180).unref();
}

async function readBody(req, maxBytes = MAX_BODY) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid-json');
  }
}

async function readLocalUserData() {
  try {
    const data = JSON.parse(await readFile(LOCAL_USER_DATA, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.storage) return {};
    return data.storage;
  } catch {
    return {};
  }
}

async function writeLocalUserData(storage) {
  const temporary = `${LOCAL_USER_DATA}.next`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), storage }, null, 2)}\n`,
    'utf8',
  );
  await rename(temporary, LOCAL_USER_DATA);
}

async function readLocalCacheData() {
  try {
    const data = JSON.parse(await readFile(LOCAL_CACHE_DATA, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.storage) return {};
    return data.storage;
  } catch {
    return {};
  }
}

async function writeLocalCacheData(storage) {
  const temporary = `${LOCAL_CACHE_DATA}.next`;
  await writeFile(
    temporary,
    `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), storage }, null, 2)}\n`,
    'utf8',
  );
  await rename(temporary, LOCAL_CACHE_DATA);
}

// UserList schema validation and signatures
const allowedRoot = new Set(['v', 'created', 'opinions', 'titles']);
const allowedTitle = new Set([
  'id',
  'title',
  'year',
  'type',
  'origin',
  'api',
  'lookupTitle',
  'externalId',
  'genres',
  'content',
  'coverSource',
]);
const allowedContent = new Set(['sex', 'nudity', 'violence', 'gore', 'disturbing', 'tags']);
const allowedOpinion = new Set(['id', 'verdict']);
const safeId = /^[matwc]:[A-Za-z0-9._:-]{1,150}$/;
function safeText(value, max, required = false) {
  if (value == null || value === '') return required ? null : '';
  if (typeof value !== 'string') return null;
  const s = value.normalize('NFKC').trim();
  if (!s || s.length > max) return null;
  if (/[<>\u0000-\u001F\u007F]/.test(s)) return null;
  if (/javascript\s*:/i.test(s)) return null;
  return s;
}
function exactKeys(obj, allowed) {
  return (
    obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => allowed.has(k))
  );
}
function validateContent(content) {
  if (!exactKeys(content, allowedContent)) throw new Error('invalid-title');
  const levels = {};
  for (const key of ['sex', 'nudity', 'violence', 'gore', 'disturbing']) {
    const value = Number(content[key] ?? 0);
    if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error('invalid-title');
    levels[key] = value;
  }
  if (!Array.isArray(content.tags) || content.tags.length > 20) throw new Error('invalid-title');
  const seenTags = new Set();
  const tags = [];
  for (const rawTag of content.tags) {
    const tag = safeText(rawTag, 40, true);
    const key = tag?.toLowerCase();
    if (!tag || seenTags.has(key)) throw new Error('invalid-title');
    seenTags.add(key);
    tags.push(tag);
  }
  return { ...levels, tags };
}
function validateCoverSource(source) {
  if (source == null) return null;
  if (!exactKeys(source, new Set(['url', 'status', 'checkedAt']))) throw new Error('invalid-title');
  const url = safeText(source.url, 2000, false);
  const status = safeText(source.status, 16, true);
  const checkedAt = safeText(source.checkedAt, 64, false);
  if (!['verified', 'dead', 'pending', 'wrong'].includes(status)) throw new Error('invalid-title');
  if ((status === 'wrong' && url) || (status !== 'wrong' && (!url || !allowedCoverUrl(url))))
    throw new Error('invalid-title');
  if (checkedAt && !Number.isFinite(Date.parse(checkedAt))) throw new Error('invalid-title');
  return { url, status, checkedAt };
}
function validatePayload(input) {
  if (!exactKeys(input, allowedRoot)) throw new Error('invalid-schema');
  if (input.v !== 1) throw new Error('unsupported-version');
  if (!Array.isArray(input.opinions) || !Array.isArray(input.titles)) throw new Error('invalid-schema');
  if (input.opinions.length > 3000 || input.titles.length > 1500) throw new Error('too-many-items');
  const seenOpinions = new Set();
  const opinions = [];
  for (const o of input.opinions) {
    if (
      !exactKeys(o, allowedOpinion) ||
      typeof o.id !== 'string' ||
      !safeId.test(o.id) ||
      !['recommend', 'avoid'].includes(o.verdict)
    )
      throw new Error('invalid-opinion');
    if (seenOpinions.has(o.id)) throw new Error('duplicate-opinion');
    seenOpinions.add(o.id);
    opinions.push({ id: o.id, verdict: o.verdict });
  }
  const seenTitles = new Set();
  const titles = [];
  for (const t of input.titles) {
    if (!exactKeys(t, allowedTitle) || typeof t.id !== 'string' || !safeId.test(t.id))
      throw new Error('invalid-title');
    if (seenTitles.has(t.id)) throw new Error('duplicate-title');
    seenTitles.add(t.id);
    const title = safeText(t.title, 180, true);
    const type = safeText(t.type, 50, true);
    const origin = safeText(t.origin || 'Unknown', 80, true);
    const lookupTitle = safeText(t.lookupTitle || title, 180, true);
    const api = ['anilist', 'tvmaze', 'wiki', 'none'].includes(t.api) ? t.api : null;
    const externalId = safeText(String(t.externalId ?? ''), 80, false);
    const hasGenres = Object.hasOwn(t, 'genres');
    const hasContent = Object.hasOwn(t, 'content');
    const hasCoverSource = Object.hasOwn(t, 'coverSource');
    const genres = hasGenres ? safeText(t.genres, 500, false) : '';
    const content = hasContent ? validateContent(t.content) : null;
    const coverSource = hasCoverSource ? validateCoverSource(t.coverSource) : null;
    const year = Number(t.year || 0);
    if (
      !title ||
      !type ||
      !origin ||
      !lookupTitle ||
      !api ||
      !Number.isInteger(year) ||
      year < 0 ||
      year > 2200
    )
      throw new Error('invalid-title');
    const normalizedTitle = { id: t.id, title, year, type, origin, api, lookupTitle, externalId };
    if (hasGenres) normalizedTitle.genres = genres;
    if (hasContent) normalizedTitle.content = content;
    if (coverSource) normalizedTitle.coverSource = coverSource;
    titles.push(normalizedTitle);
  }
  const created = safeText(input.created || new Date().toISOString(), 64, true);
  if (!created) throw new Error('invalid-created');
  return { v: 1, created, opinions, titles };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('invalid-base64');
  const buf = Buffer.from(s, 'base64url');
  if (buf.toString('base64url') !== s) throw new Error('invalid-base64');
  return buf;
}
function signPayload(payload) {
  const canonical = JSON.stringify(validatePayload(payload));
  const raw = Buffer.from(canonical, 'utf8');
  if (raw.length > 512 * 1024) throw new Error('payload-too-large');
  const sig = cryptoSign(null, raw, PRIVATE_KEY);
  return `UWL.${KEY_ID}.${PUBLIC_DER_CODE}.${b64url(raw)}.${b64url(sig)}`;
}
function verifyCode(code) {
  if (typeof code !== 'string' || code.length > 800000) throw new Error('invalid-code');
  const parts = code.trim().split('.');
  if (parts[0] !== 'UWL' || parts.length !== 5) throw new Error('not-userlist-code');
  const format = 'UWL';
  const keyId = parts[1];
  if (!/^[a-f0-9]{16}$/.test(keyId)) throw new Error('invalid-code');
  const senderPublicDer = fromB64url(parts[2]);
  if (senderPublicDer.length > 128) throw new Error('invalid-code');
  if (createHash('sha256').update(senderPublicDer).digest('hex').slice(0, 16) !== keyId)
    throw new Error('invalid-code');
  let verificationKey;
  try {
    verificationKey = createPublicKey({ key: senderPublicDer, type: 'spki', format: 'der' });
  } catch {
    throw new Error('invalid-code');
  }
  if (verificationKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid-code');
  const raw = fromB64url(parts[3]);
  const sig = fromB64url(parts[4]);
  if (raw.length > 512 * 1024 || sig.length > 256) throw new Error('invalid-code');
  if (!cryptoVerify(null, raw, verificationKey, sig)) throw new Error('signature-failed');
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('invalid-json');
  }
  return { payload: validatePayload(parsed), format, keyId };
}

function htmlToText(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Remote artwork validation and local cover storage
const coverInflight = new Map();
const COVER_HOSTS = [
  /(^|\.)anilist\.co$/i,
  /(^|\.)myanimelist\.net$/i,
  /(^|\.)tvmaze\.com$/i,
  /(^|\.)wikimedia\.org$/i,
];
function allowedCoverUrl(raw = '') {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && COVER_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
function coverExtension(contentType = '', raw = '') {
  const ct = String(contentType).split(';')[0].trim().toLowerCase();
  const byType = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
  };
  if (byType[ct]) return byType[ct];
  try {
    const ext = extname(new URL(raw).pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'].includes(ext)
      ? ext === '.jpeg'
        ? '.jpg'
        : ext
      : '';
  } catch {
    return '';
  }
}
async function localizeCover(rawUrl = '', { verifyRemote = false } = {}) {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/covers/')) {
    const local = join(COVER_DIR, rawUrl.slice('/covers/'.length));
    return existsSync(local) ? rawUrl : '';
  }
  if (!allowedCoverUrl(rawUrl)) return '';
  const key = createHash('sha256').update(rawUrl).digest('hex').slice(0, 32);
  if (!verifyRemote) {
    for (const ext of ['.jpg', '.png', '.webp', '.avif', '.gif']) {
      if (existsSync(join(COVER_DIR, `${key}${ext}`))) return `/covers/${key}${ext}`;
    }
  }
  if (coverInflight.has(key)) return coverInflight.get(key);
  const job = (async () => {
    try {
      const r = await fetch(rawUrl, {
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1',
          'User-Agent': 'UltimateAnimationIndex/5.0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return '';
      const finalUrl = r.url || rawUrl;
      if (!allowedCoverUrl(finalUrl)) return '';
      const type = r.headers.get('content-type') || '';
      const ext = coverExtension(type, finalUrl);
      if (!ext || !/^image\//i.test(type)) return '';
      const declared = Number(r.headers.get('content-length') || 0);
      if (declared && declared > MAX_COVER_BYTES) return '';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_COVER_BYTES) return '';
      const file = join(COVER_DIR, `${key}${ext}`);
      await writeFile(file, buf, { flag: 'wx' }).catch((e) => {
        if (e?.code !== 'EEXIST') throw e;
      });
      return `/covers/${key}${ext}`;
    } catch {
      return '';
    } finally {
      coverInflight.delete(key);
    }
  })();
  coverInflight.set(key, job);
  return job;
}
async function localizeMetadataArtwork(data) {
  if (!data || typeof data !== 'object') return data;
  const remoteCover = data.coverRemote || data.cover || '';
  const remoteBanner = data.bannerRemote || data.banner || '';
  let cover = data.cover || '',
    banner = data.banner || '';
  if (remoteCover && !String(cover).startsWith('/covers/')) cover = await localizeCover(remoteCover);
  else if (
    String(cover).startsWith('/covers/') &&
    !existsSync(join(COVER_DIR, String(cover).slice('/covers/'.length)))
  )
    cover = await localizeCover(remoteCover);
  // Banners remain remote metadata for now; cards and dialog fall back to the cached local cover.
  if (banner && !String(banner).startsWith('/covers/')) banner = '';
  return {
    ...data,
    cover: cover || '',
    banner: banner || '',
    coverRemote: remoteCover || '',
    bannerRemote: remoteBanner || '',
  };
}
function normMetaTitle(s = '') {
  return String(s)
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .replace(/ß/g, 'ss')
    .replace(/ø/gi, 'o')
    .replace(/þ/gi, 'th')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Metadata provider adapters
const ANILIST_FIELDS = `id title{romaji english native} coverImage{extraLarge large} bannerImage seasonYear format status episodes duration genres tags{name rank isMediaSpoiler} averageScore siteUrl description(asHtml:false) isAdult studios(isMain:true){nodes{name}}`;
const ANILIST_SERIES_FIELDS = `id idMal title{romaji english native} coverImage{extraLarge large} seasonYear startDate{year month day} format status episodes duration siteUrl relations{edges{relationType(version:2) node{id type format}}}`;

function contentLabels(labels = []) {
  const relevant =
    /hentai|erotica|ecchi|nudity|sexual content|sexual violence|explicit sex|violence|gore|horror|torture|rape|suicide|self[- ]harm|body horror|warfare/i;
  return [
    ...new Map(
      labels
        .filter((label) => relevant.test(String(label)))
        .map((label) => [String(label).toLowerCase(), String(label)]),
    ).values(),
  ].slice(0, 20);
}

export function estimateContentRatings({
  isAdult = false,
  rating = '',
  genres = [],
  tags = [],
  description = '',
} = {}) {
  const content = { sex: 0, nudity: 0, violence: 0, gore: 0, disturbing: 0, tags: [] };
  const labels = [...genres, ...tags.map((tag) => (typeof tag === 'string' ? tag : tag?.name))]
    .filter(Boolean)
    .map(String);
  const haystack = `${labels.join(' ')} ${rating} ${description}`.toLowerCase();
  const tagRank = (pattern) =>
    Math.max(
      0,
      ...tags.map((tag) =>
        pattern.test(String(typeof tag === 'string' ? tag : tag?.name || '')) ? Number(tag?.rank) || 60 : 0,
      ),
    );
  const rankedLevel = (pattern, fallback = 0) => {
    const rank = tagRank(pattern);
    if (!rank) return fallback;
    if (rank >= 90) return 5;
    if (rank >= 75) return 4;
    if (rank >= 55) return 3;
    return 2;
  };
  const has = (pattern) => pattern.test(haystack);
  const set = (key, value) => {
    content[key] = Math.max(content[key], value);
  };

  if (isAdult || has(/\b(rx|hentai)\b/)) {
    set('sex', 5);
    set('nudity', 5);
  }
  if (has(/\berotica\b|sexual content|explicit sex/)) set('sex', rankedLevel(/erotica|sexual content/i, 4));
  if (has(/\becchi\b|suggestive/)) {
    set('sex', 2);
    set('nudity', 2);
  }
  if (has(/nudity|nude scenes?/)) set('nudity', rankedLevel(/nudity/i, 3));
  if (has(/graphic violence|extreme violence|brutal violence/)) set('violence', 5);
  else if (has(/\bviolence\b|martial arts|warfare/)) set('violence', rankedLevel(/violence|warfare/i, 3));
  else if (has(/\baction\b|military/)) set('violence', 1);
  if (has(/\bgore\b|gory|graphic dismemberment/)) {
    set('gore', rankedLevel(/gore|dismemberment/i, 4));
    set('violence', 4);
  }
  if (has(/body horror|torture|rape|sexual violence|suicide|self[- ]harm|human trafficking/))
    set('disturbing', rankedLevel(/body horror|torture|rape|suicide|self.harm/i, 4));
  else if (has(/psychological|horror|trauma|abuse/)) set('disturbing', 2);
  if (/\br\+|r - 17\+|rated r\b/i.test(rating)) {
    set('sex', 2);
    set('violence', 2);
    set('disturbing', 1);
  }

  content.tags = contentLabels(labels);
  return content;
}

function fromAniListMedia(m, title) {
  if (!m) throw new Error('not-found');
  return {
    source: 'anilist',
    externalId: String(m.id),
    canonicalTitle: m.title?.english || m.title?.romaji || title,
    altTitle: m.title?.romaji || '',
    cover: m.coverImage?.extraLarge || m.coverImage?.large || '',
    banner: m.bannerImage || '',
    year: m.seasonYear || 0,
    format: m.format || '',
    status: m.status || '',
    episodes: m.episodes || 0,
    duration: m.duration || 0,
    genres: m.genres || [],
    score: m.averageScore || 0,
    siteUrl: m.siteUrl || '',
    description: htmlToText(m.description || ''),
    studio: m.studios?.nodes?.[0]?.name || '',
    isAdult: !!m.isAdult,
    content: estimateContentRatings({
      isAdult: !!m.isAdult,
      genres: m.genres || [],
      tags: m.tags || [],
      description: htmlToText(m.description || ''),
    }),
  };
}
async function fetchAniList(query, variables) {
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    const e = new Error(`anilist-${r.status}`);
    e.status = r.status;
    e.retryAfter = r.headers.get('retry-after') || '';
    throw e;
  }
  const j = await r.json();
  if (j.errors?.length) throw new Error('anilist-graphql');
  return j.data || {};
}

export function fromAniListSeriesMedia(media) {
  if (!media?.id) return null;
  const onePart = ['MOVIE', 'SPECIAL', 'OVA', 'ONA'].includes(media.format);
  return {
    id: String(media.id),
    provider: 'anilist',
    title: media.title?.english || media.title?.romaji || `AniList ${media.id}`,
    altTitle: media.title?.romaji || '',
    year: media.seasonYear || media.startDate?.year || 0,
    startDate: [media.startDate?.year, media.startDate?.month, media.startDate?.day]
      .map((value) => String(value || 0).padStart(2, '0'))
      .join('-'),
    format: media.format || '',
    status: media.status || '',
    episodes: Number(media.episodes) || (onePart ? 1 : 0),
    duration: Number(media.duration) || 0,
    cover: media.coverImage?.extraLarge || media.coverImage?.large || '',
    siteUrl: media.siteUrl || '',
    malId: Number(media.idMal) || 0,
    relations: (media.relations?.edges || [])
      .filter((edge) => {
        if (edge?.node?.type !== 'ANIME') return false;
        if (['PREQUEL', 'SEQUEL'].includes(edge.relationType)) return true;
        return edge.relationType === 'SIDE_STORY' && ['OVA', 'ONA', 'SPECIAL'].includes(edge.node.format);
      })
      .map((edge) => ({ id: String(edge.node.id), type: edge.relationType })),
  };
}

function seriesCandidateScore(candidate, title) {
  const target = normMetaTitle(title);
  const names = [candidate.title, candidate.altTitle].filter(Boolean).map(normMetaTitle);
  const exact = names.some((name) => name === target);
  let score = exact ? 100 : names.some((name) => name.includes(target) || target.includes(name)) ? 60 : 0;
  if (candidate.format === 'TV' || candidate.format === 'TV_SHORT' || candidate.type === 'Animation')
    score += 12;
  if (candidate.year) score += 2;
  return score;
}

function normalizeSeriesCandidates(candidates, title) {
  return candidates
    .filter((candidate) => candidate?.provider && candidate?.id && candidate?.title)
    .map((candidate) => ({ ...candidate, score: seriesCandidateScore(candidate, title) }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.year || 0) - Number(left.year || 0) ||
        String(left.title).localeCompare(String(right.title)),
    )
    .slice(0, 8)
    .map(({ score, ...candidate }) => candidate);
}

async function listAniListSeriesCandidates(title) {
  const data = await fetchAniList(
    `query($search:String!){Page(page:1,perPage:8){media(search:$search,type:ANIME){${ANILIST_SERIES_FIELDS}}}}`,
    { search: title },
  );
  return normalizeSeriesCandidates(
    (data.Page?.media || [])
      .map(fromAniListSeriesMedia)
      .filter(Boolean)
      .map((entry) => ({
        provider: 'anilist',
        id: entry.id,
        title: entry.title,
        altTitle: entry.altTitle,
        year: entry.year,
        format: entry.format,
        status: entry.status,
        episodes: entry.episodes,
        cover: entry.cover,
      })),
    title,
  );
}

export function anilistSeriesNeedsRefresh(group) {
  return (group?.entries || []).some((entry) =>
    ['RELEASING', 'NOT_YET_RELEASED', 'HIATUS'].includes(entry.status),
  );
}

export function tvMazeSeriesNeedsRefresh(group) {
  return group?.showStatus !== 'Ended';
}

let lastJikanEpisodeRequest = 0;
async function waitForJikanEpisodeSlot() {
  const wait = Math.max(0, 380 - (Date.now() - lastJikanEpisodeRequest));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastJikanEpisodeRequest = Date.now();
}

async function getJikanEpisodeTitles(malId, expectedEpisodes = 0) {
  const id = Number(malId) || 0;
  const expected = Math.max(0, Number(expectedEpisodes) || 0);
  if (!id) return [];

  const key = `episodes:jikan:v2:${id}`;
  const cached = metadataCache[key];
  const cachedTitles = Array.isArray(cached?.data) ? cached.data : [];
  const cacheFresh = cached?.ts && Date.now() - cached.ts < 1000 * 60 * 60 * 24;
  if (cachedTitles.length && ((expected && cachedTitles.length >= expected) || cacheFresh)) {
    return expected ? cachedTitles.slice(0, expected) : cachedTitles;
  }

  const titles = [];
  let page = 1;
  let hasNextPage = true;

  try {
    while (hasNextPage && page <= 50) {
      await waitForJikanEpisodeSlot();
      let response = await fetch(`https://api.jikan.moe/v4/anime/${id}/episodes?page=${page}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });

      if (response.status === 429) {
        const retryAfter = Math.max(1, Number(response.headers.get('retry-after')) || 1);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await waitForJikanEpisodeSlot();
        response = await fetch(`https://api.jikan.moe/v4/anime/${id}/episodes?page=${page}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
      }

      if (!response.ok) throw new Error(`jikan-episodes-${response.status}`);
      const body = await response.json();
      const rows = Array.isArray(body.data) ? body.data : [];

      for (const episode of rows) {
        const number = Number(episode?.mal_id) || titles.length + 1;
        if (number < 1) continue;
        while (titles.length < number) titles.push('');
        titles[number - 1] = String(
          episode?.title || episode?.title_romanji || episode?.title_japanese || '',
        ).trim();
      }

      hasNextPage = Boolean(body.pagination?.has_next_page);
      if (expected && titles.length >= expected) break;
      page += 1;
    }

    const normalized = expected ? titles.slice(0, expected) : titles;
    metadataCache[key] = { ts: Date.now(), data: normalized };
    persistCacheSoon();
    return normalized;
  } catch {
    return expected ? cachedTitles.slice(0, expected) : cachedTitles;
  }
}

async function fetchAniListSeriesNodes(ids) {
  if (!ids.length) return [];
  const definitions = ids.map((_, index) => `$id${index}:Int!`).join(',');
  const fields = ids
    .map((_, index) => `m${index}:Media(id:$id${index},type:ANIME){${ANILIST_SERIES_FIELDS}}`)
    .join('\n');
  const variables = Object.fromEntries(ids.map((id, index) => [`id${index}`, Number(id)]));
  const data = await fetchAniList(`query(${definitions}){${fields}}`, variables);
  return ids.map((_, index) => fromAniListSeriesMedia(data[`m${index}`])).filter(Boolean);
}

async function getAniListSeries(title, selectedId = '') {
  const selected = /^\d+$/.test(String(selectedId)) ? String(selectedId) : '';
  const key = `series:anilist:v6:${normMetaTitle(title)}:${selected || 'auto'}`;
  const cached = metadataCache[key];
  // Finished and cancelled series remain cached indefinitely. Active series are
  // refreshed at most once per day, even when users reopen their tracker.
  if (
    cached?.data &&
    (!anilistSeriesNeedsRefresh(cached.data) || Date.now() - cached.ts < SERIES_REFRESH_TTL)
  )
    return cached.data;

  const rootData = selected
    ? await fetchAniList(`query($id:Int!){Media(id:$id,type:ANIME){${ANILIST_SERIES_FIELDS}}}`, {
        id: Number(selected),
      })
    : await fetchAniList(
        `query($search:String!){Media(search:$search,type:ANIME){${ANILIST_SERIES_FIELDS}}}`,
        { search: title },
      );
  const root = fromAniListSeriesMedia(rootData.Media);
  if (!root) throw new Error('not-found');
  const entries = new Map([[root.id, root]]);
  const queued = new Set(root.relations.map((relation) => relation.id));

  while (queued.size && entries.size < 30) {
    const ids = [...queued].filter((id) => !entries.has(id)).slice(0, 8);
    ids.forEach((id) => queued.delete(id));
    if (!ids.length) break;
    const rows = await fetchAniListSeriesNodes(ids);
    for (const row of rows) {
      entries.set(row.id, row);
      for (const relation of row.relations) {
        if (!entries.has(relation.id)) queued.add(relation.id);
      }
    }
  }

  const localized = [];
  for (const entry of entries.values()) {
    localized.push({
      ...entry,
      episodeTitles: await getJikanEpisodeTitles(entry.malId, entry.episodes),
      cover: await localizeCover(entry.cover),
      relations: undefined,
    });
  }
  localized.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      (a.year || 9999) - (b.year || 9999) ||
      Number(a.id) - Number(b.id),
  );
  const result = {
    source: 'anilist',
    rootId: root.id,
    title,
    entries: localized,
    refreshOnOpen: anilistSeriesNeedsRefresh({ entries: localized }),
  };
  metadataCache[key] = { ts: Date.now(), data: result };
  persistCacheSoon();
  return result;
}

export function fromTVMazeSeries(show) {
  if (!show?.id) return null;
  const episodes = Array.isArray(show._embedded?.episodes) ? show._embedded.episodes : [];
  const bySeason = new Map();
  for (const episode of episodes) {
    const season = Number.isInteger(episode?.season) ? episode.season : 0;
    if (!bySeason.has(season)) bySeason.set(season, []);
    bySeason.get(season).push(episode);
  }
  const mappedStatus =
    show.status === 'Ended'
      ? 'FINISHED'
      : show.status === 'Running'
        ? 'RELEASING'
        : show.status === 'In Development'
          ? 'NOT_YET_RELEASED'
          : 'HIATUS';
  const entries = [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, rows]) => {
      const dates = rows
        .map((episode) => episode.airdate)
        .filter(Boolean)
        .sort();
      const year = dates[0] ? Number(dates[0].slice(0, 4)) : 0;
      return {
        id: `${show.id}:season:${season}`,
        provider: 'tvmaze',
        seasonNumber: season,
        title: season ? `${show.name} Season ${season}` : `${show.name} Specials`,
        altTitle: show.name || '',
        year,
        startDate: dates[0] || '',
        format: season ? 'TV' : 'SPECIAL',
        status: mappedStatus,
        episodes: rows.length,
        duration: Number(show.averageRuntime || show.runtime) || 0,
        cover: show.image?.original || show.image?.medium || '',
        siteUrl: show.url || show.officialSite || '',
        episodeTitles: rows.map((episode) => String(episode.name || '').trim()),
      };
    });
  return {
    source: 'tvmaze',
    rootId: String(show.id),
    title: show.name || '',
    showStatus: show.status || '',
    refreshOnOpen: show.status !== 'Ended',
    entries,
  };
}

async function getTVMazeSeries(title, selectedId = '') {
  const selected = /^\d+$/.test(String(selectedId)) ? String(selectedId) : '';
  const key = `series:tvmaze:v3:${normMetaTitle(title)}:${selected || 'auto'}`;
  const cached = metadataCache[key];
  if (cached?.data && (!tvMazeSeriesNeedsRefresh(cached.data) || Date.now() - cached.ts < SERIES_REFRESH_TTL))
    return cached.data;

  let candidates;
  if (selected) {
    candidates = [{ id: selected }];
  } else {
    const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'UltimateAnimationIndex/2.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`tvmaze-${response.status}`);
    const target = normMetaTitle(title);
    candidates = (await response.json())
      .map((row) => row?.show)
      .filter((show) => show?.id)
      .sort((left, right) => {
        const score = (show) => {
          const name = normMetaTitle(show.name);
          let value = name === target ? 100 : name.includes(target) || target.includes(name) ? 60 : 0;
          if (show.type === 'Animation') value += 20;
          if (show.status === 'Ended') value += 8;
          if (show.premiered) value += 3;
          return value;
        };
        return score(right) - score(left);
      });
  }
  for (const candidate of candidates.slice(0, 6)) {
    const details = await fetch(
      `https://api.tvmaze.com/shows/${encodeURIComponent(candidate.id)}?embed=episodes`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'UltimateAnimationIndex/2.0' },
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!details.ok) continue;
    const result = fromTVMazeSeries(await details.json());
    if (!result?.entries.length) continue;
    for (const entry of result.entries) entry.cover = await localizeCover(entry.cover);
    metadataCache[key] = { ts: Date.now(), data: result };
    persistCacheSoon();
    return result;
  }
  throw new Error('not-found');
}

async function listTVMazeSeriesCandidates(title) {
  const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'UltimateAnimationIndex/2.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`tvmaze-${response.status}`);
  return normalizeSeriesCandidates(
    (await response.json())
      .map((row) => row?.show)
      .filter((show) => show?.id)
      .map((show) => ({
        provider: 'tvmaze',
        id: String(show.id),
        title: show.name || '',
        altTitle: '',
        year: show.premiered ? Number(String(show.premiered).slice(0, 4)) : 0,
        format: show.type || '',
        status: show.status || '',
        episodes: 0,
        cover: show.image?.medium || show.image?.original || '',
        type: show.type || '',
      })),
    title,
  );
}

async function getSeriesCandidates(kind, title) {
  const providers = kind === 'anilist' ? ['anilist', 'tvmaze'] : ['tvmaze', 'anilist'];
  for (const provider of providers) {
    try {
      const candidates =
        provider === 'anilist'
          ? await listAniListSeriesCandidates(title)
          : await listTVMazeSeriesCandidates(title);
      if (!candidates.length) continue;
      const target = normMetaTitle(title);
      const exact = candidates.filter((candidate) =>
        [candidate.title, candidate.altTitle].filter(Boolean).some((name) => normMetaTitle(name) === target),
      );
      return {
        provider,
        candidates,
        requiresChoice: exact.length > 1 || (!exact.length && candidates.length > 1),
      };
    } catch {}
  }
  return { provider: '', candidates: [], requiresChoice: false };
}

async function getSeriesWithFallback(kind, title, selection = {}) {
  const requestedProvider = ['anilist', 'tvmaze'].includes(selection.provider) ? selection.provider : '';
  const requestedId = /^\d+$/.test(String(selection.id || '')) ? String(selection.id) : '';
  const providers = requestedProvider
    ? [requestedProvider]
    : kind === 'anilist'
      ? ['anilist', 'tvmaze']
      : ['tvmaze', 'anilist'];
  let lastError = null;
  for (const provider of providers) {
    try {
      const selectedId = provider === requestedProvider ? requestedId : '';
      const data =
        provider === 'anilist'
          ? await getAniListSeries(title, selectedId)
          : await getTVMazeSeries(title, selectedId);
      if (Array.isArray(data?.entries) && data.entries.length) return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('not-found');
}
async function metaAniList(title) {
  const query = `query($s:String){Media(search:$s,type:ANIME){${ANILIST_FIELDS}}}`;
  const data = await fetchAniList(query, { s: title });
  return fromAniListMedia(data.Media, title);
}
async function metaAniListById(id, title) {
  const data = await fetchAniList(`query($id:Int!){Media(id:$id,type:ANIME){${ANILIST_FIELDS}}}`, {
    id: Number(id),
  });
  return fromAniListMedia(data.Media, title);
}
async function metaAniListBatch(titles) {
  if (!titles.length) return [];
  const defs = titles.map((_, i) => `$s${i}:String`).join(',');
  const fields = titles.map((_, i) => `m${i}:Media(search:$s${i},type:ANIME){${ANILIST_FIELDS}}`).join('\n');
  const variables = Object.fromEntries(titles.map((t, i) => [`s${i}`, t]));
  const data = await fetchAniList(`query(${defs}){${fields}}`, variables);
  return titles.map((title, i) => {
    try {
      return fromAniListMedia(data[`m${i}`], title);
    } catch {
      return null;
    }
  });
}
async function metaJikan(title) {
  const r = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=5&sfw=false`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`jikan-${r.status}`);
  const j = await r.json();
  const rows = Array.isArray(j.data) ? j.data : [];
  if (!rows.length) throw new Error('not-found');
  const target = normMetaTitle(title);
  const ranked = rows
    .map((m) => {
      const names = [m.title, m.title_english, ...(m.titles || []).map((x) => x.title)]
        .filter(Boolean)
        .map(normMetaTitle);
      let score = names.includes(target) ? 100 : 0;
      score += Math.max(...names.map((n) => (n.includes(target) || target.includes(n) ? 30 : 0)), 0);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);
  const m = ranked[0].m;
  return {
    source: 'jikan',
    externalId: String(m.mal_id || ''),
    canonicalTitle: m.title_english || m.title || title,
    altTitle: m.title || '',
    cover:
      m.images?.webp?.large_image_url ||
      m.images?.jpg?.large_image_url ||
      m.images?.webp?.image_url ||
      m.images?.jpg?.image_url ||
      '',
    banner: '',
    year: m.year || m.aired?.prop?.from?.year || 0,
    format: m.type || '',
    status: m.status || '',
    episodes: m.episodes || 0,
    duration: 0,
    genres: [...(m.genres || []), ...(m.explicit_genres || []), ...(m.themes || [])]
      .map((x) => x.name)
      .filter(Boolean),
    score: m.score ? Math.round(m.score * 10) : 0,
    siteUrl: m.url || '',
    description: htmlToText(m.synopsis || ''),
    studio: m.studios?.[0]?.name || '',
    isAdult:
      /rx|hentai/i.test(m.rating || '') ||
      (m.explicit_genres || []).some((x) => /hentai/i.test(x.name || '')),
    content: estimateContentRatings({
      isAdult:
        /rx|hentai/i.test(m.rating || '') ||
        (m.explicit_genres || []).some((x) => /hentai/i.test(x.name || '')),
      rating: m.rating || '',
      genres: [...(m.genres || []), ...(m.explicit_genres || []), ...(m.themes || [])].map((x) => x.name),
      description: m.synopsis || '',
    }),
  };
}
async function metaWiki(title) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title)}&srlimit=1&format=json&utf8=1`;
  const sr = await fetch(searchUrl, {
    headers: { 'User-Agent': 'UltimateAnimationIndex/5.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!sr.ok) throw new Error(`wiki-${sr.status}`);
  const sj = await sr.json();
  const hit = sj.query?.search?.[0];
  if (!hit) throw new Error('not-found');
  const detail = `https://en.wikipedia.org/w/api.php?action=query&pageids=${encodeURIComponent(hit.pageid)}&prop=extracts|pageimages|info&exintro=1&explaintext=1&inprop=url&piprop=thumbnail|original&pithumbsize=1200&format=json&utf8=1`;
  const rr = await fetch(detail, {
    headers: { 'User-Agent': 'UltimateAnimationIndex/5.0' },
    signal: AbortSignal.timeout(12000),
  });
  if (!rr.ok) throw new Error(`wiki-detail-${rr.status}`);
  const j = await rr.json();
  const m = j.query?.pages?.[String(hit.pageid)];
  if (!m) throw new Error('not-found');
  const extract = m.extract || '';
  const yearMatch = extract.match(/\b(19|20)\d{2}\b/);
  return {
    source: 'wikipedia',
    externalId: String(m.pageid || hit.pageid || ''),
    canonicalTitle: m.title || title,
    cover: m.original?.source || m.thumbnail?.source || '',
    banner: '',
    year: yearMatch ? Number(yearMatch[0]) : 0,
    format: 'Film',
    status: '',
    episodes: 0,
    duration: 0,
    genres: [],
    score: 0,
    siteUrl: m.fullurl || '',
    description: extract,
    studio: '',
    content: estimateContentRatings({ description: extract }),
  };
}
async function metaTVMaze(title) {
  const r = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`tvmaze-${r.status}`);
  const m = await r.json();
  return metadataFromTVMazeShow(m, title);
}
async function metaTVMazeById(id, title) {
  const r = await fetch(`https://api.tvmaze.com/shows/${encodeURIComponent(id)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`tvmaze-${r.status}`);
  return metadataFromTVMazeShow(await r.json(), title);
}
async function metadataFromTVMazeShow(m, title) {
  let data = {
    source: 'tvmaze',
    externalId: String(m.id),
    canonicalTitle: m.name || title,
    cover: m.image?.original || m.image?.medium || '',
    banner: '',
    year: m.premiered ? Number(m.premiered.slice(0, 4)) : 0,
    format: 'TV',
    status: m.status || '',
    episodes: 0,
    duration: m.runtime || m.averageRuntime || 0,
    genres: m.genres || [],
    score: m.rating?.average ? Math.round(m.rating.average * 10) : 0,
    siteUrl: m.officialSite || m.url || '',
    description: htmlToText(m.summary || ''),
    studio: m.network?.name || m.webChannel?.name || '',
    content: estimateContentRatings({ genres: m.genres || [], description: m.summary || '' }),
  };
  if (!data.cover) {
    try {
      const ir = await fetch(`https://api.tvmaze.com/shows/${encodeURIComponent(m.id)}/images`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (ir.ok) {
        const imgs = await ir.json();
        const poster =
          (Array.isArray(imgs) ? imgs : []).find(
            (x) => x.type === 'poster' && x.resolutions?.original?.url,
          ) || (Array.isArray(imgs) ? imgs : []).find((x) => x.resolutions?.original?.url);
        if (poster) data.cover = poster.resolutions.original.url;
      }
    } catch {}
  }
  if (!data.cover) {
    try {
      const w = await metaWiki(title);
      data = {
        ...w,
        ...data,
        cover: w.cover || '',
        banner: w.banner || '',
        description: data.description || w.description,
        siteUrl: data.siteUrl || w.siteUrl,
      };
    } catch {}
  }
  return data;
}
function cacheKey(kind, title, externalId = '') {
  const id = String(externalId || '').trim();
  return id ? `${kind}:id:${id}` : `${kind}:${String(title).toLowerCase()}`;
}
function cacheGet(kind, title, externalId = '') {
  const hit = metadataCache[cacheKey(kind, title, externalId)];
  if (!hit || Date.now() - hit.ts >= META_TTL) return null;
  const d = hit.data;
  if (!d?.cover && Date.now() - hit.ts >= MISSING_COVER_RETRY_TTL) return null;
  if (d?.cover && !String(d.cover).startsWith('/covers/')) return null;
  if (d?.cover?.startsWith('/covers/') && !existsSync(join(COVER_DIR, d.cover.slice('/covers/'.length))))
    return null;
  if (d && d.contentEstimateVersion !== 1) {
    d.content = d.content
      ? { ...d.content, tags: contentLabels(d.content.tags || []) }
      : estimateContentRatings({
          isAdult: !!d.isAdult,
          genres: d.genres || [],
          description: d.description || '',
        });
    d.contentEstimateVersion = 1;
    persistCacheSoon();
  }
  return d;
}
function cachePut(kind, title, data, externalId = '') {
  // Provider fallbacks can legitimately return metadata without artwork. Never
  // let that blank response discard a cover URL or local cover we already know.
  const previous = metadataCache[cacheKey(kind, title, externalId)]?.data;
  if (previous) {
    if (!data?.cover && previous.cover) data = { ...data, cover: previous.cover };
    if (!data?.coverRemote && previous.coverRemote) data = { ...data, coverRemote: previous.coverRemote };
    if (!data?.banner && previous.banner) data = { ...data, banner: previous.banner };
    if (!data?.bannerRemote && previous.bannerRemote) data = { ...data, bannerRemote: previous.bannerRemote };
  }
  if (data?.content) data.contentEstimateVersion = 1;
  metadataCache[cacheKey(kind, title, externalId)] = { ts: Date.now(), data };
  persistCacheSoon();
  return data;
}
async function retryCachedArtwork(kind, title, externalId = '') {
  const cached = metadataCache[cacheKey(kind, title, externalId)]?.data;
  if (!cached || cached.cover || !cached.coverRemote) return null;
  const refreshed = await localizeMetadataArtwork(cached);
  if (!refreshed.cover) return null;
  return cachePut(kind, title, refreshed, externalId);
}
async function getMetadata(kind, title, externalId = '') {
  const cached = cacheGet(kind, title, externalId);
  if (cached) return cached;
  // When metadata is already known, retry its original artwork URL before
  // asking a fallback provider. This avoids replacing a good AniList cover URL
  // with an unrelated or blank fallback when a provider is temporarily down.
  const recoveredArtwork = await retryCachedArtwork(kind, title, externalId);
  if (recoveredArtwork) return recoveredArtwork;
  const previous = metadataCache[cacheKey(kind, title, externalId)]?.data;
  let data;
  if (kind === 'anilist') {
    try {
      data = externalId ? await metaAniListById(externalId, title) : await metaAniList(title);
    } catch {
      try {
        data = await metaJikan(title);
      } catch {
        data = await metaWiki(title);
      }
    }
    if (!data.cover && data.source !== 'jikan') {
      try {
        const j = await metaJikan(title);
        data = { ...data, cover: j.cover || data.cover, siteUrl: data.siteUrl || j.siteUrl };
      } catch {}
    }
    if (!data.cover) {
      try {
        const w = await metaWiki(title);
        data = {
          ...w,
          ...data,
          cover: w.cover || '',
          description: data.description || w.description,
          siteUrl: data.siteUrl || w.siteUrl,
        };
      } catch {}
    }
  } else if (kind === 'tvmaze')
    data = externalId ? await metaTVMazeById(externalId, title) : await metaTVMaze(title);
  else if (kind === 'wiki') data = await metaWiki(title);
  else throw new Error('unsupported-metadata-kind');
  if (!data.cover && previous?.cover) data.cover = previous.cover;
  if (!data.coverRemote && previous?.coverRemote) data.coverRemote = previous.coverRemote;
  if (!data.banner && previous?.banner) data.banner = previous.banner;
  if (!data.bannerRemote && previous?.bannerRemote) data.bannerRemote = previous.bannerRemote;
  data = await localizeMetadataArtwork(data);
  return cachePut(kind, title, data, externalId);
}
async function mapWithConcurrency(values, limit, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}
async function getMetadataBatch(items) {
  const results = [];
  const misses = [];
  for (const it of items) {
    const cached = cacheGet(it.kind, it.title, it.externalId);
    if (cached) results.push({ key: it.key, data: cached });
    else misses.push(it);
  }
  const ani = misses.filter((x) => x.kind === 'anilist' && !x.externalId);
  const byExternalId = misses.filter((x) => x.externalId);
  const other = misses.filter((x) => x.kind !== 'anilist' && !x.externalId);
  if (ani.length) {
    let rows = [];
    try {
      rows = await metaAniListBatch(ani.map((x) => x.title));
    } catch {
      rows = new Array(ani.length).fill(null);
    }
    const resolved = await mapWithConcurrency(ani, 4, async (it, i) => {
      const previous = metadataCache[cacheKey(it.kind, it.title, it.externalId)]?.data;
      const recoveredArtwork = await retryCachedArtwork(it.kind, it.title, it.externalId);
      if (recoveredArtwork) {
        return { key: it.key, data: recoveredArtwork };
      }
      let data = rows[i];
      if (!data || !data.cover) {
        try {
          const j = await metaJikan(it.title);
          data = data ? { ...data, cover: j.cover || data.cover, siteUrl: data.siteUrl || j.siteUrl } : j;
        } catch {}
      }
      if (!data || !data.cover) {
        try {
          const w = await metaWiki(it.title);
          data = data
            ? {
                ...w,
                ...data,
                cover: w.cover || '',
                description: data.description || w.description,
                siteUrl: data.siteUrl || w.siteUrl,
              }
            : w;
        } catch {}
      }
      if (data) {
        if (!data.cover && previous?.cover) data.cover = previous.cover;
        if (!data.coverRemote && previous?.coverRemote) data.coverRemote = previous.coverRemote;
        if (!data.banner && previous?.banner) data.banner = previous.banner;
        if (!data.bannerRemote && previous?.bannerRemote) data.bannerRemote = previous.bannerRemote;
        data = await localizeMetadataArtwork(data);
        cachePut(it.kind, it.title, data, it.externalId);
        return { key: it.key, data };
      }
      return { key: it.key, error: 'not-found' };
    });
    results.push(...resolved);
  }
  const remaining = [...other, ...byExternalId];
  const resolved = await mapWithConcurrency(remaining, 4, async (it) => {
    try {
      return { key: it.key, data: await getMetadata(it.kind, it.title, it.externalId) };
    } catch (e) {
      return { key: it.key, error: e?.message || 'not-found' };
    }
  });
  results.push(...resolved);
  return results;
}

function normalizeCatalogQuery(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function openCatalogDatabase() {
  if (catalogDatabase) return catalogDatabase;
  if (!existsSync(CATALOG_DATABASE)) buildCatalog();
  catalogDatabase = new DatabaseSync(CATALOG_DATABASE, { readOnly: true });
  return catalogDatabase;
}

function catalogMeta(key, fallback = '') {
  try {
    return (
      openCatalogDatabase().prepare('SELECT value FROM catalog_meta WHERE key = ?').get(key)?.value ??
      fallback
    );
  } catch {
    return fallback;
  }
}

function catalogEntity(kind, fallback) {
  try {
    const value = openCatalogDatabase()
      .prepare('SELECT data_json FROM catalog_entities WHERE kind = ?')
      .get(kind)?.data_json;
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function catalogPersonalProgress(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
  const allowed = new Set(['Not started', 'Watching', 'Completed', 'On hold', 'Dropped']);
  return new Map(
    Object.entries(raw)
      .slice(0, 20_000)
      .filter(([id, value]) => /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)+$/i.test(id) && value)
      .map(([id, value]) => [
        id,
        {
          status: allowed.has(value.status) ? value.status : 'Not started',
          rating: Math.max(0, Math.min(10, Number(value.rating) || 0)),
        },
      ]),
  );
}

// List views only need the fields used to paint a card and queue a metadata
// lookup.  Keeping award evidence, long notes and provider fields out of the
// first-page response is what keeps a 10,000+ title catalog responsive.  The
// complete record remains available through /api/catalog/title/:id when a
// user opens that title.
function catalogListItem(item = {}) {
  const awards = Array.isArray(item.awards)
    ? item.awards.map((award) => ({
        programKey: award?.programKey || '',
        result: award?.result || '',
      }))
    : [];
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    type: item.type,
    origin: item.origin,
    genres: item.genres,
    tier: item.tier,
    quality_band: item.quality_band,
    rank: item.rank,
    api: item.api,
    lookupTitle: item.lookupTitle,
    externalId: item.externalId,
    content: item.content,
    scores: item.scores,
    fit_score: item.fit_score,
    aliases: item.aliases,
    awards,
    catalogSummary: true,
  };
}

function catalogPage(search = {}, rawProgress = {}) {
  const database = openCatalogDatabase();
  const progress = catalogPersonalProgress(rawProgress);
  const scope = ['master', 'mature', 'kids'].includes(search.scope) ? search.scope : 'master';
  const offset = Math.max(0, Math.min(Number.parseInt(search.offset, 10) || 0, 100_000));
  const limit = Math.max(1, Math.min(Number.parseInt(search.limit, 10) || 60, 120));
  const allowedSort = new Set([
    'rank',
    'overall',
    'production',
    'story',
    'emotional',
    'year',
    'title',
    'myrating',
  ]);
  const sort = allowedSort.has(search.sort) ? search.sort : 'rank';
  const order = search.order === 'asc' ? 'asc' : 'desc';
  const where = [];
  const params = [];
  const requestedIds = Array.isArray(search.ids)
    ? [...new Set(search.ids.filter((id) => typeof id === 'string' && id.length <= 240))].slice(0, 20_000)
    : [];
  if (requestedIds.length) {
    where.push(`id IN (${requestedIds.map(() => '?').join(', ')})`);
    params.push(...requestedIds);
  } else if (search.onlyIds === true) {
    where.push('0 = 1');
  }
  if (scope === 'mature') where.push('is_mature = 1');
  if (scope === 'kids') where.push('is_kids = 1');
  const matureMode = String(search.matureMode || 'all');
  if (scope === 'mature' && matureMode === 'hentai')
    where.push("(LOWER(data_json) LIKE '%\"hentai\"%' OR LOWER(type) LIKE '%hentai%')");
  if (scope === 'mature' && matureMode === 'ecchi')
    where.push("(LOWER(data_json) LIKE '%\"ecchi\"%' OR LOWER(data_json) LIKE '%ecchi%')");
  if (scope === 'mature' && matureMode === 'erotic')
    where.push("(LOWER(data_json) LIKE '%\"erotic\"%' OR LOWER(data_json) LIKE '%sex comedy%')");
  if (scope === 'mature' && matureMode === 'gore')
    where.push("(json_extract(data_json, '$.content.gore') >= 4 OR LOWER(data_json) LIKE '%\"gore\"%')");
  if (scope === 'mature' && matureMode === 'violence')
    where.push(
      "(json_extract(data_json, '$.content.violence') >= 5 OR LOWER(data_json) LIKE '%extreme violence%')",
    );
  if (scope === 'mature' && matureMode === 'disturbing')
    where.push(
      "(json_extract(data_json, '$.content.disturbing') >= 5 OR LOWER(data_json) LIKE '%\"disturbing\"%')",
    );
  if (search.q) {
    where.push('search_text LIKE ?');
    params.push(`%${normalizeCatalogQuery(search.q)}%`);
  }
  if (search.tier) {
    where.push('tier = ?');
    params.push(String(search.tier));
  }
  if (search.type) {
    where.push('type = ?');
    params.push(String(search.type));
  }
  if (search.genre) {
    where.push('id IN (SELECT title_id FROM title_genres WHERE genre = ?)');
    params.push(String(search.genre));
  }
  if (search.region) {
    where.push('id IN (SELECT title_id FROM title_origins WHERE region = ?)');
    params.push(String(search.region));
  }
  if (search.country) {
    where.push('id IN (SELECT title_id FROM title_origins WHERE country = ?)');
    params.push(String(search.country));
  }
  const completedIds = [...progress.entries()]
    .filter(([, value]) => value.status === 'Completed')
    .map(([id]) => id);
  const status = String(search.status || '');
  if (status) {
    const matchingIds = [...progress.entries()]
      .filter(([, value]) => value.status === status)
      .map(([id]) => id);
    if (status === 'Not started') {
      if (progress.size) {
        where.push(`id NOT IN (${[...progress.keys()].map(() => '?').join(', ')})`);
        params.push(...progress.keys());
      }
    } else if (matchingIds.length) {
      where.push(`id IN (${matchingIds.map(() => '?').join(', ')})`);
      params.push(...matchingIds);
    } else {
      where.push('0 = 1');
    }
  }
  if (search.hideCompleted === true || search.hideCompleted === 'true') {
    if (completedIds.length) {
      where.push(`id NOT IN (${completedIds.map(() => '?').join(', ')})`);
      params.push(...completedIds);
    }
  }
  if (search.award === 'any') where.push('has_award = 1');
  if (search.award === 'winner') where.push('data_json LIKE \'%"result":"Winner"%\'');
  if (search.award === 'nominee') where.push('data_json LIKE \'%"result":"Nominee"%\'');
  if (search.award?.startsWith('program:')) {
    where.push('data_json LIKE ?');
    params.push(`%\"programKey\":\"${String(search.award).slice('program:'.length).replaceAll('%', '')}\"%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const scoreColumn = {
    overall: 'overall',
    production: 'production',
    story: 'story',
    emotional: 'emotional',
  }[sort];
  const sortParams = [];
  let sortSql;
  if (sort === 'rank')
    sortSql =
      order === 'desc' ? 'rank IS NULL, rank ASC, title_key ASC' : 'rank IS NULL, rank DESC, title_key ASC';
  else if (sort === 'year')
    sortSql = order === 'desc' ? 'year = 0, year DESC, rank ASC' : 'year = 0, year ASC, rank ASC';
  else if (sort === 'title')
    sortSql = order === 'desc' ? 'title_key DESC, rank ASC' : 'title_key ASC, rank ASC';
  else if (sort === 'myrating') {
    const rated = [...progress.entries()].filter(([, value]) => value.rating > 0);
    const expression = rated.length
      ? `CASE id ${rated.map(() => 'WHEN ? THEN ?').join(' ')} ELSE 0 END`
      : '0';
    rated.forEach(([id, value]) => sortParams.push(id, value.rating));
    sortSql = `${expression} = 0, ${expression} ${order === 'desc' ? 'DESC' : 'ASC'}, rank ASC`;
    sortParams.push(...sortParams);
  } else sortSql = `${scoreColumn} = 0, ${scoreColumn} ${order === 'desc' ? 'DESC' : 'ASC'}, rank ASC`;
  const total = database.prepare(`SELECT COUNT(*) AS count FROM titles ${clause}`).get(...params).count;
  const rows = database
    .prepare(`SELECT data_json FROM titles ${clause} ORDER BY ${sortSql} LIMIT ? OFFSET ?`)
    .all(...params, ...sortParams, limit, offset);
  return {
    items: rows.map((row) => catalogListItem(JSON.parse(row.data_json))),
    total,
    offset,
    limit,
    scope,
    sort,
    order,
  };
}

function catalogFacets(scope = 'master') {
  const database = openCatalogDatabase();
  const titleScope = scope === 'mature' ? 'is_mature = 1' : scope === 'kids' ? 'is_kids = 1' : '';
  const scopedTitles = titleScope ? ` WHERE ${titleScope}` : '';
  const scopedTitleIds = titleScope ? ` WHERE title_id IN (SELECT id FROM titles${scopedTitles})` : '';
  const values = (sql) =>
    database
      .prepare(sql)
      .all()
      .map((row) => row.value)
      .filter(Boolean);
  const countBy = (sql) =>
    Object.fromEntries(
      database
        .prepare(sql)
        .all()
        .filter((row) => row.value)
        .map((row) => [row.value, Number(row.count) || 0]),
    );
  const countriesByRegion = {};
  database
    .prepare(
      `SELECT DISTINCT region, country FROM title_origins${scopedTitleIds}${scopedTitleIds ? ' AND' : ' WHERE'} country <> '' ORDER BY region, country COLLATE NOCASE`,
    )
    .all()
    .forEach((row) => {
      if (!countriesByRegion[row.region]) countriesByRegion[row.region] = [];
      countriesByRegion[row.region].push(row.country);
    });
  return {
    tiers: values(
      `SELECT DISTINCT tier AS value FROM titles${scopedTitles}${scopedTitles ? ' AND' : ' WHERE'} tier <> ''`,
    ),
    types: values(
      `SELECT DISTINCT type AS value FROM titles${scopedTitles}${scopedTitles ? ' AND' : ' WHERE'} type <> '' ORDER BY value COLLATE NOCASE`,
    ),
    genres: values(
      `SELECT DISTINCT genre AS value FROM title_genres${scopedTitleIds} ORDER BY value COLLATE NOCASE`,
    ),
    regions: values(
      `SELECT DISTINCT region AS value FROM title_origins${scopedTitleIds} ORDER BY value COLLATE NOCASE`,
    ),
    countries: values(
      `SELECT DISTINCT country AS value FROM title_origins${scopedTitleIds} ORDER BY value COLLATE NOCASE`,
    ),
    regionCounts: countBy(
      `SELECT region AS value, COUNT(DISTINCT title_id) AS count FROM title_origins${scopedTitleIds} GROUP BY region`,
    ),
    regionCountryCounts: countBy(
      `SELECT region AS value, COUNT(DISTINCT country) AS count FROM title_origins${scopedTitleIds} GROUP BY region`,
    ),
    countriesByRegion,
  };
}

const CATALOG_TOTAL = Number(catalogMeta('title_count', '0')) || 0;

// Background artwork cache warmer
const warmState = { running: false, total: 0, done: 0, failed: 0, startedAt: '', finishedAt: '' };
let warmRetryTimer = null;
function scheduleArtworkWarmRetry() {
  clearTimeout(warmRetryTimer);
  // Missing artwork is retried on the server, independent of browser state.
  // This gives temporarily unavailable providers time to recover without
  // requiring a restart, navigation, or an open modal.
  warmRetryTimer = setTimeout(() => warmCatalogArtwork(), MISSING_COVER_RETRY_TTL);
  warmRetryTimer.unref?.();
}
function coverFileCount() {
  try {
    return readdirSync(COVER_DIR).filter((n) => /\.(?:jpe?g|png|webp|avif|gif)$/i.test(n)).length;
  } catch {
    return 0;
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function hasLocalArtwork(kind, title) {
  const hit = metadataCache[cacheKey(kind, title)];
  const cover = hit?.data?.cover || '';
  return !!(cover.startsWith('/covers/') && existsSync(join(COVER_DIR, cover.slice('/covers/'.length))));
}
async function warmCatalogArtwork() {
  if (warmState.running) return;
  warmState.running = true;
  warmState.startedAt = new Date().toISOString();
  warmState.finishedAt = '';
  warmState.failed = 0;
  warmState.done = 0;
  try {
    const all = openCatalogDatabase()
      .prepare('SELECT id, type, title, data_json FROM titles')
      .all()
      .map((row) => JSON.parse(row.data_json))
      .filter((x) => x?.id && ['anilist', 'tvmaze', 'wiki'].includes(x.api))
      .map((x) => ({ key: x.id, kind: x.api, title: x.lookupTitle || x.title }))
      .filter((x) => !hasLocalArtwork(x.kind, x.title));
    warmState.total = all.length;
    const batchSize = 10;
    for (let i = 0; i < all.length; i += batchSize) {
      const batch = all.slice(i, i + batchSize);
      try {
        const rows = await getMetadataBatch(batch);
        warmState.failed += rows.filter((r) => r.error || !r.data?.cover).length;
      } catch {
        warmState.failed += batch.length;
      }
      warmState.done = Math.min(i + batch.length, all.length);
      if (i + batchSize < all.length) await delay(2800);
    }
  } catch (e) {
    console.warn('Artwork warm-up stopped:', e?.message || e);
  } finally {
    warmState.running = false;
    warmState.finishedAt = new Date().toISOString();
    scheduleArtworkWarmRetry();
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Static-file serving is intentionally restricted to PUBLIC.
async function serveStatic(req, res, pathName) {
  const isCover = pathName.startsWith('/covers/');
  const base = isCover ? COVER_DIR : PUBLIC;
  let rel = isCover
    ? decodeURIComponent(pathName.slice('/covers/'.length))
    : pathName === '/'
      ? 'index.html'
      : decodeURIComponent(pathName).replace(/^\/+/, '');
  const file = resolve(base, normalize(rel));
  const root = resolve(base);
  const pathFromRoot = relative(root, file);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot))
    return send(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not-file');
    const ext = extname(file);
    const etag = `W/"${st.size}-${Math.trunc(st.mtimeMs)}"`;
    const headers = {
      'Content-Type': mime[ext] || 'application/octet-stream',
      ETag: etag,
      'Cache-Control': isCover ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const data = await readFile(file);
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    send(res, 404, { error: 'not-found' });
  }
}

// API router
export const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname === '/api/version' && req.method === 'GET') {
      try {
        const latestRelease = await getLatestRelease();
        return send(res, 200, {
          ok: true,
          current: PACKAGE_VERSION,
          ...latestRelease,
          updateAvailable: isNewerVersion(latestRelease.latest, PACKAGE_VERSION),
        });
      } catch {
        return send(res, 200, {
          ok: true,
          current: PACKAGE_VERSION,
          latest: null,
          releaseUrl: null,
          updateAvailable: false,
          unavailable: true,
        });
      }
    }
    if (u.pathname === '/api/health') {
      const isLocal = isTrustedLocalRequest(req);
      return send(res, 200, {
        ok: true,
        format: 'UWL',
        version: PACKAGE_VERSION,
        updateToken: isLocal && UPDATE_SUPPORTED ? UPDATE_TOKEN : '',
        catalogWriteEnabled: isLocal,
        catalogToken: isLocal ? UPDATE_TOKEN : '',
        userListSchema: USERLIST_SCHEMA,
        keyId: KEY_ID,
        artwork: warmState,
        covers: {
          cached: coverFileCount(),
          total: CATALOG_TOTAL,
          running: warmState.running,
          processed: warmState.done,
        },
      });
    }
    if (u.pathname === '/api/catalog/bootstrap' && req.method === 'GET') {
      const page = catalogPage({ scope: u.searchParams.get('scope') || 'master', limit: 60 });
      return send(res, 200, {
        ok: true,
        sourceHash: catalogMeta('source_hash'),
        generatedAt: catalogMeta('generated_at'),
        total: CATALOG_TOTAL,
        filmCount: Number(catalogMeta('film_count', '0')) || 0,
        collectionCount: Number(catalogMeta('collection_count', '0')) || 0,
        franchiseCount: Number(catalogMeta('franchise_count', '0')) || 0,
        idMigrations: catalogEntity('idMigrations', {}),
        facets: catalogFacets(),
        scopeFacets: {
          mature: catalogFacets('mature'),
          kids: catalogFacets('kids'),
        },
        page,
      });
    }
    if (u.pathname === '/api/catalog/titles' && req.method === 'GET') {
      const search = Object.fromEntries(u.searchParams.entries());
      return send(res, 200, { ok: true, ...catalogPage(search), sourceHash: catalogMeta('source_hash') });
    }
    if (u.pathname === '/api/catalog/query' && req.method === 'POST') {
      if (!isSameOriginRequest(req)) return send(res, 403, { ok: false, error: 'catalog-query-forbidden' });
      const body = await readBody(req, MAX_LOCAL_DATA_BODY);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !body.query ||
        typeof body.query !== 'object'
      )
        return send(res, 400, { ok: false, error: 'invalid-catalog-query' });
      return send(res, 200, {
        ok: true,
        ...catalogPage(body.query, body.progress),
        sourceHash: catalogMeta('source_hash'),
      });
    }
    if (u.pathname.startsWith('/api/catalog/title/') && req.method === 'GET') {
      const id = decodeURIComponent(u.pathname.slice('/api/catalog/title/'.length));
      if (!id || id.length > 240) return send(res, 400, { ok: false, error: 'invalid-title-id' });
      const row = openCatalogDatabase().prepare('SELECT data_json FROM titles WHERE id = ?').get(id);
      return row
        ? send(res, 200, {
            ok: true,
            item: JSON.parse(row.data_json),
            sourceHash: catalogMeta('source_hash'),
          })
        : send(res, 404, { ok: false, error: 'title-not-found' });
    }
    if (u.pathname === '/api/catalog/entities' && req.method === 'GET') {
      const kind = u.searchParams.get('kind');
      if (!['collections', 'franchises'].includes(kind))
        return send(res, 400, { ok: false, error: 'invalid-catalog-entity' });
      return send(res, 200, { ok: true, kind, data: catalogEntity(kind, []) });
    }
    if (u.pathname === '/api/local-user-data' && req.method === 'GET') {
      if (!isTrustedLocalRequest(req)) return send(res, 403, { ok: false, error: 'local-data-forbidden' });
      return send(res, 200, { ok: true, storage: await readLocalUserData() });
    }
    if (u.pathname === '/api/local-user-data' && req.method === 'POST') {
      if (!isTrustedLocalRequest(req) || !isSameOriginRequest(req))
        return send(res, 403, { ok: false, error: 'local-data-forbidden' });
      const body = await readBody(req, MAX_LOCAL_DATA_BODY);
      if (
        !exactKeys(body, new Set(['storage'])) ||
        !body.storage ||
        typeof body.storage !== 'object' ||
        Array.isArray(body.storage) ||
        Object.keys(body.storage).some((key) => !key.startsWith('uai:'))
      )
        return send(res, 400, { ok: false, error: 'invalid-local-data' });
      await writeLocalUserData(body.storage);
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/local-cache-data' && req.method === 'GET') {
      if (!isTrustedLocalRequest(req)) return send(res, 403, { ok: false, error: 'local-data-forbidden' });
      return send(res, 200, { ok: true, storage: await readLocalCacheData() });
    }
    if (u.pathname === '/api/local-cache-data' && req.method === 'POST') {
      if (!isTrustedLocalRequest(req) || !isSameOriginRequest(req))
        return send(res, 403, { ok: false, error: 'local-data-forbidden' });
      const body = await readBody(req, MAX_LOCAL_DATA_BODY);
      if (
        !exactKeys(body, new Set(['storage'])) ||
        !body.storage ||
        typeof body.storage !== 'object' ||
        Array.isArray(body.storage) ||
        Object.keys(body.storage).some((key) => !key.startsWith('uai:'))
      )
        return send(res, 400, { ok: false, error: 'invalid-local-data' });
      await writeLocalCacheData(body.storage);
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/artwork/manual' && req.method === 'POST') {
      if (!isTrustedLocalRequest(req) || !isSameOriginRequest(req))
        return send(res, 403, { ok: false, error: 'artwork-forbidden' });
      const body = await readBody(req);
      const source = safeText(body?.url, 2000, true);
      if (!source || !allowedCoverUrl(source))
        return send(res, 400, { ok: false, error: 'unsupported-cover-source' });
      const cover = await localizeCover(source, { verifyRemote: body?.verify === true });
      if (!cover) return send(res, 422, { ok: false, error: 'cover-download-failed' });
      return send(res, 200, { ok: true, cover, source });
    }
    if (u.pathname === '/api/catalog/corrections/preview' && req.method === 'POST') {
      const body = await readBody(req);
      if (!exactKeys(body, new Set(['code'])) || typeof body.code !== 'string')
        return send(res, 400, { ok: false, error: 'invalid-correction-code' });
      const catalog = await readCatalogSource();
      const correction = validateCorrectionPackage(parseCorrectionCode(body.code), catalog);
      return send(res, 200, { ok: true, correction });
    }
    if (u.pathname === '/api/catalog/corrections/apply' && req.method === 'POST') {
      if (
        !isTrustedLocalRequest(req) ||
        !isSameOriginRequest(req) ||
        req.headers['x-uai-catalog-token'] !== UPDATE_TOKEN
      )
        return send(res, 403, { ok: false, error: 'catalog-write-forbidden' });
      const body = await readBody(req);
      if (!exactKeys(body, new Set(['code'])) || typeof body.code !== 'string')
        return send(res, 400, { ok: false, error: 'invalid-correction-code' });
      const correction = await applyCatalogCorrectionCode(body.code);
      return send(res, 200, {
        ok: true,
        applied: correction.entries.length,
        additions: correction.entries.filter((entry) => entry.operation === 'add').length,
      });
    }
    if (u.pathname === '/api/catalog/release-updates/preview' && req.method === 'POST') {
      const body = await readBody(req);
      if (!exactKeys(body, new Set(['package'])) || !body.package || typeof body.package !== 'object')
        return send(res, 400, { ok: false, error: 'invalid-release-update-package' });
      const catalog = await readCatalogSource();
      return send(res, 200, { ok: true, preview: previewReleaseUpdatePackage(catalog, body.package) });
    }
    if (u.pathname === '/api/catalog/release-updates/apply' && req.method === 'POST') {
      if (
        !isTrustedLocalRequest(req) ||
        !isSameOriginRequest(req) ||
        req.headers['x-uai-catalog-token'] !== UPDATE_TOKEN
      )
        return send(res, 403, { ok: false, error: 'catalog-write-forbidden' });
      const body = await readBody(req);
      if (
        !exactKeys(body, new Set(['package', 'selectedUpdateIds'])) ||
        !body.package ||
        typeof body.package !== 'object' ||
        !Array.isArray(body.selectedUpdateIds)
      )
        return send(res, 400, { ok: false, error: 'invalid-release-update-package' });
      const result = await applyReleaseUpdates(body.package, body.selectedUpdateIds);
      const unranked = result.applied.filter(
        (entry) => !result.catalog.items.find((item) => item.id === entry.id)?.rank,
      );
      return send(res, 200, {
        ok: true,
        applied: result.applied,
        summary: result.summary,
        unranked: unranked.length,
      });
    }
    if (u.pathname === '/api/update' && req.method === 'POST') {
      if (
        !UPDATE_SUPPORTED ||
        !isTrustedLocalRequest(req) ||
        !isSameOriginRequest(req) ||
        req.headers['x-uai-update-token'] !== UPDATE_TOKEN
      )
        return send(res, 403, { ok: false, error: 'update-forbidden' });
      if (updateRunning) return send(res, 409, { ok: false, error: 'update-running' });
      updateRunning = true;
      try {
        const { updateInstallation } = await import('../scripts/update.js');
        await updateInstallation({ checkRunningServer: false });
        send(res, 200, { ok: true, restart: true });
        setTimeout(restartServerAfterUpdate, 240).unref();
        return;
      } catch (error) {
        updateRunning = false;
        return send(res, 400, {
          ok: false,
          error: 'update-failed',
          message: error?.message || 'The update could not be installed.',
        });
      }
    }
    if (u.pathname === '/api/userlist/sign' && req.method === 'POST') {
      const body = await readBody(req);
      const code = signPayload(body);
      return send(res, 200, { ok: true, code, format: 'UWL', keyId: KEY_ID });
    }
    if (u.pathname === '/api/userlist/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const verified = verifyCode(body.code);
      return send(res, 200, { ok: true, ...verified });
    }
    if (u.pathname === '/api/meta/batch' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 16)
        return send(res, 400, { ok: false, error: 'invalid-batch' });
      const items = [];
      for (const raw of body.items) {
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          Object.keys(raw).some((k) => !['key', 'kind', 'title', 'externalId'].includes(k))
        )
          return send(res, 400, { ok: false, error: 'invalid-batch' });
        const key = safeText(raw.key, 180, true),
          title = safeText(raw.title, 180, true),
          kind = raw.kind,
          externalId = safeText(raw.externalId || '', 80, false);
        if (!key || !title || !['anilist', 'tvmaze', 'wiki'].includes(kind))
          return send(res, 400, { ok: false, error: 'invalid-batch' });
        if (externalId && !/^\d+$/.test(externalId))
          return send(res, 400, { ok: false, error: 'invalid-batch' });
        items.push({ key, kind, title, externalId });
      }
      const results = await getMetadataBatch(items);
      return send(res, 200, { ok: true, results });
    }
    if (u.pathname === '/api/meta' && req.method === 'GET') {
      const kind = u.searchParams.get('kind') || '';
      const title = safeText(u.searchParams.get('title') || '', 180, true);
      if (!title) return send(res, 400, { error: 'invalid-title' });
      const data = await getMetadata(kind, title);
      return send(res, 200, { ok: true, data });
    }
    if (u.pathname === '/api/series' && req.method === 'GET') {
      const kind = u.searchParams.get('kind') || '';
      const title = safeText(u.searchParams.get('title') || '', 180, true);
      if (!title) return send(res, 400, { error: 'invalid-title' });
      if (!['anilist', 'tvmaze'].includes(kind))
        return send(res, 400, { error: 'unsupported-metadata-kind' });
      const provider = u.searchParams.get('provider') || '';
      const id = safeText(u.searchParams.get('id') || '', 32, false);
      if (provider && !['anilist', 'tvmaze'].includes(provider))
        return send(res, 400, { error: 'unsupported-metadata-kind' });
      if (id && !/^\d+$/.test(id)) return send(res, 400, { error: 'invalid-series-id' });
      const data = await getSeriesWithFallback(kind, title, { provider, id });
      return send(res, 200, { ok: true, data });
    }
    if (u.pathname === '/api/series/candidates' && req.method === 'GET') {
      const kind = u.searchParams.get('kind') || '';
      const title = safeText(u.searchParams.get('title') || '', 180, true);
      if (!title) return send(res, 400, { ok: false, error: 'invalid-title' });
      if (!['anilist', 'tvmaze'].includes(kind))
        return send(res, 400, { ok: false, error: 'unsupported-metadata-kind' });
      const data = await getSeriesCandidates(kind, title);
      return send(res, 200, { ok: true, data });
    }
    if (u.pathname === '/api/resolve' && req.method === 'GET') {
      const kind = u.searchParams.get('kind') || '';
      const title = safeText(u.searchParams.get('title') || '', 180, true);
      if (!title) return send(res, 400, { error: 'invalid-title' });
      const data = await getMetadata(kind, title);
      return send(res, 200, { ok: true, data });
    }
    if (u.pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown-api' });
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    const msg = e?.message || 'server-error';
    const status = [
      'invalid-json',
      'invalid-schema',
      'unsupported-version',
      'invalid-opinion',
      'invalid-title',
      'duplicate-opinion',
      'duplicate-title',
      'too-many-items',
      'payload-too-large',
      'invalid-code',
      'not-userlist-code',
      'signature-failed',
      'invalid-base64',
      'invalid-created',
      'body-too-large',
      'invalid-batch',
      'invalid-correction-code',
      'invalid-correction-package',
      'unsupported-correction-package',
      'unknown-catalog-title',
      'catalog-correction-conflict',
      'empty-correction-package',
      'invalid-release-update-package',
      'unsupported-release-update-package',
      'release-update-add-missing-fields',
      'unreleased-editorial-update',
      'invalid-release-update-selection',
      'release-update-not-applicable',
    ].includes(msg)
      ? 400
      : 500;
    return send(res, status, { ok: false, error: msg });
  }
});
// Exported separately so integration tests can bind to an ephemeral port.
export function startServer(port = PORT, host = HOST) {
  return server.listen(port, host, () => {
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    console.log(`Ultimate Animation Index on http://localhost:${activePort} · UserList key ${KEY_ID}`);
    // A full catalog artwork crawl is intentionally opt-in. With a catalog of
    // thousands of titles it competes with visible-card lookups, generates
    // unnecessary provider traffic, and makes the artwork counter look stuck.
    // The browser queue already caches artwork for rendered and opened titles
    // and keeps doing so while the user navigates.
    setTimeout(() => {
      if (process.env.UAI_WARM_ALL_ARTWORK === '1') warmCatalogArtwork();
    }, 900);
  });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) startServer();
