import { createHash } from 'node:crypto';

export const RELEASE_UPDATE_FORMAT = 'UAI_RELEASE_UPDATES';
export const RELEASE_UPDATE_VERSION = 1;
export const RELEASE_UPDATE_MAX_ENTRIES = 200;

const SAFE_ID = /^[a-z][a-z0-9._:-]{1,180}$/i;
const TIERS = new Set(['F', 'E', 'D', 'C', 'C+', 'B', 'B+', 'A', 'A+', 'S']);
const REASONS = new Set([
  'new-title',
  'release-date-changed',
  'became-released',
  'metadata-enriched',
  'quality-rating-added',
  'content-rating-added',
  'release-delayed',
  'tba-dated',
]);
const PATCH_FIELDS = new Set([
  'title',
  'type',
  'origin',
  'year',
  'genres',
  'api',
  'lookupTitle',
  'externalId',
  'aliases',
  'sourceUrl',
  'provisional',
  'pace',
  'commitment',
  'caveat',
  'watch_note',
  'fit_score',
  'tier',
  'quality_band',
  'entertainment',
  'production',
  'story',
  'darkness',
  'explicitness',
  'scores',
  'content',
  'platform',
  'distributor',
  'release',
]);
const CONTENT_KEYS = ['sex', 'nudity', 'violence', 'gore', 'disturbing'];
const SCORE_KEYS = ['overall', 'entertainment', 'production', 'story', 'emotional'];
const REQUIRED_ADDITION_FIELDS = [
  'title',
  'type',
  'origin',
  'year',
  'genres',
  'api',
  'lookupTitle',
  'sourceUrl',
];

