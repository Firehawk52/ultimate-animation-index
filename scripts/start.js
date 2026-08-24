import { buildCatalog, catalogNeedsBuild } from './build-catalog.js';
import { assertSupportedNode, parsePort, readLocalHealth } from './runtime.js';

async function main() {
  assertSupportedNode();
  const port = parsePort(process.env.PORT);
  const alreadyRunning = await readLocalHealth(port);

  if (alreadyRunning) {
    console.log(`Ultimate Animation Index is already running at http://localhost:${port}`);
    return;
  }

  if (catalogNeedsBuild() || process.env.UAI_REBUILD_CATALOG === '1') {
    console.log('Generating public/catalog.json...');
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
