import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateCatalog } from './build-catalog.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, 'data', 'catalog-source.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

validateCatalog(catalog);

function hasValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return hasValue(value.url);
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function missing(field) {
  return catalog.items.filter((item) => !hasValue(item[field]));
}

function sample(items, limit = 12) {
  return items.slice(0, limit).map((item) => ({ id: item.id, title: item.title, rank: item.rank }));
}

function normalizedIdentity(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collisionGroups(keyFor) {
  const groups = new Map();
  for (const item of catalog.items) {
    const key = keyFor(item);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

const pace = missing('pace');
const commitment = missing('commitment');
const sourceUrl = missing('sourceUrl');
const repeatedTitles = collisionGroups((item) => normalizedIdentity(item.title));
const duplicateIdentities = collisionGroups((item) =>
  [normalizedIdentity(item.title), item.year, normalizedIdentity(item.type)].join('\u0000'),
);
const duplicateLookups = collisionGroups((item) =>
  [
    item.api,
    String(item.lookupTitle || '')
      .trim()
      .toLocaleLowerCase(),
  ].join('\u0000'),
).filter((group) => new Set(group.map((item) => item.id)).size > 1);
const tierBandMismatches = catalog.items.filter(
  (item) => item.quality_band && item.tier && item.quality_band !== item.tier,
);
const report = {
  catalog: {
    version: catalog.version,
    titles: catalog.items.length,
    collections: catalog.collections.length,
    franchises: catalog.franchises.length,
    sources: catalog.sources.length,
  },
  optionalEditorialGaps: {
    pace: { count: pace.length, sample: sample(pace) },
    commitment: { count: commitment.length, sample: sample(commitment) },
    sourceUrl: { count: sourceUrl.length, sample: sample(sourceUrl) },
  },
  identity: {
    repeatedCanonicalTitles: repeatedTitles.length,
    duplicateTitleYearTypeIdentities: duplicateIdentities.length,
    duplicateProviderLookups: duplicateLookups.length,
    tierBandMismatches: tierBandMismatches.length,
  },
  note: 'Optional gaps are reported for editorial review. They do not fabricate values or make a validated catalog fail.',
};

console.log(JSON.stringify(report, null, 2));
