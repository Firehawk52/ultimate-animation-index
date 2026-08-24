import { buildCatalog, catalogNeedsBuild } from './build-catalog.js';
import { assertSupportedNode, parsePort, readLocalHealth } from './runtime.js';

async function main() {
  assertSupportedNode();
  const port = parsePort(process.env.PORT);
  const needsCatalogBuild = catalogNeedsBuild() || process.env.UAI_REBUILD_CATALOG === '1';
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
