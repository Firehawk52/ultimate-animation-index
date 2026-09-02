import { basename } from 'node:path';
import { validateCatalog } from './build-catalog.js';
import { loadCheckpoint, normalizeCheckpointForRelease } from './checkpoint-import.js';

const archive = process.argv[2];
if (!archive) {
  console.error('Usage: node scripts/check-checkpoint.js <checkpoint.zip>');
  process.exitCode = 1;
} else {
  try {
    const checkpoint = loadCheckpoint(archive);
    const { catalog, repairs } = normalizeCheckpointForRelease(checkpoint);
    validateCatalog(catalog);
    console.log(
      `Checkpoint release-ready: ${basename(archive)} — v${catalog.version}, ${catalog.items.length} titles, ${catalog.franchises.length} franchises, ${catalog.sources.length} sources, ${checkpoint.checksumCount} checksums verified.`,
    );
    if (repairs.length) {
      console.log(`Applied ${repairs.length} controlled data repairs:`);
      repairs.forEach((repair) => console.log(`- ${repair.title}: ${repair.action}`));
    }
  } catch (error) {
    console.error(`Checkpoint validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