function fail(code) {
  throw new Error(code);
}
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).every((key) => keys.includes(key));
}
function text(value, max, required = false) {
  if (typeof value !== 'string') fail('invalid-release-update-package');
  const next = value.normalize('NFKC').trim();
  if ((required && !next) || next.length > max || /[<>\u0000-\u001f\u007f]/.test(next))
    fail('invalid-release-update-package');
  return next;
}
function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail('invalid-release-update-package');
  return value;
}
function timestamp(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(date.valueOf()) || !/Z$/.test(value))
    fail('invalid-release-update-package');
  return date.toISOString();
}
function dateOnly(value) {
  if (value === '' || value === null || value === undefined) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    fail('invalid-release-update-package');
  return value;
}
function safeUrl(value) {
  const next = text(value, 2000, true);
  try {
    const url = new URL(next);
    if (!['http:', 'https:'].includes(url.protocol)) fail('invalid-release-update-package');
  } catch {
    fail('invalid-release-update-package');
  }
  return next;
}
function normalizedIdentity(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function releaseStatus(value) {
  const next = text(value, 30, true).toLowerCase();
  if (!['upcoming', 'released', 'tba', 'cancelled'].includes(next)) fail('invalid-release-update-package');
  return next;
}
function normalizeRelease(value) {
  if (!exactKeys(value, ['status', 'date', 'datePrecision', 'region', 'platform', 'notes']))
    fail('invalid-release-update-package');
  const precision = text(value.datePrecision, 12, true);
  if (!['day', 'month', 'year', 'tba'].includes(precision)) fail('invalid-release-update-package');
  const result = {
    status: releaseStatus(value.status),
    date: dateOnly(value.date),
    datePrecision: precision,
    region: text(value.region, 100, false),
    platform: text(value.platform, 180, false),
    notes: text(value.notes, 1000, false),
  };
  if (result.datePrecision === 'day' && !result.date) fail('invalid-release-update-package');
  return result;
}
function normalizeScores(value) {
  if (!exactKeys(value, SCORE_KEYS)) fail('invalid-release-update-package');
  return Object.fromEntries(
    SCORE_KEYS.map((key) => [key, integer(value[key], 0, key === 'overall' ? 100 : 10)]),
  );
}
function normalizeContent(value) {
  if (!exactKeys(value, [...CONTENT_KEYS, 'tags'])) fail('invalid-release-update-package');
  if (!Array.isArray(value.tags) || value.tags.length > 30) fail('invalid-release-update-package');
  const tags = [...new Set(value.tags.map((tag) => text(tag, 60, true).toLowerCase()))];
  if (tags.length !== value.tags.length) fail('invalid-release-update-package');
  return {
    ...Object.fromEntries(CONTENT_KEYS.map((key) => [key, integer(value[key], 0, 5)])),
    tags: value.tags.map((tag) => text(tag, 60, true)),
  };
}
function normalizePatch(raw) {
  if (!object(raw) || !Object.keys(raw).length || Object.keys(raw).some((key) => !PATCH_FIELDS.has(key)))
    fail('invalid-release-update-package');
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      [
        'title',
        'type',
        'origin',
        'genres',
        'api',
        'lookupTitle',
        'externalId',
        'pace',
        'commitment',
      ].includes(key)
    )
      patch[key] = text(value, key === 'genres' ? 1000 : 240, key !== 'externalId');
    else if (['caveat', 'watch_note'].includes(key)) patch[key] = text(value, 2000, false);
    else if (key === 'sourceUrl') patch[key] = safeUrl(value);
    else if (key === 'year') patch[key] = integer(value, 0, 3000);
    else if (key === 'provisional') {
      if (typeof value !== 'boolean') fail('invalid-release-update-package');
      patch[key] = value;
    } else if (key === 'aliases') {
      if (!Array.isArray(value) || value.length > 100) fail('invalid-release-update-package');
      patch[key] = value.map((entry) => text(entry, 240, true));
    } else if (['fit_score'].includes(key)) patch[key] = integer(value, 0, 100);
    else if (['entertainment', 'production', 'story'].includes(key)) patch[key] = integer(value, 0, 10);
    else if (['darkness', 'explicitness'].includes(key)) patch[key] = integer(value, 0, 5);
    else if (['tier', 'quality_band'].includes(key)) {
      const tier = text(value, 3, true);
      if (!TIERS.has(tier)) fail('invalid-release-update-package');
      patch[key] = tier;
    } else if (key === 'scores') patch[key] = normalizeScores(value);
    else if (key === 'content') patch[key] = normalizeContent(value);
    else if (key === 'release') patch[key] = normalizeRelease(value);
    else patch[key] = text(value, 240, false);
  }
  return patch;
}
function normalizeSources(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) fail('invalid-release-update-package');
  return value.map((source) => {
    if (!exactKeys(source, ['label', 'url', 'accessedAt'])) fail('invalid-release-update-package');
    return {
      label: text(source.label, 180, true),
      url: safeUrl(source.url),
      accessedAt: timestamp(source.accessedAt),
    };
  });
}
function normalizeMatch(value) {
  if (!exactKeys(value, ['title', 'year', 'lookupTitle', 'aliases'])) fail('invalid-release-update-package');
  if (!Array.isArray(value.aliases) || value.aliases.length > 100) fail('invalid-release-update-package');
  return {
    title: text(value.title, 240, true),
    year: value.year === null ? null : integer(value.year, 0, 3000),
    lookupTitle: text(value.lookupTitle, 240, false),
    aliases: value.aliases.map((alias) => text(alias, 240, true)),
  };
}
function hasEditorialPatch(patch) {
  return [
    'fit_score',
    'tier',
    'quality_band',
    'entertainment',
    'production',
    'story',
    'darkness',
    'explicitness',
    'scores',
    'content',
  ].some((key) => key in patch);
}
function catalogStatus(item) {
  return String(item.release?.status || (item.provisional ? 'upcoming' : 'released')).toLowerCase();
}
function matchesFor(entry, catalog) {
  const items = catalog.items || [];
  if (entry.id) return items.filter((item) => item.id === entry.id);
  const title = normalizedIdentity(entry.match.title);
  const exact = items.filter(
    (item) =>
      normalizedIdentity(item.title) === title &&
      (entry.match.year === null || Number(item.year) === entry.match.year),
  );
  if (exact.length) return exact;
  const names = new Set(
    [entry.match.lookupTitle, ...entry.match.aliases, entry.match.title]
      .map(normalizedIdentity)
      .filter(Boolean),
  );
  return items.filter((item) =>
    [item.title, item.lookupTitle, ...(item.aliases || [])].some((name) =>
      names.has(normalizedIdentity(name)),
    ),
  );
}
function addAudience(item, audience) {
  const tags = [...(item.content?.tags || [])];
  const set = (name, enabled) => {
    const index = tags.findIndex((tag) => tag.toLowerCase() === name.toLowerCase());
    if (enabled && index < 0) tags.push(name);
    if (!enabled && index >= 0) tags.splice(index, 1);
  };
  if (audience.mature !== null) set('Adult Only', audience.mature);
  if (audience.forKids !== null) set('For Kids', audience.forKids);
  item.content = {
    sex: item.content?.sex ?? 0,
    nudity: item.content?.nudity ?? 0,
    violence: item.content?.violence ?? 0,
    gore: item.content?.gore ?? 0,
    disturbing: item.content?.disturbing ?? 0,
    tags,
  };
}
function deterministicId(entry) {
  const stem =
    normalizedIdentity(entry.patch.title || entry.match.title)
      .replace(/ /g, '-')
      .slice(0, 90) || 'release-title';
  return `r:${stem}:${createHash('sha256').update(entry.updateId).digest('hex').slice(0, 12)}`;
}
function diff(before, after) {
  const changes = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
      changes.push({ field: key, before: before?.[key] ?? null, after: after?.[key] ?? null });
  }
  return changes;
}

