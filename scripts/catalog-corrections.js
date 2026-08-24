const FORMAT = 'ultimate-animation-index-corrections';
const SCHEMA = 1;
const PREFIX = 'UAIC.';
const SAFE_ID = /^[matwc]:[A-Za-z0-9._:-]{1,150}$/;
const SCORE_KEYS = ['overall', 'production', 'story', 'emotional'];
const CONTENT_KEYS = ['sex', 'nudity', 'violence', 'gore', 'disturbing'];

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, allowed) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

function safeText(value, max, required = true) {
  if (typeof value !== 'string') fail('invalid-correction-package');
  const text = value.normalize('NFKC').trim();
  if ((required && !text) || text.length > max || /[<>\u0000-\u001f\u007f]/.test(text))
    fail('invalid-correction-package');
  return text;
}

function integer(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail('invalid-correction-package');
  return number;
}

export function normalizeCatalogScores(value) {
  if (!exactKeys(value, SCORE_KEYS)) fail('invalid-correction-package');
  return {
    overall: integer(value.overall, 1, 100),
    production: integer(value.production, 1, 10),
    story: integer(value.story, 1, 10),
    emotional: integer(value.emotional, 1, 10),
  };
}

export function normalizeCatalogContent(value) {
  if (!exactKeys(value, [...CONTENT_KEYS, 'tags'])) fail('invalid-correction-package');
  const content = Object.fromEntries(CONTENT_KEYS.map((key) => [key, integer(value[key], 0, 5)]));
  if (!Array.isArray(value.tags) || value.tags.length > 20) fail('invalid-correction-package');
  const seen = new Set();
  content.tags = value.tags.map((raw) => {
    const tag = safeText(raw, 40);
    const key = tag.toLowerCase();
    if (seen.has(key)) fail('invalid-correction-package');
    seen.add(key);
    return tag;
  });
  return content;
}

export function catalogSnapshot(item) {
  return {
    scores: normalizeCatalogScores(Object.fromEntries(SCORE_KEYS.map((key) => [key, item.scores?.[key]]))),
    content: normalizeCatalogContent(
      Object.fromEntries([...CONTENT_KEYS, 'tags'].map((key) => [key, item.content?.[key]])),
    ),
  };
}

function normalizeValues(value) {
  if (!exactKeys(value, ['scores', 'content'])) fail('invalid-correction-package');
  return {
    scores: normalizeCatalogScores(value.scores),
    content: normalizeCatalogContent(value.content),
  };
}

function normalizeAddition(value) {
  const keys = ['year', 'type', 'origin', 'api', 'lookupTitle', 'externalId', 'genres', 'scores', 'content'];
  if (!exactKeys(value, keys)) fail('invalid-correction-package');
  const api = safeText(value.api, 20);
  if (!['anilist', 'tvmaze', 'wiki', 'none'].includes(api)) fail('invalid-correction-package');
  return {
    year: integer(value.year, 0, 2200),
    type: safeText(value.type, 80),
    origin: safeText(value.origin, 80),
    api,
    lookupTitle: safeText(value.lookupTitle, 180),
    externalId: safeText(value.externalId, 120, false),
    genres: safeText(value.genres, 500, false),
    scores: normalizeCatalogScores(value.scores),
    content: normalizeCatalogContent(value.content),
  };
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseCorrectionCode(code) {
  if (typeof code !== 'string' || !code.startsWith(PREFIX) || code.length > 900_000)
    fail('invalid-correction-code');
  try {
    return JSON.parse(Buffer.from(code.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    fail('invalid-correction-code');
  }
}

export function validateCorrectionPackage(input, catalog) {
  if (!exactKeys(input, ['format', 'schema', 'createdAt', 'catalogVersion', 'entries']))
    fail('invalid-correction-package');
  if (input.format !== FORMAT || input.schema !== SCHEMA) fail('unsupported-correction-package');
  if (!Number.isInteger(Date.parse(input.createdAt))) fail('invalid-correction-package');
  if (!Number.isInteger(input.catalogVersion) || input.catalogVersion < 1) fail('invalid-correction-package');
  if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 100)
    fail('invalid-correction-package');

  const catalogItems = new Map((catalog?.items || []).map((item) => [item.id, item]));
  const knownTitles = new Set((catalog?.items || []).map((item) => item.title.toLowerCase()));
  const seen = new Set();
  const entries = input.entries.map((raw) => {
    if (!exactKeys(raw, ['operation', 'id', 'title', 'base', 'values'])) fail('invalid-correction-package');
    const id = safeText(raw.id, 160);
    const title = safeText(raw.title, 180);
    if (!SAFE_ID.test(id) || seen.has(id)) fail('invalid-correction-package');
    seen.add(id);
    if (raw.operation === 'update') {
      const item = catalogItems.get(id);
      if (!item || item.title !== title) fail('unknown-catalog-title');
      const base = normalizeValues(raw.base);
      const values = normalizeValues(raw.values);
      if (!equal(base, catalogSnapshot(item))) fail('catalog-correction-conflict');
      if (equal(base, values)) fail('empty-correction-package');
      return { operation: 'update', id, title, base, values };
    }
    if (raw.operation === 'add') {
      if (raw.base !== null || catalogItems.has(id) || knownTitles.has(title.toLowerCase()))
        fail('catalog-correction-conflict');
      const values = normalizeAddition(raw.values);
      knownTitles.add(title.toLowerCase());
      return { operation: 'add', id, title, base: null, values };
    }
    fail('invalid-correction-package');
  });
  return {
    format: FORMAT,
    schema: SCHEMA,
    createdAt: new Date(input.createdAt).toISOString(),
    catalogVersion: input.catalogVersion,
    entries,
  };
}

function sourceTier(overall) {
  if (overall >= 95) return 'S+';
  if (overall >= 90) return 'S';
  if (overall >= 85) return 'A+';
  if (overall >= 75) return 'A';
  if (overall >= 65) return 'B+';
  return 'B';
}

function applyScores(item, values) {
  const tier = sourceTier(values.scores.overall);
  item.scores = values.scores;
  item.content = values.content;
  item.fit_score = values.scores.overall;
  item.production = values.scores.production;
  item.story = values.scores.story;
  item.tier = tier;
  item.quality_band = tier;
}

export function applyCorrectionPackage(catalog, input, { generatedAt = new Date() } = {}) {
  const correction = validateCorrectionPackage(input, catalog);
  const next = structuredClone(catalog);
  const items = new Map(next.items.map((item) => [item.id, item]));
  let nextRank = Math.max(0, ...next.items.map((item) => Number(item.rank) || 0)) + 1;
  for (const entry of correction.entries) {
    if (entry.operation === 'update') {
      applyScores(items.get(entry.id), entry.values);
      continue;
    }
    const item = {
      id: entry.id,
      title: entry.title,
      type: entry.values.type,
      origin: entry.values.origin,
      year: entry.values.year,
      genres: entry.values.genres,
      api: entry.values.api,
      lookupTitle: entry.values.lookupTitle,
      externalId: entry.values.externalId,
      provisional: false,
      aliases: [],
      sourceUrl: '',
      caveat: '',
      watch_note: '',
      rank: nextRank++,
    };
    applyScores(item, entry.values);
    next.items.push(item);
    items.set(item.id, item);
  }
  next.generated = generatedAt.toISOString().slice(0, 10);
  return { catalog: next, correction };
}

export const CATALOG_CORRECTION_FORMAT = FORMAT;
export const CATALOG_CORRECTION_SCHEMA = SCHEMA;
export const CATALOG_CORRECTION_PREFIX = PREFIX;
