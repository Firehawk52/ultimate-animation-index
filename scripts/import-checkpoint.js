import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog } from './build-catalog.js';
import { loadCheckpoint, normalizeCheckpointForRelease } from './checkpoint-import.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archive = process.argv[2];

if (!archive) {
  console.error('Usage: node scripts/import-checkpoint.js <checkpoint.zip>');
  process.exitCode = 1;
} else {
  try {
    const checkpoint = loadCheckpoint(archive);
    const legacyCatalog = JSON.parse(readFileSync(join(root, 'data', 'catalog-source.json'), 'utf8'));
    const { catalog, repairs } = normalizeCheckpointForRelease(checkpoint, { legacyCatalog });
    validateCatalog(catalog);
    writeFileSync(join(root, 'data', 'catalog-source.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    console.log(
      `Imported checkpoint v${catalog.version}: ${catalog.items.length} titles, ${catalog.collections.length} collections, ${catalog.franchises.length} franchises, ${catalog.sources.length} sources, ${Object.keys(catalog.idMigrations || {}).length} legacy ID migrations; ${repairs.length} controlled repairs.`,
    );
  } catch (error) {
    console.error(`Checkpoint import failed: ${error.message}`);
    process.exitCode = 1;
  }
}
