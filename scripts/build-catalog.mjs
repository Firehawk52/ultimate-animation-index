// Compatibility bridge for the final build step of an updater started by version 2.1.0.
// Active application modules use .js; remove this only when upgrades from 2.1.0 are no longer supported.
import { buildCatalog } from './build-catalog.js';

buildCatalog();
