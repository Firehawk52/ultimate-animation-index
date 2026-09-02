import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from './build-catalog.js';
import { loadCheckpoint, normalizeCheckpointForRelease } from './checkpoint-import.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archive = process.argv[2];

function preserveCommunitySignals(legacyCatalog, catalog) {
  const signals = new Map(
    (legacyCatalog.items || [])
      .filter((item) => item?.id && item.communitySignal && typeof item.communitySignal === 'object')
      .map((item) => [item.id, item.communitySignal]),
  );
  let preserved = 0;
  for (const item of catalog.items || []) {
    const signal = signals.get(item.id);
    if (!signal) continue;
    item.communitySignal = structuredClone(signal);
    preserved++;
  }
  return preserved;
}

if (!archive) {
  console.error('Usage: node scripts/import-checkpoint.js <checkpoint.zip>');
  process.exitCode = 1;
} else {
  try {
    const checkpoint = loadCheckpoint(archive);
    const legacyCatalog = JSON.parse(readFileSync(join(root, 'data', 'catalog-source.json'), 'utf8'));
    const { catalog, repairs } = normalizeCheckpointForRelease(checkpoint, { legacyCatalog });
    const preservedSignals = preserveCommunitySignals(legacyCatalog, catalog);
    validateCatalog(catalog);
    writeFileSync(join(root, 'data', 'catalog-source.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    console.log(
      `Imported checkpoint v${catalog.version}: ${catalog.items.length} titles, ${catalog.collections.length} collections, ${catalog.franchises.length} franchises, ${catalog.sources.length} sources, ${Object.keys(catalog.idMigrations || {}).length} legacy ID migrations; ${repairs.length} controlled repairs; ${preservedSignals} community signals preserved.`,
    );
  } catch (error) {
    console.error(`Checkpoint import failed: ${error.message}`);
    process.exitCode = 1;
  }
}