export function validateReleaseUpdatePackage(input, catalog) {
  if (!exactKeys(input, ['format', 'version', 'packageId', 'generatedAt', 'scope', 'window', 'entries']))
    fail('invalid-release-update-package');
  if (input.format !== RELEASE_UPDATE_FORMAT || input.version !== RELEASE_UPDATE_VERSION)
    fail('unsupported-release-update-package');
  const packageId = text(input.packageId, 220, true);
  const generatedAt = timestamp(input.generatedAt);
  if (text(input.scope, 120, true) !== 'curated-animation-release-monitor')
    fail('invalid-release-update-package');
  if (!exactKeys(input.window, ['from', 'to'])) fail('invalid-release-update-package');
  const window = { from: timestamp(input.window.from), to: timestamp(input.window.to) };
  if (
    Date.parse(window.from) > Date.parse(window.to) ||
    !Array.isArray(input.entries) ||
    !input.entries.length ||
    input.entries.length > RELEASE_UPDATE_MAX_ENTRIES
  )
    fail('invalid-release-update-package');
  const seen = new Set();
  const entries = input.entries.map((raw) => {
    if (
      !exactKeys(raw, [
        'updateId',
        'action',
        'id',
        'match',
        'reasons',
        'release',
        'patch',
        'audience',
        'sources',
      ])
    )
      fail('invalid-release-update-package');
    const updateId = text(raw.updateId, 220, true);
    if (seen.has(updateId)) fail('invalid-release-update-package');
    seen.add(updateId);
    if (
      !['add', 'update'].includes(raw.action) ||
      (raw.id !== null && (!SAFE_ID.test(raw.id) || typeof raw.id !== 'string'))
    )
      fail('invalid-release-update-package');
    if (raw.action === 'add' && raw.id !== null) fail('invalid-release-update-package');
    if (
      !Array.isArray(raw.reasons) ||
      !raw.reasons.length ||
      raw.reasons.length > 12 ||
      raw.reasons.some((reason) => !REASONS.has(reason))
    )
      fail('invalid-release-update-package');
    if (
      !exactKeys(raw.audience, ['mature', 'forKids']) ||
      ![true, false, null].includes(raw.audience.mature) ||
      ![true, false, null].includes(raw.audience.forKids)
    )
      fail('invalid-release-update-package');
    const entry = {
      updateId,
      action: raw.action,
      id: raw.id,
      match: normalizeMatch(raw.match),
      reasons: [...new Set(raw.reasons)],
      release: normalizeRelease(raw.release),
      patch: normalizePatch(raw.patch),
      audience: raw.audience,
      sources: normalizeSources(raw.sources),
    };
    if (entry.action === 'add' && REQUIRED_ADDITION_FIELDS.some((field) => !(field in entry.patch)))
      fail('release-update-add-missing-fields');
    if (entry.action === 'add' && hasEditorialPatch(entry.patch) && entry.release.status !== 'released')
      fail('unreleased-editorial-update');
    return entry;
  });
  return {
    format: RELEASE_UPDATE_FORMAT,
    version: RELEASE_UPDATE_VERSION,
    packageId,
    generatedAt,
    scope: input.scope,
    window,
    entries,
    catalogItems: catalog?.items?.length || 0,
  };
}

