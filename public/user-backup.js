const FORMAT = 'uai-user-backup';
const VERSION = 1;
const STATUSES = new Set(['Not started', 'Watching', 'Completed', 'On hold', 'Dropped']);
const VERDICTS = new Set(['recommend', 'avoid']);
const EPISODE_STATES = new Set(['watching', 'watched']);
const APIS = new Set(['anilist', 'tvmaze', 'wiki', 'none']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const MAX_RECORDS = 10_000;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid-${label}`);
  return value;
}

function entries(value, label, limit = MAX_RECORDS) {
  const list = Object.entries(record(value, label));
  if (list.length > limit) throw new Error(`too-many-${label}`);
  return list;
}

function safeId(value, label = 'id') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`invalid-${label}`);
  return value;
}

function text(value, max, label, { required = false } = {}) {
  if (typeof value !== 'string') throw new Error(`invalid-${label}`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max || /[<>\u0000-\u001f\u007f]/.test(normalized))
    throw new Error(`invalid-${label}`);
  return normalized;
}

function uiText(value, max, label) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`invalid-${label}`);
  return value;
}

function validateProgress(value) {
  return Object.fromEntries(
    entries(value, 'progress').map(([id, item]) => {
      safeId(id);
      record(item, 'progress-item');
      const status = item.status ?? 'Not started';
      const rating = Number(item.rating || 0);
      const note = typeof item.note === 'string' ? item.note.trim() : '';
      if (!STATUSES.has(status)) throw new Error('invalid-watch-status');
      if (!Number.isFinite(rating) || rating < 0 || rating > 10) throw new Error('invalid-rating');
      if (note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note))
        throw new Error('invalid-private-note');
      return [id, { status, rating, note }];
    }),
  );
}

function validateOpinions(value) {
  return Object.fromEntries(
    entries(value, 'opinions').map(([id, verdict]) => {
      safeId(id);
      if (!VERDICTS.has(verdict)) throw new Error('invalid-opinion');
      return [id, verdict];
    }),
  );
}

function validateFavorites(value) {
  return Object.fromEntries(
    entries(value, 'favorites').map(([id, favorite]) => {
      safeId(id);
      if (favorite !== true) throw new Error('invalid-favorite');
      return [id, true];
    }),
  );
}

function validateContent(value = {}) {
  const source = record(value, 'content');
  const result = {};
  for (const key of ['sex', 'nudity', 'violence', 'gore', 'disturbing']) {
    const level = Number(source[key] || 0);
    if (!Number.isInteger(level) || level < 0 || level > 5) throw new Error('invalid-content-level');
    result[key] = level;
  }
  const tags = source.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20) throw new Error('invalid-content-tags');
  result.tags = tags.map((tag) => text(tag, 40, 'content-tag', { required: true }));
  if (new Set(result.tags.map((tag) => tag.toLowerCase())).size !== result.tags.length)
    throw new Error('duplicate-content-tag');
  return result;
}

function validateCustomTitles(value) {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('invalid-custom-titles');
  const seen = new Set();
  return value.map((item) => {
    record(item, 'custom-title');
    const id = safeId(item.id);
    if (seen.has(id)) throw new Error('duplicate-custom-title');
    seen.add(id);
    const year = Number(item.year || 0);
    if (!Number.isInteger(year) || year < 0 || year > 2200) throw new Error('invalid-custom-year');
    const api = APIS.has(item.api) ? item.api : 'none';
    const title = text(item.title, 180, 'custom-title-name', { required: true });
    const score = (key, maximum) => {
      const number = Number(item.scores?.[key] || 0);
      if (!Number.isInteger(number) || number < 0 || number > maximum)
        throw new Error('invalid-catalog-score');
      return number;
    };
    const normalized = {
      id,
      title,
      year,
      type: text(item.type || 'Series', 50, 'custom-type', { required: true }),
      origin: text(item.origin || 'Unknown', 80, 'custom-origin', { required: true }),
      genres: text(item.genres || '', 500, 'custom-genres'),
      tier: 'CUSTOM',
      rank: null,
      quality_band: 'CUSTOM',
      api,
      lookupTitle: text(item.lookupTitle || title, 180, 'custom-lookup-title', { required: true }),
      externalId: text(String(item.externalId || ''), 80, 'custom-external-id'),
      custom: true,
      addedByMe: item.addedByMe === true,
      content: validateContent(item.content || {}),
      scores: {
        overall: score('overall', 100),
        production: score('production', 10),
        story: score('story', 10),
        emotional: score('emotional', 10),
      },
    };
    if (item.contentEstimated === true) normalized.contentEstimated = true;
    return normalized;
  });
}

function validateSources(value) {
  return Object.fromEntries(
    entries(value, 'sources', 5000).map(([id, item]) => {
      safeId(id, 'source-id');
      record(item, 'source');
      if (!Array.isArray(item.titleIds) || item.titleIds.length > 5000)
        throw new Error('invalid-source-titles');
      const titleIds = item.titleIds.map((titleId) => safeId(titleId));
      if (new Set(titleIds).size !== titleIds.length) throw new Error('duplicate-source-title');
      return [
        id,
        {
          label: text(item.label, 40, 'source-label', { required: true }),
          importedAt: text(item.importedAt || '', 64, 'source-date'),
          opinions: validateOpinions(item.opinions || {}),
          titleIds,
        },
      ];
    }),
  );
}

function validateEpisodeProgress(value) {
  let stateCount = 0;
  return Object.fromEntries(
    entries(value, 'episode-groups').map(([id, states]) => {
      safeId(id, 'episode-group');
      const normalizedStates = Object.fromEntries(
        entries(states, 'episode-states', 5000).map(([number, status]) => {
          const episode = Number(number);
          if (!Number.isInteger(episode) || episode < 1 || episode > 100_000 || !EPISODE_STATES.has(status))
            throw new Error('invalid-episode-state');
          stateCount++;
          if (stateCount > 50_000) throw new Error('too-many-episode-states');
          return [String(episode), status];
        }),
      );
      return [id, normalizedStates];
    }),
  );
}

function validateUI(value) {
  const source = record(value, 'ui');
  const result = {};
  const strings = [
    'adult',
    'searchInput',
    'tierFilter',
    'typeFilter',
    'genreFilter',
    'statusFilter',
    'sortSelect',
    'adultSearch',
    'adultTierFilter',
    'adultTypeFilter',
    'adultGenreFilter',
    'adultStatusFilter',
    'adultSort',
    'collectionSearch',
    'franchiseSearch',
    'favoriteSearch',
  ];
  for (const key of strings) {
    if (typeof source[key] === 'string') result[key] = uiText(source[key], 500, `ui-${key}`);
  }
  if (source.ratingFormat !== undefined) {
    if (!['tier', 'ten', 'stars'].includes(source.ratingFormat)) throw new Error('invalid-rating-format');
    result.ratingFormat = source.ratingFormat;
  }
  if (source.collectionSort !== undefined) {
    if (!['rating', 'release', 'name'].includes(source.collectionSort))
      throw new Error('invalid-collection-sort');
    result.collectionSort = source.collectionSort;
  }
  if (source.collectionSortOrder !== undefined) {
    if (!['asc', 'desc'].includes(source.collectionSortOrder))
      throw new Error('invalid-collection-sort-order');
    result.collectionSortOrder = source.collectionSortOrder;
  }
  if (source.masterSortOrder !== undefined) {
    if (!['asc', 'desc'].includes(source.masterSortOrder)) throw new Error('invalid-master-sort-order');
    result.masterSortOrder = source.masterSortOrder;
  }
  if (source.adultSortOrder !== undefined) {
    if (!['asc', 'desc'].includes(source.adultSortOrder)) throw new Error('invalid-adult-sort-order');
    result.adultSortOrder = source.adultSortOrder;
  }
  for (const key of ['hideCompleted', 'customOnly']) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  return result;
}

export function validateUserBackup(input) {
  const root = record(input, 'backup');
  if (root.format !== FORMAT || root.version !== VERSION) throw new Error('unsupported-backup');
  const data = record(root.data, 'backup-data');
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: text(root.createdAt, 64, 'backup-date', { required: true }),
    appVersion: text(root.appVersion || '', 32, 'app-version'),
    data: {
      progress: validateProgress(data.progress || {}),
      opinions: validateOpinions(data.opinions || {}),
      customTitles: validateCustomTitles(data.customTitles || []),
      sources: validateSources(data.sources || {}),
      favorites: validateFavorites(data.favorites || {}),
      episodeProgress: validateEpisodeProgress(data.episodeProgress || {}),
      ui: validateUI(data.ui || {}),
      compact: data.compact === true,
    },
  };
}

export function createUserBackup(data, { createdAt = new Date().toISOString(), appVersion = '2.3.2' } = {}) {
  return validateUserBackup({ format: FORMAT, version: VERSION, createdAt, appVersion, data });
}

function mergeEpisodeProgress(current, incoming) {
  const merged = structuredClone(current);
  for (const [id, states] of Object.entries(incoming)) merged[id] = { ...(merged[id] || {}), ...states };
  return merged;
}

export function combineUserData(current, incoming, mode = 'merge') {
  const currentData = validateUserBackup({
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    appVersion: '',
    data: current,
  }).data;
  const incomingData = validateUserBackup({
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    appVersion: '',
    data: incoming,
  }).data;
  if (mode === 'replace') return incomingData;
  if (mode !== 'merge') throw new Error('invalid-import-mode');
  const titles = new Map(currentData.customTitles.map((title) => [title.id, title]));
  incomingData.customTitles.forEach((title) => titles.set(title.id, title));
  return {
    progress: { ...currentData.progress, ...incomingData.progress },
    opinions: { ...currentData.opinions, ...incomingData.opinions },
    customTitles: [...titles.values()],
    sources: { ...currentData.sources, ...incomingData.sources },
    favorites: { ...currentData.favorites, ...incomingData.favorites },
    episodeProgress: mergeEpisodeProgress(currentData.episodeProgress, incomingData.episodeProgress),
    ui: { ...currentData.ui, ...incomingData.ui },
    compact: incomingData.compact,
  };
}

export function summarizeUserData(data) {
  const normalized = createUserBackup(data).data;
  const progressEntries = Object.values(normalized.progress);
  return {
    statuses: progressEntries.filter((item) => item.status !== 'Not started').length,
    ratings: progressEntries.filter((item) => item.rating > 0).length,
    notes: progressEntries.filter((item) => item.note).length,
    favorites: Object.keys(normalized.favorites).length,
    episodes: Object.values(normalized.episodeProgress).reduce(
      (total, states) => total + Object.keys(states).length,
      0,
    ),
    customTitles: normalized.customTitles.length,
    sources: Object.keys(normalized.sources).length,
  };
}
