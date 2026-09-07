import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = '4';
const FOR_KIDS = new Set(['family', 'kids', 'children', "children's"]);

function normalizedText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function list(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function content(item) {
  return item?.content && typeof item.content === 'object' ? item.content : {};
}

function isMature(item) {
  const guide = content(item);
  const tags = list(guide.tags).map((tag) => normalizedText(tag));
  return (
    tags.length > 0 ||
    Math.max(
      Number(guide.sex) || 0,
      Number(guide.nudity) || 0,
      Number(guide.violence) || 0,
      Number(guide.gore) || 0,
      Number(guide.disturbing) || 0,
    ) >= 4
  );
}

function isForKids(item) {
  const tags = list(content(item).tags).map(normalizedText);
  if (tags.includes('not for kids')) return false;
  return list(item.genres).some((genre) => FOR_KIDS.has(normalizedText(genre))) || tags.includes('for kids');
}

function score(item, key) {
  return Number(item?.scores?.[key] ?? item?.[key]) || 0;
}

export function catalogSourceHash(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function catalogDatabaseNeedsBuild(databasePath, source) {
  if (!existsSync(databasePath)) return true;
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare("SELECT value FROM catalog_meta WHERE key = 'source_hash'").get();
    const schema = database.prepare("SELECT value FROM catalog_meta WHERE key = 'schema_version'").get();
    database.close();
    return row?.value !== catalogSourceHash(source) || schema?.value !== SCHEMA_VERSION;
  } catch {
    return true;
  }
}

export function buildCatalogDatabase(databasePath, catalog, source) {
  if (!catalogDatabaseNeedsBuild(databasePath, source)) return false;
  const nextPath = `${databasePath}.next`;
  rmSync(nextPath, { force: true });
  const database = new DatabaseSync(nextPath);
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE titles (
        id TEXT PRIMARY KEY,
        rank INTEGER,
        title TEXT NOT NULL,
        title_key TEXT NOT NULL,
        type TEXT,
        origin TEXT,
        tier TEXT,
        year INTEGER,
        overall REAL NOT NULL DEFAULT 0,
        production REAL NOT NULL DEFAULT 0,
        story REAL NOT NULL DEFAULT 0,
        emotional REAL NOT NULL DEFAULT 0,
        is_mature INTEGER NOT NULL DEFAULT 0,
        is_kids INTEGER NOT NULL DEFAULT 0,
        has_award INTEGER NOT NULL DEFAULT 0,
        search_text TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE title_genres (title_id TEXT NOT NULL, genre TEXT NOT NULL, genre_key TEXT NOT NULL);
      CREATE TABLE title_origins (title_id TEXT NOT NULL, country TEXT NOT NULL, region TEXT NOT NULL);
      CREATE INDEX title_rank_idx ON titles(rank);
      CREATE INDEX title_type_idx ON titles(type);
      CREATE INDEX title_tier_idx ON titles(tier);
      CREATE INDEX title_mature_idx ON titles(is_mature);
      CREATE INDEX title_kids_idx ON titles(is_kids);
      CREATE INDEX title_genre_idx ON title_genres(genre_key, title_id);
      CREATE INDEX title_genre_exact_idx ON title_genres(genre, title_id);
      CREATE INDEX title_origin_region_idx ON title_origins(region, title_id);
      CREATE INDEX title_origin_country_idx ON title_origins(country, title_id);
      CREATE INDEX title_origin_region_country_idx ON title_origins(region, country, title_id);
      CREATE TABLE catalog_entities (kind TEXT PRIMARY KEY, data_json TEXT NOT NULL);
    `);
    const insertTitle = database.prepare(`
      INSERT INTO titles (
        id, rank, title, title_key, type, origin, tier, year, overall, production, story, emotional,
        is_mature, is_kids, has_award, search_text, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertGenre = database.prepare(
      'INSERT INTO title_genres (title_id, genre, genre_key) VALUES (?, ?, ?)',
    );
    const insertOrigin = database.prepare(
      'INSERT INTO title_origins (title_id, country, region) VALUES (?, ?, ?)',
    );
    const regionFor = (country) => {
      const regions = {
        Africa:
          'Algeria|Angola|Burkina Faso|Cameroon|Côte d’Ivoire|Egypt|Eswatini|Ethiopia|Ghana|Kenya|Mali|Morocco|Niger|Nigeria|Senegal|South Africa|Tanzania|Tunisia|Uganda|Zambia|Zimbabwe|Democratic Republic of the Congo',
        Asia: 'Armenia|Bangladesh|China|Georgia|Hong Kong|India|Indonesia|Iran|Iraq|Israel|Japan|Jordan|Kuwait|Lebanon|Malaysia|North Korea|Pakistan|Palestine|Philippines|Qatar|Saudi Arabia|Singapore|South Korea|Syria|Taiwan|Thailand|Turkey|Türkiye|United Arab Emirates|Uzbekistan|Vietnam',
        Europe:
          'Austria|Belarus|Belgium|Bosnia and Herzegovina|Bulgaria|Croatia|Cyprus|Czech Republic|Czechoslovakia|Denmark|East Germany|Estonia|Finland|France|Germany|Greece|Hungary|Iceland|Ireland|Italy|Latvia|Lithuania|Luxembourg|Netherlands|North Macedonia|Norway|Poland|Portugal|Romania|Russia|Scotland|Serbia|Slovakia|Slovenia|Spain|Sweden|Switzerland|Ukraine|UK|United Kingdom|USSR|Wales|West Germany|Yugoslavia',
        'North America': 'Canada|United States|US',
        'South America':
          'Argentina|Bolivia|Brazil|Chile|Colombia|Ecuador|Guyana|Paraguay|Peru|Suriname|Uruguay|Venezuela',
        'Central America & Caribbean':
          'Aruba|Bahamas|Barbados|Costa Rica|Cuba|Curaçao|Dominican Republic|El Salvador|Guadeloupe|Guatemala|Haiti|Honduras|Jamaica|Martinique|Mexico|Nicaragua|Panama|Puerto Rico|Saint Vincent and the Grenadines|Trinidad and Tobago',
        Oceania: 'Australia|New Zealand',
        'Regional / International': 'International|Latin America|Middle East|Pan-Africa',
      };
      const normalizedCountry =
        country === 'US'
          ? 'United States'
          : country === 'UK'
            ? 'United Kingdom'
            : country === 'Türkiye'
              ? 'Turkey'
              : country;
      for (const [region, values] of Object.entries(regions)) {
        if (values.split('|').includes(country) || values.split('|').includes(normalizedCountry))
          return region;
      }
      return 'Unclassified';
    };
    database.exec('BEGIN');
    for (const item of catalog.items || []) {
      const genres = list(item.genres);
      const aliases = list(item.aliases);
      const awards = Array.isArray(item.awards) ? item.awards : [];
      const itemContent = content(item);
      const searchText = normalizedText(
        [
          item.title,
          ...aliases,
          ...genres,
          item.editorial_note,
          item.why,
          item.origin,
          item.lookupTitle,
          ...awards.flatMap((award) => [award.award, award.category, award.organization, award.sourceTitle]),
        ].join(' '),
      );
      insertTitle.run(
        item.id,
        Number.isInteger(item.rank) ? item.rank : null,
        item.title,
        normalizedText(item.title),
        item.type || '',
        item.origin || '',
        item.tier || '',
        Number.isInteger(item.year) ? item.year : null,
        score(item, 'overall'),
        score(item, 'production'),
        score(item, 'story'),
        score(item, 'emotional'),
        isMature(item) ? 1 : 0,
        isForKids(item) ? 1 : 0,
        awards.length ? 1 : 0,
        searchText,
        JSON.stringify(item),
      );
      for (const genre of genres) insertGenre.run(item.id, genre, normalizedText(genre));
      for (const country of String(item.origin || '')
        .split(/\s*\/\s*/)
        .filter(Boolean))
        insertOrigin.run(item.id, country, regionFor(country));
    }
    const insertEntity = database.prepare('INSERT INTO catalog_entities (kind, data_json) VALUES (?, ?)');
    insertEntity.run('collections', JSON.stringify(catalog.collections || []));
    insertEntity.run('franchises', JSON.stringify(catalog.franchises || []));
    insertEntity.run('idMigrations', JSON.stringify(catalog.idMigrations || {}));
    const meta = database.prepare('INSERT INTO catalog_meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', SCHEMA_VERSION);
    meta.run('source_hash', catalogSourceHash(source));
    meta.run('generated_at', new Date().toISOString());
    meta.run('title_count', String((catalog.items || []).length));
    meta.run(
      'film_count',
      String((catalog.items || []).filter((item) => /film/i.test(String(item.type || ''))).length),
    );
    meta.run('collection_count', String((catalog.collections || []).length));
    meta.run('franchise_count', String((catalog.franchises || []).length));
    database.exec('COMMIT; ANALYZE; VACUUM;');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}
    throw error;
  } finally {
    database.close();
  }
  rmSync(databasePath, { force: true });
  renameSync(nextPath, databasePath);
  return true;
}
