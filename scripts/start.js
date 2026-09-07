import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, catalogNeedsBuild } from './build-catalog.js';
import { assertSupportedNode, parsePort, readLocalHealth } from './runtime.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_DATABASE = join(ROOT, 'data', 'catalog.sqlite');

async function main() {
  assertSupportedNode();
  const port = parsePort(process.env.PORT);
  // SQLite is a generated runtime index. Its source hash must always match the
  // reviewed catalog JSON; otherwise the app could serve an older catalog.
  const needsCatalogBuild =
    !existsSync(CATALOG_DATABASE) || process.env.UAI_REBUILD_CATALOG === '1' || catalogNeedsBuild();
  const alreadyRunning = await readLocalHealth(port);

  if (alreadyRunning) {
    if (needsCatalogBuild) {
      console.log(
        `Ultimate Animation Index is already running at http://localhost:${port}, but its local catalog is out of date. Stop the existing server, then run npm start again to rebuild it.`,
      );
    } else {
      console.log(`Ultimate Animation Index is already running at http://localhost:${port}`);
    }
    return;
  }

  if (needsCatalogBuild) {
    console.log('Generating local SQLite catalog...');
    buildCatalog();
  }

  const { startServer } = await import('../src/server.js');
  const activeServer = startServer();
  activeServer.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already used by another application. Close it or set a different PORT value.`,
      );
    } else {
      console.error(`The local server could not start: ${error.message}`);
    }
    setImmediate(() => process.exit(1));
  });
}

try {
  await main();
} catch (error) {
  console.error(`Startup stopped: ${error.message}`);
  process.exitCode = 1;
}
