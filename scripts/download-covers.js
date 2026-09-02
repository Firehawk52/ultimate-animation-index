import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acquireCoverWriteLock } from './cover-write-lock.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = resolve(ROOT, 'data', 'catalog-source.json');
const SQLITE_PATH = resolve(ROOT, 'data', 'catalog.sqlite');
const ENV_PATH = resolve(ROOT, '.env.cover-publisher');
const OVERRIDES_PATH = resolve(ROOT, 'data', 'local', 'cover-overrides.json');
const BUILD_PATH = resolve(ROOT, 'data', 'cover-package-build');
const OUTPUT_PATH = resolve(ROOT, 'data', 'cover-package-output');
const PACKAGE_ROOT = 'cover-pack';
const REQUEST_DELAY = 280;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowIncomplete = args.has('--allow-incomplete');
const fresh = args.has('--fresh');
const retryUnresolved = args.has('--retry-unresolved');
const limitFlag = [...args].find((arg) => arg.startsWith('--limit='));
const limit = limitFlag ? Number(limitFlag.slice('--limit='.length)) : 0;

function fail(message) {
  throw new Error(message);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalize(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainingSeconds = whole % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`;
  return `${remainingSeconds}s`;
}

function progressLine({ completed, total, downloaded, unresolved, failed, startedAt, title }) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = completed / Math.max(elapsed, 1);
  const remaining = rate ? (total - completed) / rate : 0;
  const percent = total ? Math.floor((completed / total) * 100) : 100;
  const current = String(title || '')
    .replace(/\s+/g, ' ')
    .slice(0, 42);
  return [
    `${String(percent).padStart(3, ' ')}%`,
    `${completed.toLocaleString('en-US')}/${total.toLocaleString('en-US')}`,
    `saved ${downloaded.toLocaleString('en-US')}`,
    `review ${unresolved.toLocaleString('en-US')}`,
    `failed ${failed.toLocaleString('en-US')}`,
    `elapsed ${duration(elapsed)}`,
    `left ${duration(remaining)}`,
    current,
  ].join('  |  ');
}

function renderProgress(status) {
  const line = progressLine(status);
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[2K${line}`);
    return;
  }
  if (status.completed === status.total || status.completed % 25 === 0) console.log(line);
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
  const values = parseEnv(await readFile(ENV_PATH, 'utf8'));
  const apiKey = process.env.TMDB_API_KEY || values.TMDB_API_KEY || '';
  if (!apiKey) fail(`Missing TMDB_API_KEY in ${basename(ENV_PATH)}.`);
  return { apiKey };
}

async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function catalogInput() {
  const catalog = await json(SOURCE_PATH, null);
  if (!catalog || !Array.isArray(catalog.items)) fail('Invalid data/catalog-source.json.');
  return {
    items: catalog.items,
    source: 'catalog-source.json',
    // SQLite is generated and can be rebuilt while a long cover job is
    // running. Use the authored source and only the fields that affect a
    // TMDb match, so a SQLite rebuild or unrelated editorial data never
    // invalidates a resumable cover build.
    sha256: hash(
      JSON.stringify(
        catalog.items.map((item) => ({
          id: item.id,
          title: item.title || '',
          lookupTitle: item.lookupTitle || '',
          aliases: Array.isArray(item.aliases) ? item.aliases : [],
          type: item.type || '',
          year: Number(item.year) || 0,
          api: item.api || '',
          externalId: item.externalId || '',
        })),
      ),
    ),
  };
}

function mediaType(item) {
  return /film|movie|feature/i.test(String(item.type || '')) ? 'movie' : 'tv';
}

function yearFor(result, type) {
  const date = type === 'movie' ? result.release_date : result.first_air_date;
  return /^\d{4}/.test(String(date || '')) ? Number(String(date).slice(0, 4)) : 0;
}

function titleFor(result, type) {
  return type === 'movie'
    ? result.title || result.original_title || ''
    : result.name || result.original_name || '';
}

function titleMatches(item, result, type) {
  const candidates = [item.title, item.lookupTitle, ...(Array.isArray(item.aliases) ? item.aliases : [])]
    .map(normalize)
    .filter(Boolean);
  const resultTitles = [
    titleFor(result, type),
    type === 'movie' ? result.original_title : result.original_name,
  ]
    .map(normalize)
    .filter(Boolean);
  return resultTitles.some((title) => candidates.includes(title));
}

