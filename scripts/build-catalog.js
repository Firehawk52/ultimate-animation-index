import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildCatalogDatabase, catalogDatabaseNeedsBuild } from './catalog-store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, 'data', 'catalog-source.json');
const databaseOutputPath = join(root, 'data', 'catalog.sqlite');
const TEN_TIER_SCALE = new Set(['F', 'E', 'D', 'C', 'C+', 'B', 'B+', 'A', 'A+', 'S']);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid catalog source: ${message}`);
}

function requireText(value, location) {
  requireValue(
    typeof value === 'string' && value.trim().length > 0,
    `${location} must be a non-empty string`,
  );
}

function requireShortText(value, location, maximum = 180) {
  requireText(value, location);
  requireValue(value.trim().length <= maximum, `${location} must be ${maximum} characters or fewer`);
}

function awardSourceUrl(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return String(value.url || '').trim();
  const raw = String(value || '').trim();
  const markdownUrl = raw.match(/^\[[^\]]+\]\((https?:\/\/[^\s)]+)\)$/i)?.[1];
  return markdownUrl || raw;
}

function validateSourceReference(value, location) {
  if (value === undefined || value === null || value === '') return;
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject) {
    requireShortText(value, location, 2000);
  } else {
    optionalText(value.label, `${location}.label`, 240);
    requireShortText(value.url, `${location}.url`, 2000);
  }
  const sourceUrl = awardSourceUrl(value);
  try {
    const parsed = new URL(sourceUrl);
    requireValue(['http:', 'https:'].includes(parsed.protocol), `${location} must use http or https`);
  } catch {
    throw new Error(`Invalid catalog source: ${location} must be a valid URL or source object`);
  }
}

function validateAward(award, location) {
  requireValue(award && typeof award === 'object' && !Array.isArray(award), `${location} must be an object`);
  requireShortText(award.programKey, `${location}.programKey`, 100);
  requireValue(
    /^[a-z0-9][a-z0-9:-]*$/i.test(award.programKey),
    `${location}.programKey must use letters, numbers, colons or hyphens`,
  );
  for (const key of ['organization', 'award', 'category', 'result', 'cycle', 'sourceTitle'])
    requireShortText(award[key], `${location}.${key}`);
  requireValue(['Winner', 'Nominee'].includes(award.result), `${location}.result must be Winner or Nominee`);
  optionalText(award.sourceWorkDetail, `${location}.sourceWorkDetail`, 500);
  if (award.edition !== undefined && award.edition !== null && award.edition !== '')
    requireValue(
      Number.isInteger(award.edition) && award.edition > 0,
      `${location}.edition must be a positive integer`,
    );
  requireValue(
    Number.isInteger(award.eventYear) && award.eventYear >= 1888 && award.eventYear <= 3000,
    `${location}.eventYear must be a valid year`,
  );
  const sourceUrl = awardSourceUrl(award.sourceUrl);
  try {
    const parsed = new URL(sourceUrl);
    requireValue(
      ['http:', 'https:'].includes(parsed.protocol),
      `${location}.sourceUrl must use http or https`,
    );
  } catch {
    throw new Error(`Invalid catalog source: ${location}.sourceUrl must be a valid URL`);
  }
}

function optionalText(value, location, maximum = 180) {
  if (value === undefined || value === null || value === '') return;
  requireShortText(value, location, maximum);
}

function optionalScore(value, location, maximum) {
  if (value === undefined || value === null || value === '') return;
  requireValue(Number.isInteger(value) && value >= 0 && value <= maximum, `${location} must be 0–${maximum}`);
}

function validateItem(item, location, { release, catalogRatingScale }) {
  requireText(item.id, `${location}.id`);
  requireValue(
    /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)+$/i.test(item.id),
    `${location}.id must be a stable machine-readable identifier`,
  );
  requireText(item.title, `${location}.title`);
  if (release && !item.provisional)
    requireValue(Number.isInteger(item.rank) && item.rank > 0, `${location}.rank must be a positive integer`);
  else if (release && item.rank !== undefined && item.rank !== null)
    requireValue(Number.isInteger(item.rank) && item.rank > 0, `${location}.rank must be a positive integer`);
  else if (item.rank !== undefined && item.rank !== null)
    requireValue(Number.isInteger(item.rank) && item.rank > 0, `${location}.rank must be a positive integer`);
  optionalText(item.type, `${location}.type`, 80);
  optionalText(item.origin, `${location}.origin`, 240);
  if (Array.isArray(item.genres)) {
    requireValue(item.genres.length <= 100, `${location}.genres may contain at most 100 values`);
    item.genres.forEach((genre, index) => requireShortText(genre, `${location}.genres[${index}]`, 180));
  } else optionalText(item.genres, `${location}.genres`, 1000);
  optionalText(item.lookupTitle, `${location}.lookupTitle`, 240);
  validateSourceReference(item.sourceUrl, `${location}.sourceUrl`);
  optionalText(item.api, `${location}.api`, 40);
  for (const key of [
    'pace',
    'commitment',
    'caveat',
    'watch_note',
    'sourceSynopsis',
    'externalId',
    'platform',
    'distributor',
  ])
    optionalText(item[key], `${location}.${key}`, 2000);
  for (const key of ['entertainment', 'production', 'story'])
    optionalScore(item[key], `${location}.${key}`, 10);
  optionalScore(item.sourceNumericWatchNote, `${location}.sourceNumericWatchNote`, 10);
  for (const key of ['darkness', 'explicitness']) optionalScore(item[key], `${location}.${key}`, 5);
  optionalScore(item.fit_score, `${location}.fit_score`, 100);
  optionalText(item.quality_band, `${location}.quality_band`, 16);
  if (catalogRatingScale === 'ten-tier' && item.quality_band)
    requireValue(
      TEN_TIER_SCALE.has(item.quality_band),
      `${location}.quality_band must use the ten-tier scale`,
    );
  if (catalogRatingScale === 'ten-tier' && item.quality_band && item.tier)
    requireValue(
      item.quality_band === item.tier,
      `${location}.quality_band must match the normalized editorial tier`,
    );
  if (item.year !== undefined && item.year !== null)
    requireValue(
      Number.isInteger(item.year) && item.year >= 0 && item.year <= 3000,
      `${location}.year must be valid`,
    );
  if (item.provisional !== undefined)
    requireValue(typeof item.provisional === 'boolean', `${location}.provisional must be boolean`);
  if (item.aliases !== undefined) {
    requireValue(
      Array.isArray(item.aliases) && item.aliases.length <= 100,
      `${location}.aliases must be an array`,
    );
    item.aliases.forEach((alias, index) => requireShortText(alias, `${location}.aliases[${index}]`, 240));
  }
  if (item.content !== undefined) {
    requireValue(
      item.content && typeof item.content === 'object' && !Array.isArray(item.content),
      `${location}.content must be an object`,
    );
    for (const key of ['sex', 'nudity', 'violence', 'gore', 'disturbing'])
      optionalScore(item.content[key], `${location}.content.${key}`, 5);
  }
  if (item.scores !== undefined) {
    requireValue(
      item.scores && typeof item.scores === 'object' && !Array.isArray(item.scores),
      `${location}.scores must be an object`,
    );
    optionalScore(item.scores.overall, `${location}.scores.overall`, 100);
    for (const key of ['entertainment', 'production', 'story', 'emotional'])
      optionalScore(item.scores[key], `${location}.scores.${key}`, 10);
  }
  if (item.awards !== undefined) {
    requireValue(Array.isArray(item.awards), `${location}.awards must be an array`);
    requireValue(item.awards.length <= 250, `${location}.awards may contain at most 250 entries`);
    item.awards.forEach((award, awardIndex) => validateAward(award, `${location}.awards[${awardIndex}]`));
  }
  if (item.release !== undefined) {
    requireValue(
      item.release && typeof item.release === 'object' && !Array.isArray(item.release),
      `${location}.release must be an object`,
    );
    for (const key of ['status', 'datePrecision'])
      requireText(item.release[key], `${location}.release.${key}`);
    for (const key of ['date', 'region', 'platform', 'notes'])
      optionalText(item.release[key], `${location}.release.${key}`, 2000);
  }
  if (item.releaseSources !== undefined) {
    requireValue(
      Array.isArray(item.releaseSources) && item.releaseSources.length <= 20,
      `${location}.releaseSources must be an array`,
    );
    item.releaseSources.forEach((source, sourceIndex) => {
      requireText(source?.label, `${location}.releaseSources[${sourceIndex}].label`);
      requireText(source?.url, `${location}.releaseSources[${sourceIndex}].url`);
      requireText(source?.accessedAt, `${location}.releaseSources[${sourceIndex}].accessedAt`);
    });
  }
}

export function validateCatalog(catalog, { release = true } = {}) {
  requireValue(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'root must be an object');
  const hasReleaseVersion = Number.isInteger(catalog.version) && catalog.version > 0;
  const hasCheckpointVersion =
    typeof catalog.version === 'string' && /^v\d+(?:[.-][\w.-]+)?$/i.test(catalog.version);
  requireValue(
    release ? hasReleaseVersion : hasReleaseVersion || hasCheckpointVersion,
    release
      ? 'version must be a positive integer'
      : 'version must be a positive integer or checkpoint version such as v99',
  );
  requireText(catalog.generated, 'generated');
  requireText(catalog.scope, 'scope');
  requireValue(Array.isArray(catalog.items), 'items must be an array');
  requireValue(Array.isArray(catalog.collections), 'collections must be an array');
  requireValue(Array.isArray(catalog.franchises), 'franchises must be an array');
  requireValue(Array.isArray(catalog.sources), 'sources must be an array');

  const itemIds = new Set();
  const ranks = new Set();
  catalog.items.forEach((item, index) => {
    const location = `items[${index}]`;
    requireValue(item && typeof item === 'object' && !Array.isArray(item), `${location} must be an object`);
    validateItem(item, location, { release, catalogRatingScale: catalog.ratingScale });
    requireValue(!itemIds.has(item.id), `${location}.id duplicates ${item.id}`);
    itemIds.add(item.id);
    if (release && Number.isInteger(item.rank)) {
      requireValue(!ranks.has(item.rank), `${location}.rank duplicates ${item.rank}`);
      ranks.add(item.rank);
    }
  });
  if (release) {
    const rankedItems = catalog.items.filter((item) => Number.isInteger(item.rank));
    const requiredRankedItems = catalog.items.filter((item) => !item.provisional);
    requireValue(ranks.size === rankedItems.length, 'every ranked item must have a unique rank');
    requireValue(
      rankedItems.length >= requiredRankedItems.length,
      'every non-provisional item must have a rank',
    );
    for (let rank = 1; rank <= ranks.size; rank += 1)
      requireValue(ranks.has(rank), `rank ${rank} is missing from the public catalog`);
  }
  if (catalog.ratingScale === 'ten-tier')
    catalog.items.forEach((item, index) =>
      requireValue(TEN_TIER_SCALE.has(item.tier), `items[${index}].tier must use the ten-tier scale`),
    );
  if (catalog.idMigrations !== undefined) {
    requireValue(
      catalog.idMigrations &&
        typeof catalog.idMigrations === 'object' &&
        !Array.isArray(catalog.idMigrations),
      'idMigrations must be an object',
    );
    Object.entries(catalog.idMigrations).forEach(([legacyId, currentId]) => {
      requireValue(
        /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)+$/i.test(legacyId),
        `idMigrations key ${legacyId} must be a stable identifier`,
      );
      requireValue(itemIds.has(currentId), `idMigrations target ${currentId} is not a catalog item`);
    });
  }

  const collectionIds = new Set();
  catalog.collections.forEach((collection, index) => {
    const location = `collections[${index}]`;
    requireText(collection?.id, `${location}.id`);
    requireText(collection?.name, `${location}.name`);
    requireShortText(collection?.kind, `${location}.kind`, 80);
    requireShortText(collection?.mode, `${location}.mode`, 80);
    requireShortText(collection?.description, `${location}.description`, 2_000);
    requireValue(Array.isArray(collection.items), `${location}.items must be an array`);
    requireValue(!collectionIds.has(collection.id), `${location}.id duplicates ${collection.id}`);
    collectionIds.add(collection.id);
    collection.items.forEach((itemId) => {
      if (release) requireValue(itemIds.has(itemId), `${location}.items references unknown item ${itemId}`);
      else requireText(itemId, `${location}.items entry`);
    });
  });

  const franchiseIds = new Set();
  catalog.franchises.forEach((franchise, index) => {
    const location = `franchises[${index}]`;
    requireText(franchise?.id, `${location}.id`);
    requireText(franchise?.name, `${location}.name`);
    optionalText(franchise.summary, `${location}.summary`, 4_000);
    requireValue(Array.isArray(franchise.orders), `${location}.orders must be an array`);
    requireValue(!franchiseIds.has(franchise.id), `${location}.id duplicates ${franchise.id}`);
    franchiseIds.add(franchise.id);
    franchise.orders.forEach((order, orderIndex) => {
      const orderLocation = `${location}.orders[${orderIndex}]`;
      requireValue(
        order && typeof order === 'object' && !Array.isArray(order),
        `${orderLocation} must be an object`,
      );
      requireShortText(order.label, `${orderLocation}.label`, 240);
      optionalText(order.mode, `${orderLocation}.mode`, 80);
      optionalText(order.note, `${orderLocation}.note`, 2_000);
      requireValue(Array.isArray(order.steps), `${orderLocation}.steps must be an array`);
      order.steps.forEach((step, stepIndex) => {
        const stepLocation = `${orderLocation}.steps[${stepIndex}]`;
        requireValue(
          step && typeof step === 'object' && !Array.isArray(step),
          `${stepLocation} must be an object`,
        );
        requireShortText(step.n, `${stepLocation}.n`, 40);
        requireShortText(step.title, `${stepLocation}.title`, 500);
        requireShortText(step.kind, `${stepLocation}.kind`, 80);
        requireShortText(step.flag, `${stepLocation}.flag`, 80);
        optionalText(step.id, `${stepLocation}.id`, 240);
        optionalText(step.itemId, `${stepLocation}.itemId`, 240);
        if (release && step.itemId)
          requireValue(itemIds.has(step.itemId), `${stepLocation}.itemId references an unknown item`);
        optionalText(step.episodeRange, `${stepLocation}.episodeRange`, 240);
        optionalText(step.timeRange, `${stepLocation}.timeRange`, 240);
        optionalText(step.resumeNote, `${stepLocation}.resumeNote`, 2000);
        optionalText(step.note, `${stepLocation}.note`, 2000);
        optionalText(step.after, `${stepLocation}.after`, 240);
      });
    });
  });

  catalog.sources.forEach((source, index) => {
    if (typeof source === 'string') {
      requireText(source, `sources[${index}]`);
      return;
    }
    requireText(source?.label, `sources[${index}].label`);
    requireText(source?.url, `sources[${index}].url`);
    try {
      const url = new URL(source.url);
      requireValue(
        ['http:', 'https:'].includes(url.protocol),
        `sources[${index}].url must use http or https`,
      );
    } catch {
      throw new Error(`Invalid catalog source: sources[${index}].url must be a valid URL`);
    }
  });

  return catalog;
}

export function catalogNeedsBuild() {
  try {
    return catalogDatabaseNeedsBuild(databaseOutputPath, readFileSync(sourcePath, 'utf8'));
  } catch {
    return true;
  }
}

export function buildCatalog({ outputPath = databaseOutputPath } = {}) {
  let source;
  let catalog;
  try {
    source = readFileSync(sourcePath, 'utf8');
    catalog = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not read ${sourcePath}: ${error.message}`);
  }

  validateCatalog(catalog);
  mkdirSync(dirname(outputPath), { recursive: true });
  buildCatalogDatabase(outputPath, catalog, source);
  console.log(
    `Generated indexed SQLite catalog from data/catalog-source.json (${catalog.items.length} items, ${catalog.collections.length} collections, ${catalog.franchises.length} franchises).`,
  );
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const verifyOnly = process.argv.includes('--verify');
  const temporaryDirectory = verifyOnly
    ? mkdtempSync(join(tmpdir(), 'ultimate-animation-index-catalog-'))
    : '';
  try {
    buildCatalog({
      outputPath: verifyOnly ? join(temporaryDirectory, 'catalog.sqlite') : databaseOutputPath,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