export function previewReleaseUpdatePackage(catalog, input) {
  const update = validateReleaseUpdatePackage(input, catalog);
  const entries = update.entries.map((entry) => {
    const matches = matchesFor(entry, catalog);
    if (entry.action === 'add' && matches.length)
      return {
        ...entry,
        state: 'conflict',
        matches: matches.map((item) => ({ id: item.id, title: item.title, year: item.year })),
        changes: [],
      };
    if (entry.action === 'update' && matches.length !== 1)
      return {
        ...entry,
        state: matches.length ? 'conflict' : 'invalid',
        matches: matches.map((item) => ({ id: item.id, title: item.title, year: item.year })),
        changes: [],
      };
    const before = entry.action === 'update' ? structuredClone(matches[0]) : null;
    const after =
      entry.action === 'update'
        ? structuredClone(matches[0])
        : { id: deterministicId(entry), rank: null, provisional: true };
    Object.assign(after, entry.patch);
    after.release = entry.release;
    // A release update never assigns a global rank. Newly added and still-unranked
    // records remain provisional even after their release date has passed.
    after.provisional = entry.patch.provisional ?? after.provisional ?? true;
    addAudience(after, entry.audience);
    const changes = diff(before || {}, after);
    const currentStatus = before ? catalogStatus(before) : '';
    if (
      hasEditorialPatch(entry.patch) &&
      (entry.release.status !== 'released' ||
        (currentStatus !== 'released' && entry.release.status !== 'released'))
    )
      fail('unreleased-editorial-update');
    return {
      ...entry,
      state: changes.length ? 'valid' : 'noop',
      matches: before ? [{ id: before.id, title: before.title, year: before.year }] : [],
      changes,
    };
  });
  return { ...update, entries, summary: summarizeReleaseUpdateEntries(entries) };
}

export function summarizeReleaseUpdateEntries(entries) {
  const count = (predicate) => entries.filter(predicate).length;
  return {
    newTitles: count((entry) => entry.action === 'add' && entry.state === 'valid'),
    dateChanges: count(
      (entry) =>
        entry.reasons.includes('release-date-changed') ||
        entry.reasons.includes('release-delayed') ||
        entry.reasons.includes('tba-dated'),
    ),
    becameReleased: count((entry) => entry.reasons.includes('became-released')),
    metadataUpdates: count((entry) => entry.reasons.includes('metadata-enriched')),
    qualityUpdates: count((entry) => entry.reasons.includes('quality-rating-added')),
    contentUpdates: count((entry) => entry.reasons.includes('content-rating-added')),
    mature: count((entry) => entry.audience.mature === true),
    forKids: count((entry) => entry.audience.forKids === true),
    conflicts: count((entry) => entry.state === 'conflict'),
    noops: count((entry) => entry.state === 'noop'),
  };
}

export function applyReleaseUpdatePackage(
  catalog,
  input,
  selectedUpdateIds,
  { generatedAt = new Date() } = {},
) {
  const preview = previewReleaseUpdatePackage(catalog, input);
  const selected = new Set(selectedUpdateIds || []);
  if (!selected.size || [...selected].some((id) => !preview.entries.some((entry) => entry.updateId === id)))
    fail('invalid-release-update-selection');
  const blocked = preview.entries.filter((entry) => selected.has(entry.updateId) && entry.state !== 'valid');
  if (blocked.length) fail('release-update-not-applicable');
  const next = structuredClone(catalog);
  const itemMap = new Map(next.items.map((item) => [item.id, item]));
  const applied = [];
  for (const entry of preview.entries.filter((item) => selected.has(item.updateId))) {
    const target =
      entry.action === 'update'
        ? itemMap.get(entry.matches[0].id)
        : { id: deterministicId(entry), rank: null, provisional: true };
    Object.assign(target, entry.patch);
    target.release = entry.release;
    target.provisional = entry.patch.provisional ?? target.provisional ?? true;
    addAudience(target, entry.audience);
    target.releaseSources = entry.sources;
    if (entry.action === 'add') {
      next.items.push(target);
      itemMap.set(target.id, target);
    }
    applied.push({
      updateId: entry.updateId,
      action: entry.action,
      id: target.id,
      title: target.title,
      reasons: entry.reasons,
      audience: entry.audience,
      release: entry.release,
    });
  }
  next.generated = generatedAt.toISOString().slice(0, 10);
  return {
    catalog: next,
    preview,
    applied,
    summary: summarizeReleaseUpdateEntries(preview.entries.filter((entry) => selected.has(entry.updateId))),
  };
}
