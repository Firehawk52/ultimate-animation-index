import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, 'data', 'catalog-source.json');
const outputPath = join(root, 'public', 'catalog.json');

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid catalog source: ${message}`);
}

function requireText(value, location) {
  requireValue(
    typeof value === 'string' && value.trim().length > 0,
    `${location} must be a non-empty string`,
  );
}

export function validateCatalog(catalog) {
  requireValue(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'root must be an object');
  requireValue(
    Number.isInteger(catalog.version) && catalog.version > 0,
    'version must be a positive integer',
  );
  requireText(catalog.generated, 'generated');
  requireText(catalog.scope, 'scope');
  requireValue(Array.isArray(catalog.items), 'items must be an array');
  requireValue(Array.isArray(catalog.collections), 'collections must be an array');
  requireValue(Array.isArray(catalog.franchises), 'franchises must be an array');
  requireValue(Array.isArray(catalog.sources), 'sources must be an array');

  const itemIds = new Set();
  catalog.items.forEach((item, index) => {
    const location = `items[${index}]`;
    requireValue(item && typeof item === 'object' && !Array.isArray(item), `${location} must be an object`);
    requireText(item.id, `${location}.id`);
    requireText(item.title, `${location}.title`);
    requireValue(!itemIds.has(item.id), `${location}.id duplicates ${item.id}`);
    itemIds.add(item.id);
  });

  const collectionIds = new Set();
  catalog.collections.forEach((collection, index) => {
    const location = `collections[${index}]`;
    requireText(collection?.id, `${location}.id`);
    requireText(collection?.name, `${location}.name`);
    requireValue(Array.isArray(collection.items), `${location}.items must be an array`);
    requireValue(!collectionIds.has(collection.id), `${location}.id duplicates ${collection.id}`);
    collectionIds.add(collection.id);
    collection.items.forEach((itemId) => {
      requireValue(itemIds.has(itemId), `${location}.items references unknown item ${itemId}`);
    });
  });

  const franchiseIds = new Set();
  catalog.franchises.forEach((franchise, index) => {
    const location = `franchises[${index}]`;
    requireText(franchise?.id, `${location}.id`);
    requireText(franchise?.name, `${location}.name`);
    requireValue(Array.isArray(franchise.orders), `${location}.orders must be an array`);
    requireValue(!franchiseIds.has(franchise.id), `${location}.id duplicates ${franchise.id}`);
    franchiseIds.add(franchise.id);
  });

  catalog.sources.forEach((source, index) => {
    requireText(source?.label, `sources[${index}].label`);
    requireText(source?.url, `sources[${index}].url`);
  });

  return catalog;
}

export function catalogNeedsBuild() {
  try {
    return readFileSync(outputPath, 'utf8') !== readFileSync(sourcePath, 'utf8');
  } catch {
    return true;
  }
}

export function buildCatalog() {
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
  writeFileSync(outputPath, source, 'utf8');
  console.log(
    `Generated public/catalog.json from data/catalog-source.json (${catalog.items.length} items, ${catalog.collections.length} collections, ${catalog.franchises.length} franchises).`,
  );
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  try {
    buildCatalog();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
