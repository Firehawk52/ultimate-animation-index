import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOfficialTranslationRegistry, validateTranslationPack } from '../public/i18n.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIRECTORY = join(ROOT, 'public', 'translations');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof SyntaxError ? 'invalid JSON' : error.message}`);
  }
}

function sameContributors(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

export async function checkOfficialTranslations() {
  const registry = validateOfficialTranslationRegistry(await readJson(join(DIRECTORY, 'index.json')));
  const names = new Set(await readdir(DIRECTORY));
  const declared = new Set(registry.languages.map((language) => language.file));
  for (const language of registry.languages) {
    if (!names.has(language.file)) throw new Error(`Missing official translation file: ${language.file}`);
    const pack = validateTranslationPack(await readJson(join(DIRECTORY, language.file)));
    if (pack.locale !== language.locale || pack.language !== language.language)
      throw new Error(`Registry metadata does not match ${language.file}`);
    if (pack.revision !== language.revision)
      throw new Error(`Registry revision does not match ${language.file}`);
    if (!sameContributors(pack.contributors, language.contributors))
      throw new Error(`Registry credits do not match ${language.file}`);
  }
  for (const name of names) {
    if (name === 'index.json' || !name.endsWith('.json')) continue;
    if (!declared.has(name)) throw new Error(`Undeclared official translation file: ${name}`);
  }
  return registry;
}

try {
  const registry = await checkOfficialTranslations();
  console.log(`Official translations valid: ${registry.languages.length} language(s).`);
} catch (error) {
  console.error(`Official translation validation failed: ${error.message}`);
  process.exitCode = 1;
}
