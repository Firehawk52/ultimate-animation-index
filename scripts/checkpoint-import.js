import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

function archiveEntries(archive) {
  return execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
}

function archiveEntry(entries, filename) {
  const entry = entries.find((value) => value.endsWith(`/${filename}`) || value === filename);
  if (!entry) throw new Error(`Checkpoint does not contain ${filename}.`);
  return entry;
}

function readArchiveText(archive, entry) {
  return execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

function readArchiveJson(archive, entries, filename) {
  return JSON.parse(readArchiveText(archive, archiveEntry(entries, filename)));
}

function machineSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function normalizedTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceReferenceUrl(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return String(value.url || '').trim();
  return String(value || '').trim();
}

function stableImportedId(item) {
  const slug = machineSlug(item.title) || 'untitled';
  const identity = [item.title, item.year, item.type, sourceReferenceUrl(item.sourceUrl)].join('\u0000');
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  return `m:${slug}:${digest}`;
}

const V161_FIELD_REPAIRS = new Map([
  ['LEGO Star Wars: The Padawan Menace', 'https://www.starwars.com/news/lego-star-wars-history'],
  ['LEGO Star Wars: The Empire Strikes Out', 'https://www.starwars.com/news/lego-star-wars-history'],
  [
    'Zen - Grogu and Dust Bunnies',
    'https://press.disneyplus.com/news/studio-ghibli-and-lucasfilm-surprise-disney-plus-fans-zen-grogu-and-dust-bunnies-short',
  ],
  [
    'LEGO Star Wars: Rebuild the Galaxy - Pieces of the Past',
    'https://www.starwars.com/news/lego-rebuild-the-galaxy-pieces-of-the-past',
  ],
  ['Boonie Bears: Guardian Code', 'https://www.youtube.com/watch?v=BQMKxTv57FM'],
]);

const V161_LEGACY_TITLE_MIGRATIONS = new Map([
  ["Frieren: Beyond Journey's End Season 2", "Frieren: Beyond Journey's End"],
  ['Dorohedoro Season 2', 'Dorohedoro'],
  ['My Hero Academia FINAL SEASON', 'My Hero Academia'],
  ['The Apothecary Diaries Season 2', 'The Apothecary Diaries'],
  ['Jujutsu Kaisen Season 3', 'Jujutsu Kaisen'],
  ['DAN DA DAN Season 2', 'DAN DA DAN'],
  ['Uma Musume: Pretty Derby Season 2', 'Uma Musume: Pretty Derby'],
  ['GaoGaiGar', 'The King of Braves GaoGaiGar'],
  ['The Ideon', 'Space Runaway Ideon'],
  ['Captain Harlock', 'Space Pirate Captain Harlock'],
]);

function repairV161Fields(catalog) {
  const repairs = [];
  for (const item of catalog.items) {
    if (V161_FIELD_REPAIRS.has(item.title)) {
      const expectedSource = V161_FIELD_REPAIRS.get(item.title);
      if (item.sourceUrl !== expectedSource || typeof item.id !== 'string' || !item.id.includes(' '))
        throw new Error(`Unexpected v161 repair shape for ${item.title}; refusing to guess.`);
      if (!Number.isInteger(item.watch_note) || item.watch_note < 0 || item.watch_note > 10)
        throw new Error(`Unexpected v161 watch-note repair shape for ${item.title}; refusing to guess.`);
      const sourceSynopsis = item.id;
      const sourceNumericWatchNote = item.watch_note;
      item.id = stableImportedId(item);
      item.watch_note = '';
      item.sourceSynopsis = sourceSynopsis;
      item.sourceNumericWatchNote = sourceNumericWatchNote;
      repairs.push({
        title: item.title,
        fields: ['id', 'watch_note'],
        action: 'repaired swapped source fields and retained the unknown numeric source value',
      });
    }
    if (item.title === 'Treasure X' && !String(item.origin || '').trim()) {
      item.origin = 'Australia';
      item.sourceUrl = 'https://reli.sh/animation/project/treasure-x-series/';
      repairs.push({
        title: item.title,
        fields: ['origin', 'sourceUrl'],
        action: 'added verified Australian origin evidence',
      });
    }
  }
  return repairs;
}

function normalizeResearchSources(sources) {
  const normalized = [];
  const seen = new Set();
  const add = (label, url, usedFor = '') => {
    const safeLabel = String(label || '').trim();
    const safeUrl = String(url || '').trim();
    if (!safeLabel || !safeUrl) throw new Error('Research source is missing a usable label or URL.');
    const key = `${safeLabel}\u0000${safeUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push({ label: safeLabel, url: safeUrl, ...(usedFor ? { used_for: usedFor } : {}) });
  };
  for (const source of sources) {
    if (source?.label && source?.url) {
      add(source.label, source.url, source.used_for || source.use || '');
      continue;
    }
    if (Array.isArray(source?.sources)) {
      const prefix = [source.checkpoint, source.focus].filter(Boolean).join(' — ');
      source.sources.forEach((nested) =>
        add(nested.use || prefix || 'Checkpoint research source', nested.url, prefix),
      );
      continue;
    }
    throw new Error('Research source has an unsupported shape.');
  }
  return normalized;
}

export function buildLegacyIdMigrations(legacyCatalog, catalog) {
  if (!Array.isArray(legacyCatalog?.items)) return {};
  const candidates = new Map();
  for (const item of catalog.items) {
    for (const title of [item.title, ...(item.aliases || [])]) {
      const key = normalizedTitle(title);
      if (!key) continue;
      const values = candidates.get(key) || [];
      values.push(item);
      candidates.set(key, values);
    }
  }
  const migrations = {};
  const add = (oldItem, target) => {
    if (target && oldItem.id !== target.id) migrations[oldItem.id] = target.id;
  };
  for (const oldItem of legacyCatalog.items) {
    const exact = candidates.get(normalizedTitle(oldItem.title)) || [];
    if (exact.length === 1) add(oldItem, exact[0]);
  }
  for (const oldItem of legacyCatalog.items) {
    if (migrations[oldItem.id]) continue;
    const targetTitle = V161_LEGACY_TITLE_MIGRATIONS.get(oldItem.title);
    if (!targetTitle) continue;
    const target = candidates.get(normalizedTitle(targetTitle)) || [];
    if (target.length === 1) add(oldItem, target[0]);
  }
  return migrations;
}

export function verifyCheckpointChecksums(archive, entries) {
  const manifest = readArchiveJson(archive, entries, 'checksums-sha256.json');
  const mismatches = [];
  for (const [filename, expected] of Object.entries(manifest)) {
    const entry = archiveEntry(entries, filename);
    const actual = createHash('sha256').update(readArchiveText(archive, entry)).digest('hex');
    if (actual !== expected) mismatches.push(filename);
  }
  if (mismatches.length) throw new Error(`Checkpoint checksum mismatch: ${mismatches.join(', ')}`);
  return Object.keys(manifest).length;
}

export function loadCheckpoint(archive, { verifyChecksums = true } = {}) {
  if (!archive || !existsSync(archive))
    throw new Error(`Checkpoint archive not found: ${archive || '(none)'}`);
  const entries = archiveEntries(archive);
  const checksumCount = verifyChecksums ? verifyCheckpointChecksums(archive, entries) : 0;
  const catalog = readArchiveJson(archive, entries, 'working-catalog-unranked.json');
  const franchises = readArchiveJson(archive, entries, 'working-franchises.json');
  const sources = readArchiveJson(archive, entries, 'research-sources.json');
  const summary = readArchiveJson(archive, entries, 'checkpoint-summary.json');
  return { catalog, franchises, sources, summary, checksumCount };
}

export function normalizeCheckpointForRelease(checkpoint, { legacyCatalog = null } = {}) {
  const catalog = structuredClone(checkpoint.catalog);
  const version = Number(checkpoint.summary?.checkpoint);
  if (!Number.isInteger(version) || version < 1)
    throw new Error('Checkpoint summary does not contain a numeric checkpoint version.');
  if (!Array.isArray(checkpoint.franchises) || !Array.isArray(checkpoint.sources))
    throw new Error('Checkpoint franchise or research-source file has an invalid shape.');
  const repairs = repairV161Fields(catalog);
  catalog.version = version;
  catalog.franchises = checkpoint.franchises;
  catalog.sources = normalizeResearchSources(checkpoint.sources);
  catalog.ratingScale = 'ten-tier';
  catalog.importMetadata = {
    checkpoint: version,
    date: String(checkpoint.summary.date || catalog.generated || ''),
    repairs,
    normalizedResearchSources: catalog.sources.length,
  };
  const idMigrations = buildLegacyIdMigrations(legacyCatalog, catalog);
  if (Object.keys(idMigrations).length) catalog.idMigrations = idMigrations;
  return { catalog, repairs };
}