function resultSummary(result, type) {
  return {
    tmdbId: result.id,
    mediaType: type,
    title: titleFor(result, type),
    year: yearFor(result, type),
    poster: Boolean(result.poster_path),
    backdrop: Boolean(result.backdrop_path),
  };
}

async function tmdb(path, query, apiKey) {
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  if (/^eyJ/i.test(apiKey)) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set('api_key', apiKey);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`tmdb-${response.status}`);
  return response.json();
}

async function resolveTmdb(item, override, apiKey) {
  const localFile = String(override?.localFile || '').trim();
  if (localFile) {
    const submissionsRoot = resolve(ROOT, 'data', 'cover-submissions');
    const localPath = resolve(ROOT, localFile);
    if (!localPath.startsWith(`${submissionsRoot}${sep}`)) return { error: 'invalid-local-cover-file' };
    try {
      const metadata = await stat(localPath);
      if (!metadata.isFile() || !metadata.size || metadata.size > MAX_IMAGE_BYTES)
        return { error: 'invalid-local-cover-file' };
    } catch {
      return { error: 'missing-local-cover-file' };
    }
    return { type: 'local', localPath, source: 'editor-submission' };
  }
  const directUrl = String(override?.coverUrl || '').trim();
  if (directUrl) {
    let parsed;
    try {
      parsed = new URL(directUrl);
    } catch {
      return { error: 'invalid-direct-cover-url' };
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      return { error: 'invalid-direct-cover-url' };
    return { type: 'direct', directUrl, source: 'direct-url' };
  }
  const type = override?.mediaType || mediaType(item);
  if (!['movie', 'tv'].includes(type)) return { error: 'invalid-media-type' };
  if (override?.tmdbId || (item.api === 'tmdb' && /^\d+$/.test(String(item.externalId || '')))) {
    const tmdbId = Number(override?.tmdbId || item.externalId);
    const result = await tmdb(`${type}/${tmdbId}`, {}, apiKey);
    return { type, result, source: 'override' };
  }
  const searchTerms = [item.lookupTitle, item.title, ...(Array.isArray(item.aliases) ? item.aliases : [])]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .slice(0, 4);
  const matches = new Map();
  for (const term of searchTerms) {
    const response = await tmdb(`search/${type}`, { query: term, year: item.year || undefined }, apiKey);
    for (const result of Array.isArray(response.results) ? response.results.slice(0, 8) : []) {
      if (Number.isInteger(result.id)) matches.set(result.id, result);
    }
    await sleep(REQUEST_DELAY);
  }
  const exact = [...matches.values()].filter((result) => {
    if (!titleMatches(item, result, type)) return false;
    const year = yearFor(result, type);
    return !item.year || !year || Math.abs(Number(item.year) - year) <= 1;
  });
  if (exact.length !== 1) {
    return {
      error: exact.length ? 'ambiguous-exact-match' : 'no-exact-match',
      candidates: [...matches.values()].slice(0, 8).map((result) => resultSummary(result, type)),
    };
  }
  const result = await tmdb(`${type}/${exact[0].id}`, {}, apiKey);
  return { type, result, source: 'exact-title-year' };
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error(`image-${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_IMAGE_BYTES) throw new Error('image-too-large');
  let total = 0;
  const meter = new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error('image-too-large');
      controller.enqueue(chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(meter)),
    createWriteStream(destination, { flags: 'w' }),
  );
}

function run(command, commandArgs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

async function makeWebp(input, output, maxWidth, quality) {
  await run('ffmpeg', [
    '-y',
    '-i',
    input,
    '-vf',
    `scale='min(${maxWidth},iw)':-2`,
    '-c:v',
    'libwebp',
    '-q:v',
    String(quality),
    '-compression_level',
    '6',
    output,
  ]);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validReview(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray(value.unresolved) &&
    Array.isArray(value.failures)
  );
}

function reviewIds(entries) {
  return new Set(entries.map((entry) => String(entry?.id || '')).filter(Boolean));
}

async function saveCheckpoint(stage, index, review, catalog) {
  review.updatedAt = new Date().toISOString();
  review.catalog = { source: catalog.source, sha256: catalog.sha256 };
  await writeJson(resolve(stage, 'cover-index.json'), index);
  await writeJson(resolve(BUILD_PATH, 'cover-review.json'), review);
}

async function resumeBuild(stage, catalog, overrides = {}) {
  const existingIndex = await json(resolve(stage, 'cover-index.json'), null);
  const existingReview = await json(resolve(BUILD_PATH, 'cover-review.json'), null);
  if (!existingIndex && !existingReview) {
    return {
      index: { schemaVersion: 1, catalogSha256: catalog.sha256, items: {} },
      review: { schemaVersion: 1, generatedAt: new Date().toISOString(), unresolved: [], failures: [] },
      resumed: false,
    };
  }
  if (
    !existingIndex ||
    !existingIndex.items ||
    typeof existingIndex.items !== 'object' ||
    Array.isArray(existingIndex.items) ||
    !validReview(existingReview)
  ) {
    fail('The previous cover build is incomplete. Run with --fresh to start over safely.');
  }
  if (
    existingIndex.catalogSha256 !== catalog.sha256 ||
    (existingReview.catalog?.sha256 && existingReview.catalog.sha256 !== catalog.sha256)
  ) {
    // Never throw away a multi-hour download because the generated SQLite
    // file changed or a title was appended. Existing stable IDs remain valid;
    // removed IDs are pruned and only new IDs are added to the pending queue.
    const activeIds = new Set(catalog.items.map((item) => item.id));
    for (const id of Object.keys(existingIndex.items)) if (!activeIds.has(id)) delete existingIndex.items[id];
    existingReview.unresolved = existingReview.unresolved.filter((entry) => activeIds.has(entry.id));
    existingReview.failures = existingReview.failures.filter((entry) => activeIds.has(entry.id));
    existingIndex.catalogSha256 = catalog.sha256;
    existingReview.catalog = { source: catalog.source, sha256: catalog.sha256 };
    console.log(
      'Catalog identity updated; retaining existing covers and continuing with new or unresolved titles.',
    );
  }
  // An override is an explicit owner decision, so retry that title immediately
  // without requiring a broad --retry-unresolved run.
  existingReview.unresolved = retryUnresolved
    ? []
    : existingReview.unresolved.filter((entry) => !overrides[entry.id]);
  // Failed network/conversion attempts are retried on the next run. Keep only failures from the
  // active run, otherwise a recovered title would permanently block packaging.
  existingReview.failures = [];
  return { index: existingIndex, review: existingReview, resumed: true };
}

async function main() {
  const catalog = await catalogInput();
  const items = limit > 0 ? catalog.items.slice(0, limit) : catalog.items;
  if (dryRun) {
    console.log(`Catalog validated: ${items.length.toLocaleString('en-US')} titles from ${catalog.source}.`);
    console.log('Dry run complete. TMDb was not contacted and no files were written.');
    return;
  }
  const writeLock = await acquireCoverWriteLock('download-covers');
  try {
    const { apiKey } = await environment();
    const overrides = await json(OVERRIDES_PATH, {});
    const stage = resolve(BUILD_PATH, PACKAGE_ROOT);
    const posters = resolve(stage, 'posters');
    const backdrops = resolve(stage, 'backdrops');
    const temporary = resolve(BUILD_PATH, '.temporary');
    if (fresh) await rm(BUILD_PATH, { recursive: true, force: true });
    await mkdir(posters, { recursive: true });
    await mkdir(backdrops, { recursive: true });
    await mkdir(temporary, { recursive: true });
    const { index, review, resumed } = await resumeBuild(stage, catalog, overrides);
    // Overrides also replace an already packaged image, which is useful when a
    // previous TMDb match was technically valid but visually wrong.
    const overrideIds = new Set(Object.keys(overrides));
    const completedIds = new Set(
      [...Object.keys(index.items), ...reviewIds(review.unresolved)].filter((id) => !overrideIds.has(id)),
    );
    const pendingItems = items.filter((item) => !completedIds.has(item.id));
    let completed = items.length - pendingItems.length;
    let downloaded = Object.keys(index.items).length;
    const startedAt = Date.now();
    console.log(`Starting cover build for ${items.length.toLocaleString('en-US')} titles.`);
    console.log('TMDb matches must be exact. Uncertain titles are kept out of the package for review.');
    if (resumed) {
      console.log(
        `Resuming: ${completed.toLocaleString('en-US')} already recorded; ${pendingItems.length.toLocaleString('en-US')} remaining.`,
      );
    }
    for (const item of pendingItems) {
      renderProgress({
        completed,
        total: items.length,
        downloaded,
        unresolved: review.unresolved.length,
        failed: review.failures.length,
        startedAt,
        title: item.title,
      });
      try {
        const resolved = await resolveTmdb(item, overrides[item.id], apiKey);
        if (resolved.error) {
          review.unresolved.push({
            id: item.id,
            title: item.title,
            year: item.year || 0,
            reason: resolved.error,
            candidates: resolved.candidates || [],
          });
        } else if (!resolved.directUrl && !resolved.localPath && !resolved.result.poster_path) {
          review.unresolved.push({
            id: item.id,
            title: item.title,
            year: item.year || 0,
            reason: 'tmdb-result-has-no-poster',
            candidates: [resultSummary(resolved.result, resolved.type)],
          });
        } else {
          const fileKey = hash(item.id).slice(0, 32);
          const posterTemp = resolve(temporary, `${fileKey}-poster`);
          const posterRelative = `posters/${fileKey}.webp`;
          if (resolved.localPath) await cp(resolved.localPath, posterTemp);
          else
            await downloadFile(
              resolved.directUrl || `https://image.tmdb.org/t/p/original${resolved.result.poster_path}`,
              posterTemp,
            );
          await makeWebp(posterTemp, resolve(stage, posterRelative), 1400, 90);
          const entry = {
            poster: posterRelative,
            source: resolved.localPath
              ? { kind: 'editor-submission' }
              : resolved.directUrl
                ? { kind: 'direct-url' }
                : { kind: 'tmdb', id: resolved.result.id, mediaType: resolved.type, match: resolved.source },
          };
          if (!resolved.directUrl && !resolved.localPath && resolved.result.backdrop_path) {
            const backdropTemp = resolve(temporary, `${fileKey}-backdrop`);
            const backdropRelative = `backdrops/${fileKey}.webp`;
            await downloadFile(
              `https://image.tmdb.org/t/p/original${resolved.result.backdrop_path}`,
              backdropTemp,
            );
            await makeWebp(backdropTemp, resolve(stage, backdropRelative), 1920, 88);
            entry.backdrop = backdropRelative;
          }
          index.items[item.id] = entry;
          downloaded += 1;
        }
      } catch (error) {
        review.failures.push({ id: item.id, title: item.title, reason: error.message });
      }
      completed += 1;
      await saveCheckpoint(stage, index, review, catalog);
      await sleep(REQUEST_DELAY);
    }
    renderProgress({
      completed,
      total: items.length,
      downloaded,
      unresolved: review.unresolved.length,
      failed: review.failures.length,
      startedAt,
      title: 'Finalizing review file',
    });
    if (process.stdout.isTTY) process.stdout.write('\n');
    await saveCheckpoint(stage, index, review, catalog);
    if ((review.unresolved.length || review.failures.length) && !allowIncomplete) {
      console.log(
        `Stopped before packaging: ${review.unresolved.length} unresolved, ${review.failures.length} failed.`,
      );
      console.log(`Review ${resolve(BUILD_PATH, 'cover-review.json')}`);
      process.exitCode = 2;
      return;
    }
    await writeJson(resolve(stage, 'cover-index.json'), index);
    await rm(OUTPUT_PATH, { recursive: true, force: true });
    await mkdir(resolve(OUTPUT_PATH, 'packages'), { recursive: true });
    const version = `v${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
    const archiveRelative = `packages/covers-${version}.zip`;
    const archivePath = resolve(OUTPUT_PATH, archiveRelative);
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    await run(tar, ['-a', '-c', '-f', archivePath, '-C', BUILD_PATH, PACKAGE_ROOT]);
    const archiveStat = await stat(archivePath);
    const manifest = {
      schemaVersion: 1,
      version,
      generatedAt: new Date().toISOString(),
      catalog: { source: catalog.source, sha256: index.catalogSha256 },
      archive: {
        path: archiveRelative,
        sha256: hash(await readFile(archivePath)),
        bytes: archiveStat.size,
        rootDirectory: PACKAGE_ROOT,
        coverCount: Object.keys(index.items).length,
      },
    };
    await writeJson(resolve(OUTPUT_PATH, 'cover-pack.json'), manifest);
    await cp(resolve(BUILD_PATH, 'cover-review.json'), resolve(OUTPUT_PATH, 'cover-review.json'));
    console.log(`Built ${manifest.archive.coverCount.toLocaleString('en-US')} verified cover records.`);
    console.log(`Package: ${archivePath}`);
  } finally {
    await writeLock.release();
  }
}

main().catch((error) => {
  console.error(`Cover download failed: ${error.message}`);
  process.exitCode = 1;
});
