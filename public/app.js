import { combineUserData, createUserBackup, summarizeUserData, validateUserBackup } from './user-backup.js';
import {
  normalizeRatingFormat,
  normalizeCuratedTier,
  personalRatingTier,
  personalTierOptions,
  qualityRatingLabel,
} from './rating-format.js';
import {
  awardBadgeLabel,
  awardProgramOptions,
  awardSearchText,
  awardSummary,
  matchesAwardFilter,
  safeAwardSourceUrl,
  sortedAwardEntries,
} from './award-format.js';
import { providerSeriesLabels } from './series-labels.js';
import { REGIONS, countriesFor, titleMatchesCountry, titleMatchesRegion } from './geography.js';
import {
  createInterfaceI18n,
  officialCreditNames,
  validateOfficialTranslationRegistry,
  validateTranslationPack,
} from './i18n.js';

(async () => {
  'use strict';
  const APP_VERSION = '3.0.0';
  const PAGE_SIZE = 60;
  // The app no longer needs to download and parse the entire catalog before it
  // can become interactive. New servers provide an indexed first page plus
  // facets; old installations retain a safe full-catalog fallback until they
  // are restarted once after updating.
  let catalogBootstrap = null;
  let CAT;
  try {
    const response = await fetch(`/api/catalog/bootstrap?scope=master&limit=${PAGE_SIZE}`, {
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok || !data.ok || !Array.isArray(data.page?.items)) throw new Error('catalog-bootstrap');
    catalogBootstrap = data;
    CAT = {
      items: data.page.items,
      collections: [],
      franchises: [],
      idMigrations: data.idMigrations || {},
    };
  } catch {
    throw new Error('Could not load the indexed catalog. Start the included server and reload the page.');
  }
  const SEARCH_DEBOUNCE_MS = 120;
  const OFFICIAL_TRANSLATIONS_PATH = 'translations/index.json';
  const OFFICIAL_TRANSLATIONS_REMOTE =
    'https://raw.githubusercontent.com/Firehawk52/ultimate-animation-index/main/public/translations/';
  const OFFICIAL_TRANSLATION_CHECK_TTL = 1000 * 60 * 60 * 24;
  const STORE = {
    progress: 'uai:progress:v3',
    opinions: 'uai:my-opinions:v1',
    custom: 'uai:custom-titles:v1',
    sources: 'uai:imported-sources:v1',
    meta: 'uai:metadata:v6',
    compact: 'uai:compact:v1',
    favorites: 'uai:favorites:v1',
    ui: 'uai:ui-state:v1',
    episodes: 'uai:episode-progress:v1',
    series: 'uai:series-groups:v6',
    franchiseProgress: 'uai:franchise-step-progress:v1',
    catalogCorrections: 'uai:catalog-corrections:v1',
    coverOverrides: 'uai:cover-overrides:v1',
    dismissedUpdate: 'uai:dismissed-update:v1',
    ratingFormatOnboardingSeen: 'uai:rating-format-onboarding:v2',
    translations: 'uai:interface-translations:v1',
    releaseUpdateHistory: 'uai:release-update-history:v1',
  };
  const $ = (s, r = document) => r.querySelector(s),
    $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v = '') =>
    String(v).replace(
      /[&<>'"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[c],
    );
  const countFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const formatCount = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? countFormatter.format(number) : '0';
  };
  const formatRank = (value) => {
    const rank = Number(value);
    if (!Number.isFinite(rank) || rank <= 0) return '';
    return rank < 1000 ? String(rank).padStart(3, '0') : formatCount(rank);
  };
  const CACHE_STORAGE_KEYS = new Set([STORE.meta, STORE.series]);
  const USER_STORAGE_KEYS = new Set(Object.values(STORE).filter((key) => !CACHE_STORAGE_KEYS.has(key)));
  const ALL_STORAGE_KEYS = new Set([...USER_STORAGE_KEYS, ...CACHE_STORAGE_KEYS]);
  let persistentUserData = {};
  let persistentCacheData = {};
  let persistentSaveTimer = null;
  let persistentSaveTask = Promise.resolve();

  function userStorageSnapshot() {
    return Object.fromEntries(
      Object.entries(persistentUserData).filter(([key]) => USER_STORAGE_KEYS.has(key)),
    );
  }

  function cacheStorageSnapshot() {
    return Object.fromEntries(
      Object.entries(persistentCacheData).filter(([key]) => CACHE_STORAGE_KEYS.has(key)),
    );
  }

  async function writePersistentUserData() {
    const response = await fetch('/api/local-user-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage: userStorageSnapshot() }),
    });
    if (!response.ok) throw new Error('local-data-save-failed');
  }

  async function writePersistentCacheData() {
    const response = await fetch('/api/local-cache-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storage: cacheStorageSnapshot() }),
    });
    if (!response.ok) throw new Error('local-cache-save-failed');
  }

  function schedulePersistentUserDataWrite() {
    clearTimeout(persistentSaveTimer);
    persistentSaveTimer = setTimeout(() => {
      persistentSaveTask = persistentSaveTask
        .catch(() => {})
        .then(() => Promise.all([writePersistentUserData(), writePersistentCacheData()]))
        .catch(() => {});
    }, 120);
  }

  async function loadPersistentUserData() {
    let fileStorage = {};
    let cacheStorage = {};
    try {
      const response = await fetch('/api/local-user-data', { cache: 'no-store' });
      const body = await response.json();
      if (response.ok && body.ok && body.storage && typeof body.storage === 'object')
        fileStorage = body.storage;
    } catch {}
    try {
      const response = await fetch('/api/local-cache-data', { cache: 'no-store' });
      const body = await response.json();
      if (response.ok && body.ok && body.storage && typeof body.storage === 'object')
        cacheStorage = body.storage;
    } catch {}
    persistentUserData = Object.fromEntries(
      Object.entries(fileStorage).filter(([key]) => USER_STORAGE_KEYS.has(key)),
    );
    persistentCacheData = Object.fromEntries(
      Object.entries({ ...fileStorage, ...cacheStorage }).filter(([key]) => CACHE_STORAGE_KEYS.has(key)),
    );

    const legacy = {};
    for (const key of ALL_STORAGE_KEYS) {
      try {
        const value = localStorage.getItem(key);
        if (value !== null) legacy[key] = JSON.parse(value);
      } catch {}
    }
    if (
      !Object.keys(persistentUserData).length &&
      !Object.keys(persistentCacheData).length &&
      Object.keys(legacy).length
    ) {
      persistentUserData = Object.fromEntries(
        Object.entries(legacy).filter(([key]) => USER_STORAGE_KEYS.has(key)),
      );
      persistentCacheData = Object.fromEntries(
        Object.entries(legacy).filter(([key]) => CACHE_STORAGE_KEYS.has(key)),
      );
      try {
        await Promise.all([writePersistentUserData(), writePersistentCacheData()]);
      } catch {
        return;
      }
    }
    // Versions before 2.3.3 kept the browser metadata cache inside user-data.json.
    // Rewrite both files once so user-data.json stays small, without discarding cache data.
    if (Object.keys(fileStorage).some((key) => CACHE_STORAGE_KEYS.has(key))) {
      try {
        await Promise.all([writePersistentUserData(), writePersistentCacheData()]);
      } catch {
        return;
      }
    }
    for (const key of ALL_STORAGE_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  }

  await loadPersistentUserData();
  const load = (k, d) => {
    try {
      const v = (CACHE_STORAGE_KEYS.has(k) ? persistentCacheData : persistentUserData)[k];
      return v ?? d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    if (CACHE_STORAGE_KEYS.has(k)) persistentCacheData[k] = v;
    else if (USER_STORAGE_KEYS.has(k)) persistentUserData[k] = v;
    else return;
    schedulePersistentUserDataWrite();
  };
  const savedUI = load(STORE.ui, {});
  let translationSettings = load(STORE.translations, {
    locale: 'en',
    source: 'english',
    pack: null,
    officialUpdates: {},
    officialCheck: {},
  });
  if (!translationSettings || typeof translationSettings !== 'object')
    translationSettings = {
      locale: 'en',
      source: 'english',
      pack: null,
      officialUpdates: {},
      officialCheck: {},
    };
  translationSettings.source = ['english', 'local', 'official'].includes(translationSettings.source)
    ? translationSettings.source
    : translationSettings.pack
      ? 'local'
      : 'english';
  translationSettings.officialUpdates =
    translationSettings.officialUpdates && typeof translationSettings.officialUpdates === 'object'
      ? translationSettings.officialUpdates
      : {};
  translationSettings.officialCheck =
    translationSettings.officialCheck && typeof translationSettings.officialCheck === 'object'
      ? translationSettings.officialCheck
      : {};
  const interfaceI18n = createInterfaceI18n();
  let officialTranslationRegistry = { languages: [] };
  let availableOfficialTranslations = new Map();
  let availableRemoteTranslation = null;
  try {
    if (translationSettings.source === 'local' && translationSettings.pack)
      interfaceI18n.setPack(validateTranslationPack(translationSettings.pack));
  } catch {
    translationSettings = {
      locale: 'en',
      source: 'english',
      pack: null,
      officialUpdates: {},
      officialCheck: {},
    };
  }
  const ADULT_CATALOG_TAG = 'Adult Catalog';
  const adultModes = ['all', 'ecchi', 'erotic', 'hentai', 'gore', 'violence', 'disturbing'];
  const collectionSortModes = [
    'rank',
    'overall',
    'production',
    'story',
    'emotional',
    'year',
    'title',
    'myrating',
  ];
  const collectionSortOrders = ['asc', 'desc'];
  const masterSortOrders = ['asc', 'desc'];
  const titleSortModes = ['rank', 'overall', 'production', 'story', 'emotional', 'year', 'title', 'myrating'];
  const CURATED_TIER_ORDER = ['S', 'A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'E', 'F'];
  const state = {
    visible: PAGE_SIZE,
    westernVisible: PAGE_SIZE,
    kidsVisible: PAGE_SIZE,
    compact: load(STORE.compact, false),
    westernCompact: savedUI.westernCompact === true,
    kidsCompact: savedUI.kidsCompact === true,
    tab: 'master',
    adult: adultModes.includes(savedUI.adult) ? savedUI.adult : 'all',
    collectionSort: collectionSortModes.includes(savedUI.collectionSort)
      ? savedUI.collectionSort
      : savedUI.collectionSort === 'rating'
        ? 'rank'
        : 'rank',
    collectionSortOrder: collectionSortOrders.includes(savedUI.collectionSortOrder)
      ? savedUI.collectionSortOrder
      : 'desc',
    masterSortOrder: masterSortOrders.includes(savedUI.masterSortOrder) ? savedUI.masterSortOrder : 'desc',
    westernSortOrder: masterSortOrders.includes(savedUI.westernSortOrder) ? savedUI.westernSortOrder : 'desc',
    kidsSortOrder: masterSortOrders.includes(savedUI.kidsSortOrder) ? savedUI.kidsSortOrder : 'desc',
    adultSortOrder: masterSortOrders.includes(savedUI.adultSortOrder) ? savedUI.adultSortOrder : 'desc',
    favoriteSortOrder: masterSortOrders.includes(savedUI.favoriteSortOrder)
      ? savedUI.favoriteSortOrder
      : 'desc',
    ratingFormat: normalizeRatingFormat(savedUI.ratingFormat),
    server: false,
    signerCompatible: false,
    signerFormat: 'UWL',
    keyId: '',
    updateToken: '',
    catalogWriteEnabled: false,
    catalogToken: '',
    serverCovers: 0,
    serverCoverTotal: 0,
    serverCoverRunning: false,
    serverArtworkFailed: 0,
    serverArtworkDone: 0,
    serverArtworkTotal: 0,
  };
  let artworkStatusPoll = null;
  let progress = load(STORE.progress, {}),
    myOpinions = load(STORE.opinions, {}),
    customTitles = load(STORE.custom, []),
    sources = load(STORE.sources, {}),
    meta = load(STORE.meta, {}),
    favorites = load(STORE.favorites, {}),
    episodeProgress = load(STORE.episodes, {}),
    seriesGroups = load(STORE.series, {}),
    franchiseProgress = load(STORE.franchiseProgress, {}),
    catalogDrafts = load(STORE.catalogCorrections, {}),
    coverOverrides = load(STORE.coverOverrides, {}),
    releaseUpdateHistory = load(STORE.releaseUpdateHistory, []);
  const META_TTL = 1000 * 60 * 60 * 24 * 30;
  // Missing artwork is retried periodically instead of being treated as a
  // permanently complete metadata response.
  const MISSING_COVER_RETRY_TTL = 1000 * 60 * 60;
  const SERIES_REFRESH_TTL = 1000 * 60 * 60 * 24;
  const NO_META = new URLSearchParams(location.search).has('nometa');
  const META_BATCH_SIZE = 12,
    META_BATCH_DELAY = 2200;
  const metaQueue = [],
    metaQueued = new Set();
  const seriesLoading = new Map();
  let metaPumping = false,
    metaSaveTimer = null;
  let availableUpdate = '';
  let pendingEpisodeAction = null;
  let masterItems = CAT.items || [];
  let masterById = new Map(masterItems.map((x) => [x.id, x]));
  const catalogPageTotals = {
    master: catalogBootstrap?.page?.total || masterItems.length,
    regions: 0,
    mature: 0,
    kids: 0,
  };
  const catalogPageLoads = new Map();
  const catalogPageCache = new Map();
  const catalogActivePageKeys = new Map();
  const catalogEntityLoads = new Map();
  const catalogIdMigrations =
    CAT.idMigrations && typeof CAT.idMigrations === 'object' && !Array.isArray(CAT.idMigrations)
      ? CAT.idMigrations
      : {};
  const aliasMap = new Map();
  let titleSearchIndex = new Map();
  let searchTimer = null;

  function migrateCatalogIdKeys(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    let changed = false;
    for (const [legacyId, currentId] of Object.entries(catalogIdMigrations)) {
      if (!Object.hasOwn(record, legacyId) || legacyId === currentId) continue;
      if (!Object.hasOwn(record, currentId)) record[currentId] = record[legacyId];
      delete record[legacyId];
      changed = true;
    }
    return changed;
  }

  function migrateLegacyCatalogUserData() {
    const affected = [
      [STORE.progress, progress],
      [STORE.opinions, myOpinions],
      [STORE.meta, meta],
      [STORE.favorites, favorites],
      [STORE.episodes, episodeProgress],
      [STORE.series, seriesGroups],
      [STORE.catalogCorrections, catalogDrafts],
      [STORE.coverOverrides, coverOverrides],
    ];
    for (const [key, record] of affected) if (migrateCatalogIdKeys(record)) save(key, record);
    let sourceChanged = false;
    for (const source of Object.values(sources)) {
      if (migrateCatalogIdKeys(source?.opinions)) sourceChanged = true;
    }
    if (sourceChanged) save(STORE.sources, sources);
  }

  migrateLegacyCatalogUserData();

  // Catalog identity and local state helpers
  function norm(s = '') {
    return String(s)
      .replace(/æ/gi, 'ae')
      .replace(/œ/gi, 'oe')
      .replace(/ß/g, 'ss')
      .replace(/ø/gi, 'o')
      .replace(/þ/gi, 'th')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\b(the|a|an)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function rebuildCatalogIdentityIndex() {
    aliasMap.clear();
    masterById = new Map(masterItems.map((x) => [x.id, x]));
    masterItems.forEach((x) => {
      aliasMap.set(norm(x.title), x.id);
      (x.aliases || []).forEach((a) => aliasMap.set(norm(a), x.id));
    });
  }
  rebuildCatalogIdentityIndex();

  function catalogScopeFilters(scope) {
    const config = {
      master: {
        search: 'searchInput',
        tier: 'tierFilter',
        type: 'typeFilter',
        genre: 'genreFilter',
        award: 'awardFilter',
        region: 'regionFilter',
        country: 'countryFilter',
        sort: 'sortSelect',
        status: 'statusFilter',
        hideCompleted: 'hideCompleted',
        customOnly: 'customOnly',
        order: () => state.masterSortOrder,
        visible: () => state.visible,
      },
      mature: {
        search: 'adultSearch',
        tier: 'adultTierFilter',
        type: 'adultTypeFilter',
        genre: 'adultGenreFilter',
        award: 'adultAwardFilter',
        region: 'adultRegionFilter',
        country: 'adultCountryFilter',
        sort: 'adultSort',
        status: 'adultStatusFilter',
        order: () => state.adultSortOrder,
        visible: () => PAGE_SIZE,
        matureMode: () => state.adult,
      },
      kids: {
        search: 'kidsSearch',
        tier: 'kidsTierFilter',
        type: 'kidsTypeFilter',
        genre: 'kidsGenreFilter',
        award: 'kidsAwardFilter',
        region: 'kidsRegionFilter',
        country: 'kidsCountryFilter',
        sort: 'kidsSort',
        status: 'kidsStatusFilter',
        hideCompleted: 'kidsHideCompleted',
        customOnly: 'kidsCustomOnly',
        order: () => state.kidsSortOrder,
        visible: () => state.kidsVisible,
      },
      regions: {
        search: 'westernSearch',
        tier: 'westernTierFilter',
        type: 'westernTypeFilter',
        genre: 'westernGenreFilter',
        region: 'westernRegionFilter',
        country: 'westernCountryFilter',
        sort: 'westernSort',
        status: 'westernStatusFilter',
        hideCompleted: 'westernHideCompleted',
        customOnly: 'westernCustomOnly',
        order: () => state.westernSortOrder,
        visible: () => state.westernVisible,
      },
    }[scope];
    if (!config) return {};
    const value = (id) => (id ? $('#' + id)?.value || '' : '');
    return {
      scope: scope === 'regions' ? 'master' : scope,
      q: value(config.search),
      tier: value(config.tier),
      type: value(config.type),
      genre: value(config.genre),
      award: value(config.award),
      region: value(config.region),
      country: value(config.country),
      sort: value(config.sort) || 'rank',
      order: config.order(),
      limit: config.visible(),
      status: value(config.status),
      hideCompleted: config.hideCompleted ? Boolean($('#' + config.hideCompleted)?.checked) : false,
      customOnly: config.customOnly ? Boolean($('#' + config.customOnly)?.checked) : false,
      ...(config.matureMode ? { matureMode: config.matureMode() } : {}),
    };
  }

  function applyCatalogPage(scope, result) {
    masterItems = result.items;
    catalogPageTotals[scope] = result.total;
    rebuildCatalogIdentityIndex();
    rebuildTitleSearchIndex();
  }

  async function loadCatalogPage(scope, { force = false } = {}) {
    if (!catalogBootstrap) return false;
    const filters = catalogScopeFilters(scope);
    const request = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== '' && value !== undefined && value !== null) request.set(key, String(value));
    });
    const key = `${scope}|${request}`;
    catalogActivePageKeys.set(scope, key);
    const isCurrentRequest = () => catalogActivePageKeys.get(scope) === key;
    if (!force && catalogPageCache.has(key)) {
      if (!isCurrentRequest()) return false;
      applyCatalogPage(scope, catalogPageCache.get(key));
      return true;
    }
    if (!force && catalogPageLoads.has(key)) return catalogPageLoads.get(key);
    const job = (async () => {
      try {
        if (filters.customOnly) {
          const result = { items: customTitles, total: customTitles.length };
          catalogPageCache.set(key, result);
          if (!isCurrentRequest()) return false;
          applyCatalogPage(scope, result);
          return true;
        }
        const response = await fetch('/api/catalog/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: filters, progress }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok || !Array.isArray(result.items)) throw new Error('catalog-page');
        catalogPageCache.set(key, result);
        // A user can change a filter, switch tabs or choose a region before a
        // previous response returns. Only the newest request for this scope is
        // allowed to replace the rendered card set.
        if (!isCurrentRequest()) return false;
        applyCatalogPage(scope, result);
        return true;
      } catch {
        // Keep the currently rendered page usable if a server is being restarted.
        return false;
      } finally {
        catalogPageLoads.delete(key);
      }
    })();
    catalogPageLoads.set(key, job);
    return job;
  }

  function refreshCatalogDestination(scope, render) {
    void loadCatalogPage(scope).then((loaded) => {
      if (loaded) render();
    });
  }

  async function loadCatalogEntity(kind) {
    if (!catalogBootstrap || !['collections', 'franchises'].includes(kind)) return CAT[kind] || [];
    if (Array.isArray(CAT[kind]) && CAT[kind].length) return CAT[kind];
    if (catalogEntityLoads.has(kind)) return catalogEntityLoads.get(kind);
    const job = fetch(`/api/catalog/entities?kind=${encodeURIComponent(kind)}`, { cache: 'no-store' })
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok || !body.ok || !Array.isArray(body.data)) throw new Error('catalog-entity');
        CAT[kind] = body.data;
        return CAT[kind];
      })
      .catch(() => CAT[kind] || [])
      .finally(() => catalogEntityLoads.delete(kind));
    catalogEntityLoads.set(kind, job);
    return job;
  }

  async function loadCatalogTitle(id) {
    const existing = itemById(id);
    if (!catalogBootstrap || !id || (existing && !existing.catalogSummary)) return existing;
    try {
      const response = await fetch(`/api/catalog/title/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.item?.id) return null;
      masterItems = [...masterItems.filter((item) => item.id !== result.item.id), result.item];
      rebuildCatalogIdentityIndex();
      rebuildTitleSearchIndex();
      return result.item;
    } catch {
      return null;
    }
  }

  async function loadFavoriteItems() {
    if (!catalogBootstrap) return false;
    const ids = Object.keys(favorites).filter((id) => favorites[id] === true);
    const key = `favorites|${ids.sort().join(',')}`;
    if (catalogPageCache.has(key)) {
      applyCatalogPage('favorites', catalogPageCache.get(key));
      return true;
    }
    try {
      const response = await fetch('/api/catalog/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: {
            scope: 'master',
            ids,
            onlyIds: true,
            limit: Math.max(PAGE_SIZE, ids.length),
            sort: 'rank',
          },
          progress,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.items)) return false;
      catalogPageCache.set(key, result);
      applyCatalogPage('favorites', result);
      return true;
    } catch {
      return false;
    }
  }

  async function loadFranchiseItems(franchise) {
    if (!catalogBootstrap || !franchise) return false;
    const ids = [
      ...new Set(
        (franchise.orders || [])
          .flatMap((order) => order.steps || [])
          .filter((step) => !isLiveActionFranchiseStep(step) && step.itemId)
          .map((step) => step.itemId),
      ),
    ];
    if (!ids.length) return false;
    const key = `franchise|${franchise.id}|${ids.join(',')}`;
    let result = catalogPageCache.get(key);
    if (!result) {
      try {
        const response = await fetch('/api/catalog/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: { scope: 'master', ids, onlyIds: true, limit: ids.length },
            progress,
          }),
        });
        result = await response.json();
        if (!response.ok || !result.ok || !Array.isArray(result.items)) return false;
        catalogPageCache.set(key, result);
      } catch {
        return false;
      }
    }
    const known = new Map(masterItems.map((item) => [item.id, item]));
    result.items.forEach((item) => known.set(item.id, item));
    masterItems = [...known.values()];
    rebuildCatalogIdentityIndex();
    rebuildTitleSearchIndex();
    return true;
  }

  async function loadCollectionItems(collection) {
    if (!catalogBootstrap || !collection) return false;
    const ids = [...new Set((collection.items || []).filter((id) => typeof id === 'string' && id))];
    if (!ids.length) return true;
    const key = `collection|${collection.id}|${ids.join(',')}`;
    let result = catalogPageCache.get(key);
    if (!result) {
      try {
        const response = await fetch('/api/catalog/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: { scope: 'master', ids, onlyIds: true, limit: ids.length },
            progress,
          }),
        });
        result = await response.json();
        if (!response.ok || !result.ok || !Array.isArray(result.items)) return false;
        catalogPageCache.set(key, result);
      } catch {
        return false;
      }
    }
    const known = new Map(masterItems.map((item) => [item.id, item]));
    result.items.forEach((item) => known.set(item.id, item));
    masterItems = [...known.values()];
    rebuildCatalogIdentityIndex();
    rebuildTitleSearchIndex();
    return true;
  }
  function itemWithCatalogDraft(item) {
    const draft = catalogDrafts[item?.id];
    if (!item || draft?.operation !== 'update') return item;
    return {
      ...item,
      scores: { ...draft.values.scores },
      content: { ...draft.values.content, tags: [...draft.values.content.tags] },
      coverSource: draft.values.coverSource || item.coverSource || '',
    };
  }
  function canonicalItems() {
    const out = masterItems.map(itemWithCatalogDraft);
    const seen = new Set(masterItems.map((x) => x.id));
    for (const c of customTitles) {
      if (!seen.has(c.id)) {
        out.push(c);
        seen.add(c.id);
      }
    }
    return out;
  }
  function itemById(id) {
    const official = masterById.get(id);
    return official ? itemWithCatalogDraft(official) : customTitles.find((x) => x.id === id) || null;
  }
  function coverSourceFor(item) {
    const source = coverOverrides[item?.id] || item?.coverSource;
    if (source && typeof source === 'object') return source;
    if (typeof source === 'string' && source.trim())
      return { url: source.trim(), status: 'pending', checkedAt: '' };
    return null;
  }
  function newCoverSource(url, status = 'pending', checkedAt = '') {
    const value = String(url || '').trim();
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Enter a valid HTTPS image URL.');
    }
    if (parsed.protocol !== 'https:' || value.length > 2000)
      throw new Error('Enter a valid HTTPS image URL.');
    return { url: value, status, checkedAt };
  }
  function saveCoverSource(item, source) {
    if (item?.custom) {
      item.coverSource = source;
      save(STORE.custom, customTitles);
    } else if (item?.id) {
      coverOverrides[item.id] = source;
      save(STORE.coverOverrides, coverOverrides);
    }
  }
  async function downloadManualCover(item, source, { verify = false, silent = false } = {}) {
    if (!item?.id || !source?.url || !state.server) return false;
    try {
      const response = await fetch('/api/artwork/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: source.url, verify }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'cover-download-failed');
      const checked = newCoverSource(source.url, 'verified', new Date().toISOString());
      saveCoverSource(item, checked);
      meta[item.id] = {
        ts: Date.now(),
        data: { ...(meta[item.id]?.data || {}), cover: result.cover, coverRemote: source.url },
      };
      save(STORE.meta, meta);
      refreshArtwork();
      if (!silent) toast('Cover downloaded and saved locally');
      return true;
    } catch {
      saveCoverSource(item, newCoverSource(source.url, 'dead', new Date().toISOString()));
      if (!silent) toast('Cover source is unavailable and has been marked dead');
      return false;
    }
  }
  async function hydrateManualCoverSources() {
    const retryAfter = 1000 * 60 * 60 * 24;
    for (const item of canonicalItems()) {
      const source = coverSourceFor(item);
      if (!source?.url) continue;
      const checked = Date.parse(source.checkedAt || '') || 0;
      const needsDownload = !(meta[item.id]?.data?.cover || '').startsWith('/covers/');
      if (needsDownload || !checked || Date.now() - checked >= retryAfter)
        await downloadManualCover(item, source, { verify: !needsDownload, silent: true });
    }
  }
  function markCoverWrong(item) {
    saveCoverSource(item, { url: '', status: 'wrong', checkedAt: new Date().toISOString() });
    toast('Cover marked wrong for UserList export');
  }
  function downloadLocalCover(item) {
    const cover = meta[item?.id]?.data?.cover || meta[item?.id]?.data?.image || '';
    if (!cover.startsWith('/covers/')) {
      toast('No locally cached cover is available');
      return;
    }
    const extension = cover.match(/\.(?:jpe?g|png|webp|avif|gif)$/i)?.[0] || '.jpg';
    const link = document.createElement('a');
    link.href = cover;
    link.download = `${
      String(item.title || 'cover')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '') || 'cover'
    }${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
  }
  function bindCoverManagement(item, prefix) {
    const fetchButton = $(`#${prefix}-fetch`);
    if (fetchButton)
      fetchButton.onclick = async () => {
        try {
          const source = newCoverSource($(`#${prefix}-url`).value);
          saveCoverSource(item, source);
          await downloadManualCover(item, source);
        } catch (error) {
          toast(error.message);
        }
      };
    const downloadButton = $(`#${prefix}-download`);
    if (downloadButton) downloadButton.onclick = () => downloadLocalCover(item);
    const wrongButton = $(`#${prefix}-wrong`);
    if (wrongButton)
      wrongButton.onclick = () => {
        markCoverWrong(item);
        wrongButton.textContent = 'COVER MARKED WRONG';
      };
  }
  function pFor(id) {
    return progress[id] || { status: 'Not started', rating: 0, note: '' };
  }
  function ownVerdict(id) {
    return myOpinions[id] || '';
  }
  function isFavorite(id) {
    return favorites[id] === true;
  }
  function syncFavoriteButtons(id) {
    const favorite = isFavorite(id);
    $$('[data-fav-id]')
      .filter((button) => button.dataset.favId === id)
      .forEach((button) => {
        const label = favorite ? 'Remove from favorites' : 'Add to favorites';
        button.classList.toggle('active', favorite);
        button.textContent = favorite ? '♥' : '♡';
        button.setAttribute('aria-label', label);
        button.dataset.tooltip = label;
        button.removeAttribute('title');
      });
  }
  function toggleFavorite(id) {
    if (!itemById(id)) return;
    if (isFavorite(id)) delete favorites[id];
    else favorites[id] = true;
    save(STORE.favorites, favorites);
    syncFavoriteButtons(id);
    if (catalogBootstrap) void loadFavoriteItems().then(renderFavorites);
    else renderFavorites();
    updateStats();
    toast(isFavorite(id) ? 'Added to favorites' : 'Removed from favorites');
  }
  function sourceOpinions(id) {
    const out = [];
    for (const [sid, s] of Object.entries(sources)) {
      const v = s.opinions?.[id];
      if (v) out.push({ sid, label: s.label, verdict: v });
    }
    return out;
  }
  function sourceBadgesHTML(id) {
    const ops = sourceOpinions(id);
    if (!ops.length) return '';
    return `<div class="source-badges">${ops
      .slice(0, 5)
      .map(
        (o) =>
          `<span class="source-badge ${o.verdict === 'recommend' ? 'rec' : 'no'}">${o.verdict === 'recommend' ? 'RECOMMENDED BY' : 'NOT RECOMMENDED BY'} ${esc(o.label)}</span>`,
      )
      .join('')}${ops.length > 5 ? `<span class="source-badge">+${ops.length - 5}</span>` : ''}</div>`;
  }
  function initials(t) {
    return t
      .replace(/\([^)]*\)/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((x) => x[0])
      .join('')
      .toUpperCase();
  }
  function displayType(x) {
    return x.type || meta[x.id]?.data?.format || 'Animation';
  }
  function liveYear(x) {
    return meta[x.id]?.data?.year || x.year || '—';
  }
  function liveGenres(x) {
    const g = meta[x.id]?.data?.genres;
    return Array.isArray(g) && g.length
      ? g
      : Array.isArray(x.genres)
        ? x.genres.filter(Boolean)
        : (x.genres || '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean);
  }

  function rebuildTitleSearchIndex() {
    titleSearchIndex = new Map(
      canonicalItems().map((item) => [
        item.id,
        norm(
          `${item.title} ${(item.aliases || []).join(' ')} ${item.genres || ''} ${item.editorial_note || item.why || ''} ${item.origin || ''} ${awardSearchText(item)}`,
        ),
      ]),
    );
  }

  function titleMatchesSearch(item, query) {
    if (!query) return true;
    const providerText = norm(meta[item.id]?.data?.studio || '');
    const indexed =
      titleSearchIndex.get(item.id) ||
      norm(
        `${item.title} ${(item.aliases || []).join(' ')} ${item.genres || ''} ${item.origin || ''} ${awardSearchText(item)}`,
      );
    return `${indexed} ${providerText}`.includes(query);
  }

  function geographyFilterIds(prefix = '') {
    return {
      region: prefix ? `${prefix}RegionFilter` : 'regionFilter',
      country: prefix ? `${prefix}CountryFilter` : 'countryFilter',
    };
  }

  function filterByGeography(items, prefix = '') {
    const ids = geographyFilterIds(prefix);
    const region = $('#' + ids.region)?.value || '';
    const country = $('#' + ids.country)?.value || '';
    return items.filter((item) => titleMatchesRegion(item, region) && titleMatchesCountry(item, country));
  }

  function geographyFacetScope(prefix) {
    if (prefix === 'adult') return 'mature';
    if (prefix === 'kids') return 'kids';
    if (prefix === 'favorite') return '';
    return 'master';
  }

  function scopedCatalogFacets(scope = 'master') {
    if (!catalogBootstrap?.facets) return null;
    if (scope === 'master') return catalogBootstrap.facets;
    return catalogBootstrap.scopeFacets?.[scope] || null;
  }

  function populateGeographyFilters(prefix, items) {
    const ids = geographyFilterIds(prefix);
    const regionSelect = $('#' + ids.region);
    const countrySelect = $('#' + ids.country);
    if (!regionSelect || !countrySelect) return;
    const savedRegion = regionSelect.value;
    const savedCountry = countrySelect.value;
    const facetScope = geographyFacetScope(prefix);
    const facets = scopedCatalogFacets(facetScope);
    // Server-backed lists are paged. Filter options must use the complete
    // scoped catalog, rather than whatever happens to be among 60 rendered
    // cards. Favorites intentionally remain local to the user's own list.
    if (facets) {
      const allRegions = catalogFacetValues('regions', REGIONS, facetScope);
      const countriesByRegion = facets.countriesByRegion || {};
      fill(regionSelect, allRegions);
      if ([...regionSelect.options].some((option) => option.value === savedRegion))
        regionSelect.value = savedRegion;
      const allCountries = catalogFacetValues('countries', [], facetScope);
      fill(countrySelect, countriesByRegion[regionSelect.value] || allCountries);
      if ([...countrySelect.options].some((option) => option.value === savedCountry))
        countrySelect.value = savedCountry;
      return;
    }
    fill(
      regionSelect,
      REGIONS.filter((region) => items.some((item) => titleMatchesRegion(item, region))),
    );
    if ([...regionSelect.options].some((option) => option.value === savedRegion))
      regionSelect.value = savedRegion;
    fill(countrySelect, countriesFor(items, regionSelect.value));
    if ([...countrySelect.options].some((option) => option.value === savedCountry))
      countrySelect.value = savedCountry;
  }

  function onRegionFilterChange(prefix, render) {
    const ids = geographyFilterIds(prefix);
    $('#' + ids.country).value = '';
    populateGeographyFilters(prefix, geographicScope(prefix));
    render();
  }

  function geographicScope(prefix) {
    if (prefix === 'western') return canonicalItems();
    if (prefix === 'kids') return forKidsItems();
    if (prefix === 'adult') return adultFilterItems();
    if (prefix === 'favorite') return canonicalItems().filter((item) => isFavorite(item.id));
    return canonicalItems();
  }

  function isWesternAni(x) {
    return /^(Western series|Western film)$/i.test(String(x?.type || '').trim());
  }

  function westernAniItems() {
    return canonicalItems().filter(isWesternAni);
  }

  const FOR_KIDS_GENRES = new Set(['family', 'kids', 'children', 'childrens']);
  const NOT_FOR_KIDS_LABEL = 'Not for Kids';

  function hasNotForKidsOverride(item) {
    return (item?.content?.tags || []).some((tag) => norm(tag) === norm(NOT_FOR_KIDS_LABEL));
  }

  function isForKidsCandidate(item) {
    return liveGenres(item).some((genre) => FOR_KIDS_GENRES.has(norm(genre)));
  }
  function isForKids(item) {
    return (
      (isForKidsCandidate(item) || (item?.content?.tags || []).some((tag) => norm(tag) === 'for kids')) &&
      !hasNotForKidsOverride(item)
    );
  }

  function forKidsItems() {
    return canonicalItems().filter(isForKids);
  }

  // Master-list filtering and sorting
  function catalogFacetValues(key, fallback, scope = 'master') {
    const values = scopedCatalogFacets(scope)?.[key];
    return Array.isArray(values) && values.length ? values : fallback;
  }
  function restoreLazyControlValues(ids) {
    ids.forEach((id) => {
      const control = $('#' + id);
      const value = savedUI[id];
      if (
        control instanceof HTMLSelectElement &&
        typeof value === 'string' &&
        [...control.options].some((option) => option.value === value)
      )
        control.value = value;
    });
  }
  function populateFilters({ eager = true } = {}) {
    const items = canonicalItems();
    fill(
      $('#tierFilter'),
      sortCuratedTiers(
        catalogFacetValues('tiers', [
          ...new Set(items.map((x) => normalizeCuratedTier(x.tier)).filter(Boolean)),
        ]),
      ),
      (tier) => qualityRatingLabel(tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }),
    );
    populateGeographyFilters('', items);
    renderStarTierFilter();
    populateAwardFilter($('#awardFilter'), items);
    fill(
      $('#typeFilter'),
      catalogFacetValues('types', [...new Set(items.map(displayType).filter(Boolean))].sort()),
    );
    fill(
      $('#genreFilter'),
      catalogFacetValues('genres', [...new Set(items.flatMap(liveGenres).filter(Boolean))].sort()),
    );
    if (eager) {
      populateAdultFilters();
      populateWesternFilters();
      populateKidsFilters();
    }
  }
  function populateAdultFilters() {
    const items = adultFilterItems();
    fill(
      $('#adultTierFilter'),
      sortCuratedTiers(
        catalogFacetValues(
          'tiers',
          [...new Set(items.map((x) => normalizeCuratedTier(x.tier)).filter(Boolean))],
          'mature',
        ),
      ),
      (tier) => qualityRatingLabel(tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }),
    );
    renderStarTierFilter('adultTierFilter', 'adultStarTierFilter');
    populateAwardFilter($('#adultAwardFilter'), items);
    fill(
      $('#adultTypeFilter'),
      catalogFacetValues('types', [...new Set(items.map(displayType).filter(Boolean))].sort(), 'mature'),
    );
    fill(
      $('#adultGenreFilter'),
      catalogFacetValues('genres', [...new Set(items.flatMap(liveGenres).filter(Boolean))].sort(), 'mature'),
    );
    restoreLazyControlValues([
      'adultTierFilter',
      'adultAwardFilter',
      'adultTypeFilter',
      'adultGenreFilter',
      'adultRegionFilter',
      'adultCountryFilter',
      'adultStatusFilter',
      'adultSort',
    ]);
    populateGeographyFilters('adult', items);
  }
  function populateWesternFilters() {
    const items = canonicalItems();
    fill(
      $('#westernTierFilter'),
      sortCuratedTiers(
        catalogFacetValues('tiers', [
          ...new Set(items.map((x) => normalizeCuratedTier(x.tier)).filter(Boolean)),
        ]),
      ),
      (tier) => qualityRatingLabel(tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }),
    );
    renderStarTierFilter('westernTierFilter', 'westernStarTierFilter');
    fill(
      $('#westernTypeFilter'),
      catalogFacetValues('types', [...new Set(items.map(displayType).filter(Boolean))].sort()),
    );
    fill(
      $('#westernGenreFilter'),
      catalogFacetValues('genres', [...new Set(items.flatMap(liveGenres).filter(Boolean))].sort()),
    );
    restoreLazyControlValues([
      'westernTierFilter',
      'westernTypeFilter',
      'westernGenreFilter',
      'westernRegionFilter',
      'westernCountryFilter',
      'westernStatusFilter',
      'westernSort',
    ]);
    populateGeographyFilters('western', items);
  }
  function populateKidsFilters() {
    const items = forKidsItems();
    fill(
      $('#kidsTierFilter'),
      sortCuratedTiers(
        catalogFacetValues(
          'tiers',
          [...new Set(items.map((x) => normalizeCuratedTier(x.tier)).filter(Boolean))],
          'kids',
        ),
      ),
      (tier) => qualityRatingLabel(tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }),
    );
    renderStarTierFilter('kidsTierFilter', 'kidsStarTierFilter');
    fill(
      $('#kidsTypeFilter'),
      catalogFacetValues('types', [...new Set(items.map(displayType).filter(Boolean))].sort(), 'kids'),
    );
    fill(
      $('#kidsGenreFilter'),
      catalogFacetValues('genres', [...new Set(items.flatMap(liveGenres).filter(Boolean))].sort(), 'kids'),
    );
    restoreLazyControlValues([
      'kidsTierFilter',
      'kidsTypeFilter',
      'kidsGenreFilter',
      'kidsRegionFilter',
      'kidsCountryFilter',
      'kidsStatusFilter',
      'kidsSort',
    ]);
    populateGeographyFilters('kids', items);
  }
  const initializedDestinationFilters = new Set(['master']);
  function ensureDestinationFilters(tab) {
    if (initializedDestinationFilters.has(tab)) return;
    if (tab === 'regions') populateWesternFilters();
    if (tab === 'adult') populateAdultFilters();
    if (tab === 'kids') populateKidsFilters();
    initializedDestinationFilters.add(tab);
  }

  function restoreGeographyControls(tab) {
    populateGeographyFilters('', canonicalItems());
    if (tab === 'regions') populateGeographyFilters('western', canonicalItems());
    if (tab === 'adult') populateGeographyFilters('adult', adultFilterItems());
    if (tab === 'kids') populateGeographyFilters('kids', forKidsItems());
  }
  function fill(sel, vals, label = (value) => value) {
    const selected = sel.value;
    const first = sel.options[0];
    sel.innerHTML = '';
    sel.append(first);
    for (const v of vals) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label(v).toUpperCase();
      sel.append(o);
    }
    if ([...sel.options].some((option) => option.value === selected)) sel.value = selected;
  }

  function populateAwardFilter(select, items) {
    if (!select) return;
    const selected = select.value;
    select.replaceChildren();
    const add = (parent, value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      parent.append(option);
    };
    add(select, '', 'ALL AWARDS');
    add(select, 'any', 'ANY AWARD');
    add(select, 'winner', 'HAS A WIN');
    add(select, 'nominee', 'HAS NOMINEE RECORD');
    const programs = awardProgramOptions(items);
    if (programs.length) {
      const group = document.createElement('optgroup');
      group.label = 'AWARD PROGRAMS';
      programs.forEach((program) => add(group, program.value, `${program.label} · ${program.items}`));
      select.append(group);
    }
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }

  function sortCuratedTiers(values) {
    return [...values].sort((a, b) => {
      const aIndex = CURATED_TIER_ORDER.indexOf(String(a).toUpperCase());
      const bIndex = CURATED_TIER_ORDER.indexOf(String(b).toUpperCase());
      return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex) || String(a).localeCompare(String(b));
    });
  }

  function renderStarTierFilter(nativeId = 'tierFilter', controlId = 'starTierFilter') {
    const native = $('#' + nativeId);
    const existing = $('#' + controlId);
    if (existing) existing.remove();
    const usesStars = state.ratingFormat === 'stars';
    native.classList.toggle('star-tier-native', usesStars);
    if (!usesStars) return;

    const control = document.createElement('div');
    control.id = controlId;
    control.className = 'star-tier-filter';
    native.insertAdjacentElement('afterend', control);

    const render = () => {
      const selected = native.options[native.selectedIndex];
      const selectedLabel = selected.value ? qualityRatingBadgeHTML(selected.value) : 'ALL TIERS';
      control.innerHTML = `<button type="button" class="star-tier-trigger" aria-haspopup="listbox" aria-expanded="false">${selectedLabel}<span class="star-tier-chevron" aria-hidden="true"></span></button><div class="star-tier-menu" role="listbox" aria-label="${esc(native.getAttribute('aria-label') || 'Quality tier')}">${[
        ...native.options,
      ]
        .map(
          (option) =>
            `<button type="button" role="option" aria-selected="${option.selected}" data-star-tier="${esc(option.value)}">${option.value ? qualityRatingBadgeHTML(option.value) : 'ALL TIERS'}</button>`,
        )
        .join('')}</div>`;
      const trigger = $('.star-tier-trigger', control);
      trigger.addEventListener('click', () => {
        const open = control.classList.toggle('open');
        trigger.setAttribute('aria-expanded', String(open));
      });
      $$('[data-star-tier]', control).forEach((button) =>
        button.addEventListener('click', () => {
          native.value = button.dataset.starTier;
          native.dispatchEvent(new Event('change', { bubbles: true }));
          render();
        }),
      );
    };
    render();
  }

  const UI_VALUE_FIELDS = [
    'searchInput',
    'tierFilter',
    'awardFilter',
    'awardFilter',
    'typeFilter',
    'genreFilter',
    'regionFilter',
    'countryFilter',
    'statusFilter',
    'sortSelect',
    'westernSearch',
    'westernTierFilter',
    'westernTypeFilter',
    'westernGenreFilter',
    'westernRegionFilter',
    'westernCountryFilter',
    'westernStatusFilter',
    'westernSort',
    'adultSearch',
    'adultTierFilter',
    'adultAwardFilter',
    'adultAwardFilter',
    'adultTypeFilter',
    'adultGenreFilter',
    'adultRegionFilter',
    'adultCountryFilter',
    'adultStatusFilter',
    'adultSort',
    'kidsSearch',
    'kidsTierFilter',
    'kidsTypeFilter',
    'kidsGenreFilter',
    'kidsRegionFilter',
    'kidsCountryFilter',
    'kidsStatusFilter',
    'kidsSort',
    'collectionSearch',
    'franchiseSearch',
    'favoriteSearch',
    'favoriteAwardFilter',
    'favoriteSort',
    'favoriteRegionFilter',
    'favoriteCountryFilter',
  ];
  const UI_CHECKBOX_FIELDS = [
    'hideCompleted',
    'customOnly',
    'westernHideCompleted',
    'westernCustomOnly',
    'kidsHideCompleted',
    'kidsCustomOnly',
  ];
  const URL_VALUE_FIELDS = {
    searchInput: 'q',
    tierFilter: 'tier',
    awardFilter: 'award',
    typeFilter: 'format',
    genreFilter: 'genre',
    regionFilter: 'region',
    countryFilter: 'country',
    statusFilter: 'status',
    sortSelect: 'sort',
    westernSearch: 'wq',
    westernTierFilter: 'wtier',
    westernTypeFilter: 'wformat',
    westernGenreFilter: 'wgenre',
    westernRegionFilter: 'wregion',
    westernCountryFilter: 'wcountry',
    westernStatusFilter: 'wstatus',
    westernSort: 'wsort',
    adultSearch: 'aq',
    adultTierFilter: 'atier',
    adultAwardFilter: 'aaward',
    adultTypeFilter: 'aformat',
    adultGenreFilter: 'agenre',
    adultRegionFilter: 'aregion',
    adultCountryFilter: 'acountry',
    adultStatusFilter: 'astatus',
    adultSort: 'asort',
    kidsSearch: 'kq',
    kidsTierFilter: 'ktier',
    kidsTypeFilter: 'kformat',
    kidsGenreFilter: 'kgenre',
    kidsRegionFilter: 'kregion',
    kidsCountryFilter: 'kcountry',
    kidsStatusFilter: 'kstatus',
    kidsSort: 'ksort',
    collectionSearch: 'cq',
    franchiseSearch: 'fq',
    favoriteSearch: 'favq',
    favoriteAwardFilter: 'favaward',
    favoriteSort: 'favsort',
    favoriteRegionFilter: 'favregion',
    favoriteCountryFilter: 'favcountry',
  };
  const URL_CHECKBOX_FIELDS = {
    hideCompleted: 'hide',
    customOnly: 'custom',
    westernHideCompleted: 'whide',
    westernCustomOnly: 'wcustom',
    kidsHideCompleted: 'khide',
    kidsCustomOnly: 'kcustom',
  };
  let urlExpandedFranchiseIds = [];
  let urlOpenDetailId = '';
  let urlOpenCollectionId = '';

  function encodeNavigationFilter(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }

  function decodeNavigationFilter(value) {
    if (!value) return null;
    try {
      const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4);
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      return payload?.v === 1 && payload.values && payload.settings ? payload : null;
    } catch {
      return null;
    }
  }

  function navigationFilterPayload() {
    const values = {};
    const checks = {};
    Object.keys(URL_VALUE_FIELDS).forEach((id) => {
      const value = $('#' + id)?.value || '';
      if (value) values[id] = value;
    });
    Object.keys(URL_CHECKBOX_FIELDS).forEach((id) => {
      if ($('#' + id)?.checked) checks[id] = true;
    });
    return {
      v: 1,
      values,
      checks,
      settings: {
        adult: state.adult,
        masterSortOrder: state.masterSortOrder,
        westernSortOrder: state.westernSortOrder,
        kidsSortOrder: state.kidsSortOrder,
        adultSortOrder: state.adultSortOrder,
        favoriteSortOrder: state.favoriteSortOrder,
        collectionSort: state.collectionSort,
        collectionSortOrder: state.collectionSortOrder,
        compact: state.compact,
        westernCompact: state.westernCompact,
        kidsCompact: state.kidsCompact,
        visible: state.visible,
        westernVisible: state.westernVisible,
        kidsVisible: state.kidsVisible,
      },
      franchises: $$('details.franchise[open]', $('#franchiseStack'))
        .map((details) => details.dataset.franchiseId)
        .filter(Boolean),
      detail: $('#detailDialog').open ? $('#dialogBody').dataset.itemId || '' : '',
      collection: $('#collectionDialog').open ? $('#collectionDialog').dataset.collectionId || '' : '',
    };
  }

  function setControlFromUrl(id, value) {
    const control = $('#' + id);
    if (!control || value === null) return;
    if (
      control instanceof HTMLSelectElement &&
      ![...control.options].some((option) => option.value === value)
    )
      return;
    control.value = value;
  }

  function applyUrlNavigationState() {
    const params = new URL(location.href).searchParams;
    const filter = decodeNavigationFilter(params.get('filter'));
    if (filter) {
      urlExpandedFranchiseIds = Array.isArray(filter.franchises) ? filter.franchises.filter(Boolean) : [];
      urlOpenDetailId = typeof filter.detail === 'string' ? filter.detail : '';
      urlOpenCollectionId = typeof filter.collection === 'string' ? filter.collection : '';
      Object.keys(URL_VALUE_FIELDS).forEach((id) => setControlFromUrl(id, filter.values[id] ?? null));
      Object.keys(URL_CHECKBOX_FIELDS).forEach((id) => {
        $('#' + id).checked = filter.checks[id] === true;
      });
      const settings = filter.settings;
      if (adultModes.includes(settings.adult)) state.adult = settings.adult;
      if (masterSortOrders.includes(settings.masterSortOrder))
        state.masterSortOrder = settings.masterSortOrder;
      if (masterSortOrders.includes(settings.westernSortOrder))
        state.westernSortOrder = settings.westernSortOrder;
      if (masterSortOrders.includes(settings.kidsSortOrder)) state.kidsSortOrder = settings.kidsSortOrder;
      if (masterSortOrders.includes(settings.adultSortOrder)) state.adultSortOrder = settings.adultSortOrder;
      if (masterSortOrders.includes(settings.favoriteSortOrder))
        state.favoriteSortOrder = settings.favoriteSortOrder;
      if (collectionSortModes.includes(settings.collectionSort))
        state.collectionSort = settings.collectionSort;
      if (collectionSortOrders.includes(settings.collectionSortOrder))
        state.collectionSortOrder = settings.collectionSortOrder;
      if (typeof settings.compact === 'boolean') state.compact = settings.compact;
      if (typeof settings.westernCompact === 'boolean') state.westernCompact = settings.westernCompact;
      if (typeof settings.kidsCompact === 'boolean') state.kidsCompact = settings.kidsCompact;
      if (Number.isInteger(settings.visible)) state.visible = Math.max(PAGE_SIZE, settings.visible);
      if (Number.isInteger(settings.westernVisible))
        state.westernVisible = Math.max(PAGE_SIZE, settings.westernVisible);
      if (Number.isInteger(settings.kidsVisible))
        state.kidsVisible = Math.max(PAGE_SIZE, settings.kidsVisible);
      renderSortOrderButton($('#masterSortOrder'), state.masterSortOrder);
      renderSortOrderButton($('#westernSortOrder'), state.westernSortOrder);
      renderSortOrderButton($('#kidsSortOrder'), state.kidsSortOrder);
      renderSortOrderButton($('#adultSortOrder'), state.adultSortOrder);
      renderSortOrderButton($('#favoriteSortOrder'), state.favoriteSortOrder);
      $$('.adult-chip').forEach((button) =>
        button.classList.toggle('active', button.dataset.adult === state.adult),
      );
      return;
    }
    urlExpandedFranchiseIds = params.getAll('fx').filter(Boolean);
    urlOpenDetailId = '';
    urlOpenCollectionId = '';
    Object.entries(URL_VALUE_FIELDS).forEach(([id, key]) => setControlFromUrl(id, params.get(key)));
    Object.entries(URL_CHECKBOX_FIELDS).forEach(([id, key]) => {
      if (params.has(key)) $('#' + id).checked = params.get(key) === '1';
    });
    if (adultModes.includes(params.get('adult'))) state.adult = params.get('adult');
    if (masterSortOrders.includes(params.get('order'))) state.masterSortOrder = params.get('order');
    if (masterSortOrders.includes(params.get('worder'))) state.westernSortOrder = params.get('worder');
    if (masterSortOrders.includes(params.get('korder'))) state.kidsSortOrder = params.get('korder');
    if (masterSortOrders.includes(params.get('aorder'))) state.adultSortOrder = params.get('aorder');
    if (masterSortOrders.includes(params.get('favorder'))) state.favoriteSortOrder = params.get('favorder');
    if (params.has('compact')) state.compact = params.get('compact') === '1';
    if (params.has('wcompact')) state.westernCompact = params.get('wcompact') === '1';
    if (params.has('kcompact')) state.kidsCompact = params.get('kcompact') === '1';
    if (Number.isInteger(Number(params.get('limit'))))
      state.visible = Math.max(PAGE_SIZE, Number(params.get('limit')));
    if (Number.isInteger(Number(params.get('wlimit'))))
      state.westernVisible = Math.max(PAGE_SIZE, Number(params.get('wlimit')));
    if (Number.isInteger(Number(params.get('klimit'))))
      state.kidsVisible = Math.max(PAGE_SIZE, Number(params.get('klimit')));
    renderSortOrderButton($('#masterSortOrder'), state.masterSortOrder);
    renderSortOrderButton($('#westernSortOrder'), state.westernSortOrder);
    renderSortOrderButton($('#kidsSortOrder'), state.kidsSortOrder);
    renderSortOrderButton($('#adultSortOrder'), state.adultSortOrder);
    renderSortOrderButton($('#favoriteSortOrder'), state.favoriteSortOrder);
    $$('.adult-chip').forEach((button) =>
      button.classList.toggle('active', button.dataset.adult === state.adult),
    );
  }

  function syncNavigationUrl({ history = 'replace' } = {}) {
    const url = new URL(location.href);
    Object.values(URL_VALUE_FIELDS).forEach((key) => url.searchParams.delete(key));
    Object.values(URL_CHECKBOX_FIELDS).forEach((key) => url.searchParams.delete(key));
    [
      'adult',
      'order',
      'worder',
      'korder',
      'aorder',
      'favorder',
      'compact',
      'wcompact',
      'kcompact',
      'limit',
      'wlimit',
      'klimit',
      'fx',
    ].forEach((key) => url.searchParams.delete(key));
    url.searchParams.set('filter', encodeNavigationFilter(navigationFilterPayload()));
    url.hash = state.tab;
    const method = history === 'push' ? 'pushState' : 'replaceState';
    window.history[method](null, '', url);
  }

  function restoreUIState() {
    for (const id of UI_VALUE_FIELDS) {
      const control = $('#' + id);
      const value = savedUI[id];
      if (typeof value !== 'string') continue;
      if (
        control instanceof HTMLSelectElement &&
        ![...control.options].some((option) => option.value === value)
      )
        continue;
      control.value = value;
    }
    for (const id of UI_CHECKBOX_FIELDS) {
      if (typeof savedUI[id] === 'boolean') $('#' + id).checked = savedUI[id];
    }
    $('#ratingFormatSelect').value = state.ratingFormat;
    renderSortOrderButton($('#masterSortOrder'), state.masterSortOrder);
    renderSortOrderButton($('#westernSortOrder'), state.westernSortOrder);
    renderSortOrderButton($('#kidsSortOrder'), state.kidsSortOrder);
    renderSortOrderButton($('#adultSortOrder'), state.adultSortOrder);
    renderSortOrderButton($('#favoriteSortOrder'), state.favoriteSortOrder);
    $$('.adult-chip').forEach((button) =>
      button.classList.toggle('active', button.dataset.adult === state.adult),
    );
  }

  function saveUIState() {
    const next = {
      adult: state.adult,
      collectionSort: state.collectionSort,
      collectionSortOrder: state.collectionSortOrder,
      masterSortOrder: state.masterSortOrder,
      westernSortOrder: state.westernSortOrder,
      westernCompact: state.westernCompact,
      kidsSortOrder: state.kidsSortOrder,
      kidsCompact: state.kidsCompact,
      adultSortOrder: state.adultSortOrder,
      favoriteSortOrder: state.favoriteSortOrder,
      ratingFormat: state.ratingFormat,
      interfaceLocale: translationSettings.locale || 'en',
    };
    for (const id of UI_VALUE_FIELDS) next[id] = $('#' + id).value;
    for (const id of UI_CHECKBOX_FIELDS) next[id] = $('#' + id).checked;
    save(STORE.ui, next);
    syncNavigationUrl();
  }

  function filteredMaster() {
    const all = canonicalItems(),
      q = norm($('#searchInput').value),
      tier = $('#tierFilter').value,
      award = $('#awardFilter').value,
      type = $('#typeFilter').value,
      genre = $('#genreFilter').value,
      status = $('#statusFilter').value;
    let out = filterByGeography(all, '').filter((x) => {
      const p = pFor(x.id);
      if (!titleMatchesSearch(x, q)) return false;
      if (!matchesAwardFilter(x, award)) return false;
      if (tier && normalizeCuratedTier(x.tier) !== tier) return false;
      if (type && displayType(x) !== type) return false;
      if (genre && !liveGenres(x).includes(genre)) return false;
      if (status && p.status !== status) return false;
      if ($('#hideCompleted').checked && p.status === 'Completed') return false;
      if ($('#customOnly').checked && !x.custom) return false;
      return true;
    });
    return sortTitleItems(out, $('#sortSelect').value, state.masterSortOrder);
  }

  function filteredWestern() {
    const q = norm($('#westernSearch').value),
      tier = $('#westernTierFilter').value,
      type = $('#westernTypeFilter').value,
      genre = $('#westernGenreFilter').value,
      status = $('#westernStatusFilter').value;
    const out = filterByGeography(canonicalItems(), 'western').filter((x) => {
      const p = pFor(x.id);
      if (!titleMatchesSearch(x, q)) return false;
      if (tier && normalizeCuratedTier(x.tier) !== tier) return false;
      if (type && displayType(x) !== type) return false;
      if (genre && !liveGenres(x).includes(genre)) return false;
      if (status && p.status !== status) return false;
      if ($('#westernHideCompleted').checked && p.status === 'Completed') return false;
      if ($('#westernCustomOnly').checked && !x.custom) return false;
      return true;
    });
    const sort = titleSortModes.includes($('#westernSort').value) ? $('#westernSort').value : 'rank';
    return sortTitleItems(out, sort, state.westernSortOrder);
  }

  function filteredKids() {
    const q = norm($('#kidsSearch').value),
      tier = $('#kidsTierFilter').value,
      type = $('#kidsTypeFilter').value,
      genre = $('#kidsGenreFilter').value,
      status = $('#kidsStatusFilter').value;
    const out = filterByGeography(forKidsItems(), 'kids').filter((x) => {
      const p = pFor(x.id);
      if (!titleMatchesSearch(x, q)) return false;
      if (tier && normalizeCuratedTier(x.tier) !== tier) return false;
      if (type && displayType(x) !== type) return false;
      if (genre && !liveGenres(x).includes(genre)) return false;
      if (status && p.status !== status) return false;
      if ($('#kidsHideCompleted').checked && p.status === 'Completed') return false;
      if ($('#kidsCustomOnly').checked && !x.custom) return false;
      return true;
    });
    const sort = titleSortModes.includes($('#kidsSort').value) ? $('#kidsSort').value : 'rank';
    return sortTitleItems(out, sort, state.kidsSortOrder);
  }

  function sortTitleItems(items, sort, order) {
    const out = [...items];
    const score = (x, k) => x.scores?.[k] ?? x[k] ?? 0;
    const direction = order === 'asc' ? 1 : -1;
    const rank = (item) => item.rank ?? 999999;
    const compareKnownNumbers = (a, b, value) => {
      const aValue = Number(value(a)) || 0;
      const bValue = Number(value(b)) || 0;
      if (Boolean(aValue) !== Boolean(bValue)) return aValue ? -1 : 1;
      return (aValue - bValue) * direction;
    };
    if (sort === 'rank')
      out.sort((a, b) => {
        const aRanked = Number.isFinite(a.rank);
        const bRanked = Number.isFinite(b.rank);
        if (aRanked !== bRanked) return aRanked ? -1 : 1;
        return (rank(b) - rank(a)) * direction || a.title.localeCompare(b.title);
      });
    else if (['overall', 'production', 'story', 'emotional'].includes(sort))
      out.sort((a, b) => compareKnownNumbers(a, b, (item) => score(item, sort)) || rank(a) - rank(b));
    else if (sort === 'year') out.sort((a, b) => compareKnownNumbers(a, b, liveYear) || rank(a) - rank(b));
    else if (sort === 'title')
      out.sort((a, b) => a.title.localeCompare(b.title) * direction || rank(a) - rank(b));
    else if (sort === 'myrating')
      out.sort(
        (a, b) => compareKnownNumbers(a, b, (item) => Number(pFor(item.id).rating) || 0) || rank(a) - rank(b),
      );
    return out;
  }

  function statusMarkHTML(status = 'Not started') {
    const marks = {
      'Not started': {
        slug: 'not-started',
        icon: '<circle cx="12" cy="12" r="7.5" stroke-dasharray="2.5 3.5"></circle>',
      },
      Watching: {
        slug: 'watching',
        icon: '<path d="M9 7.5 17 12l-8 4.5z"></path>',
      },
      Completed: {
        slug: 'completed',
        icon: '<path d="m7.5 12.5 3 3 6.5-7"></path>',
      },
      'On hold': {
        slug: 'on-hold',
        icon: '<path d="M9.5 8v8M14.5 8v8"></path>',
      },
      Dropped: {
        slug: 'dropped',
        icon: '<path d="m8.5 8.5 7 7m0-7-7 7"></path>',
      },
    };
    const mark = marks[status] || marks['Not started'];
    const label = `Watch status: ${status}`;
    const text = status === 'Completed' ? '<b>COMPLETED</b>' : '';
    return `<span class="status-mark status-${mark.slug}" role="img" aria-label="${esc(label)}" data-tooltip="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${mark.icon}</svg>${text}</span>`;
  }

  function qualityRatingBadgeHTML(tier) {
    const label = qualityRatingLabel(tier, state.ratingFormat);
    if (state.ratingFormat !== 'stars' || !label.includes('★')) return esc(label);
    const full = (label.match(/★/g) || []).length;
    const half = label.includes('½');
    return `<span class="quality-star-badge" role="img" aria-label="${esc(label.replace('½', ' and a half stars'))}">${Array.from(
      { length: 5 },
      (_, index) =>
        `<i class="${index < full ? 'is-full' : index === full && half ? 'is-half' : ''}" aria-hidden="true">★</i>`,
    ).join('')}</span>`;
  }

  function cardHTML(x, { adult = false } = {}) {
    const m = meta[x.id]?.data || {},
      p = pFor(x.id),
      verdict = ownVerdict(x.id),
      cover = m.cover || m.image || '';
    const rankDigits = x.rank ? formatRank(x.rank) : '';
    const rank = x.rank ? `#${rankDigits}` : 'ADD';
    const rankClass = x.rank
      ? `rank rank--${Math.min(5, Math.max(3, rankDigits.length))}-digits`
      : 'rank rank--custom';
    const tags = liveGenres(x).slice(0, 3);
    const sc = x.scores || {
      overall: x.fit_score || 0,
      production: x.production || 0,
      story: x.story || 0,
      emotional: 7,
    };
    const verdictBadge = verdict
      ? `<span class="own-verdict ${verdict}">${verdict === 'recommend' ? '★ REC' : '× NO'}</span>`
      : '';
    const fav = isFavorite(x.id);
    const content = adult ? contentGuide(x, true) : '';
    const tierBadge = qualityRatingBadgeHTML(x.tier);
    return `<article class="title-card ${p.status === 'Completed' ? 'is-completed' : ''}" data-id="${esc(x.id)}">
      <button class="card-open" data-card-open-id="${esc(x.id)}" type="button" aria-label="${esc(`Open details for ${x.title}`)}"></button>
      <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="${esc(x.title)} cover">` : `<div class="cover-placeholder">${esc(initials(x.title))}</div>`}<span class="${rankClass}">${rank}</span><span class="tier">${tierBadge}</span><button class="favorite-toggle ${fav ? 'active' : ''}" data-fav-id="${esc(x.id)}" type="button" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" data-tooltip="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '♥' : '♡'}</button>${statusMarkHTML(p.status)}${verdictBadge}</div>
      <div class="card-body"><div class="card-meta">${esc(displayType(x).toUpperCase())} // ${esc(liveYear(x))} // ${esc((m.studio || x.origin || '').toUpperCase())}</div><h3>${esc(x.title)}</h3>
      <div class="tag-row">${tags.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}${awardSummaryBadgeHTML(x)}</div>${sourceBadgesHTML(x.id)}${content}
      <div class="score-line"><div class="score-bit"><b>${sc.overall || '—'}</b><span>OVERALL</span></div><div class="score-bit"><b>${sc.production || '—'}</b><span>PROD</span></div><div class="score-bit"><b>${sc.story || '—'}</b><span>STORY</span></div><div class="score-bit"><b>${sc.emotional || '—'}</b><span>EMOTION</span></div></div></div></article>`;
  }
  function contentGuide(x, compact = false) {
    const c = x.content || {};
    const defs = [
      ['Sexual content', 'Sexual', c.sex || 0],
      ['Nudity', 'Nudity', c.nudity || 0],
      ['Violence', 'Violence', c.violence || 0],
      ['Gore', 'Gore', c.gore || 0],
      ['Disturbing content', 'Disturbing', c.disturbing || 0],
    ];
    const words = ['None', 'Mild', 'Moderate', 'Strong', 'Very strong', 'Extreme'];
    return `<div class="content-guide ${compact ? 'compact' : ''}" role="list" aria-label="Content guide">${defs
      .map(([label, compactLabel, raw]) => {
        const v = Math.max(0, Math.min(5, Number(raw) || 0));
        const summary = `${label}: ${words[v]}, ${v}/5`;
        return `<div class="content-severity-card severity-${v}" role="listitem" aria-label="${esc(summary)}" data-tooltip="${esc(summary)}"><span class="content-card-label">${esc(compact ? compactLabel : label)}</span><span class="content-card-score"><b>${v}</b></span><strong>${esc(words[v])}</strong></div>`;
      })
      .join('')}</div>`;
  }

  function curatedProfileHTML(item) {
    const scores = item.scores || {};
    const tenPointScore = (key, fallbackKey = key) => {
      const value = scores[key] ?? item[fallbackKey];
      return Number.isFinite(Number(value)) ? `${value}/10` : '';
    };
    const metric = ([label, value, isUncurated = false]) => {
      const tone =
        label === 'DARKNESS' || label === 'EXPLICITNESS'
          ? 'intensity'
          : label === 'ENTERTAINMENT' ||
              label === 'PRODUCTION' ||
              label === 'STORY' ||
              label === 'EMOTIONAL PAYOFF'
            ? 'score'
            : 'experience';
      const [whole, fraction] = String(value).split('/');
      return `<div class="profile-metric profile-metric-${tone} ${isUncurated ? 'is-uncurated' : ''}"><span>${esc(label)}</span><b>${esc(whole)}${fraction ? `<small>/${esc(fraction)}</small>` : ''}</b></div>`;
    };
    const viewingFields = [
      ['PACE', item.pace || 'Not yet curated', !item.pace],
      ['COMMITMENT', item.commitment || 'Not yet curated', !item.commitment],
      ['DARKNESS', Number.isFinite(Number(item.darkness)) ? `${item.darkness}/5` : ''],
      ['EXPLICITNESS', Number.isFinite(Number(item.explicitness)) ? `${item.explicitness}/5` : ''],
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    const scoreFields = [
      ['ENTERTAINMENT', tenPointScore('entertainment')],
      ['PRODUCTION', tenPointScore('production')],
      ['STORY', tenPointScore('story')],
      ['EMOTIONAL PAYOFF', tenPointScore('emotional')],
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    const fields = [...viewingFields, ...scoreFields];
    if (!fields.length) return '';
    return `<section class="curated-profile" aria-labelledby="curatedProfileHeading"><div class="curated-profile-head"><span>CURATED PROFILE</span><h4 id="curatedProfileHeading">At a glance</h4></div><div class="curated-profile-grid">${fields.map(metric).join('')}</div></section>`;
  }

  const AWARD_PROGRAM_PROFILES = [
    ['academy:', 'ACA', 'Academy'],
    ['goya:', 'GOY', 'Goya'],
    ['annecy:', 'ANC', 'Annecy'],
    ['bafta:', 'BAF', 'BAFTA'],
    ['ottawa:', 'OTT', 'Ottawa'],
    ['animafest-zagreb:', 'AFZ', 'Animafest Zagreb'],
    ['hiroshima:', 'HIR', 'Hiroshima'],
  ];

  function awardProgramProfile(programKey = '') {
    const key = String(programKey).toLowerCase();
    const known = AWARD_PROGRAM_PROFILES.find(([prefix]) => key.startsWith(prefix));
    if (known) return { code: known[1], label: known[2], className: known[1].toLowerCase() };
    const code = key
      .split(/[:\-]/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 3)
      .toUpperCase();
    return { code: code || 'AWD', label: 'Award program', className: 'custom' };
  }

  function awardSourceHref(value) {
    const raw = String(value || '').trim();
    const markdown = raw.match(/^\[[^\]]+\]\((https?:\/\/[^\s)]+)\)$/i)?.[1];
    try {
      const href = new URL(markdown || raw);
      return ['http:', 'https:'].includes(href.protocol) ? href.href : '';
    } catch {
      return '';
    }
  }

  function awardMarkHTML(profile) {
    return `<span class="award-mark award-mark-${esc(profile.className)}" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M16 10C10 15 9 24 14 32M32 10c6 5 7 14 2 22M18 36h12M24 10v22M19 18h10M19 27h10"/></svg><b>${esc(profile.code)}</b></span>`;
  }

  function awardSummaryBadgeHTML(item) {
    const summary = awardSummary(item);
    if (!summary.total) return '';
    const count = [summary.wins ? `${summary.wins}W` : '', summary.nominees ? `${summary.nominees}N` : '']
      .filter(Boolean)
      .join(' · ');
    const label = awardBadgeLabel(item);
    return `<span class="award-summary-badge ${summary.wins ? 'has-win' : 'nominee-only'}" data-tooltip="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3c0 4-1.8 7-4 7S8 11 8 7V4Zm0 2H4v1c0 2.6 1.5 4.4 4.3 5.2M16 6h4v1c0 2.6-1.5 4.4-4.3 5.2M12 14v4m-4 2h8"/></svg><b>${esc(count)}</b></span>`;
  }

  function awardSectionHTML(item) {
    const awards = sortedAwardEntries(item);
    if (!awards.length) return '';
    const winners = awards.filter((award) => norm(award.result) === 'winner').length;
    const nominees = awards.filter((award) => norm(award.result).includes('nominee')).length;
    const summary = [
      winners ? `${winners} winner${winners === 1 ? '' : 's'}` : '',
      nominees ? `${nominees} nominee${nominees === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' // ');
    return `<section class="award-section" aria-labelledby="awardHeading"><div class="award-section-head"><span>CURATED RECOGNITION</span><h4 id="awardHeading">Awards</h4><b>${formatCount(awards.length)}</b>${summary ? `<small>${esc(summary)}</small>` : ''}</div><div class="award-list" role="list">${awards
      .map((award) => {
        const profile = awardProgramProfile(award.programKey);
        const sourceHref = safeAwardSourceUrl(award) || awardSourceHref(award.sourceUrl);
        const sourceLabel =
          award.sourceTitle && norm(award.sourceTitle) !== norm(item.title) ? ` // ${award.sourceTitle}` : '';
        const resultClass = norm(award.result).replace(/[^a-z0-9]+/g, '-');
        const edition = award.edition ? `<b>${esc(String(award.edition))}</b>` : '';
        const workDetail = award.sourceWorkDetail
          ? `<em class="award-work-detail">${esc(award.sourceWorkDetail)}</em>`
          : '';
        const body = `${awardMarkHTML(profile)}<span class="award-copy"><small>${esc(award.organization || profile.label)}</small><strong>${esc(award.award)}</strong><em>${esc(`${award.category}${sourceLabel}`)}</em>${workDetail}</span><span class="award-result is-${esc(resultClass)}">${esc(award.result)}</span><span class="award-cycle">${edition}<small>${esc(award.cycle)} // ${esc(String(award.eventYear))}</small></span>`;
        const label = `${award.award}: ${award.category}, ${award.result}, ${award.cycle}`;
        return sourceHref
          ? `<a class="award-entry" role="listitem" href="${esc(sourceHref)}" target="_blank" rel="noopener" aria-label="${esc(`Open source for ${label}`)}" data-tooltip="Open award source">${body}<i aria-hidden="true">↗</i></a>`
          : `<article class="award-entry" role="listitem" aria-label="${esc(label)}">${body}</article>`;
      })
      .join('')}</div></section>`;
  }

  // Master-list cards and summary statistics
  function bindCards(root) {
    bindCoverErrors(root);
    $$('[data-fav-id]', root).forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(b.dataset.favId);
      }),
    );
    $$('[data-card-open-id]', root).forEach((button) =>
      button.addEventListener('click', () => openDetail(button.dataset.cardOpenId)),
    );
  }
  function renderMaster({ noMeta = false } = {}) {
    const all = filteredMaster();
    const total = catalogBootstrap ? catalogPageTotals.master : all.length;
    $('#resultCount').textContent = formatCount(total);
    const shown = all.slice(0, state.visible);
    const root = $('#cards');
    root.classList.toggle('compact', state.compact);
    root.innerHTML = shown.length
      ? shown.map((x) => cardHTML(x)).join('')
      : '<div class="empty-state">Nothing matches those filters.</div>';
    $('#loadMoreBtn').parentElement.classList.toggle('hidden', state.visible >= total);
    bindCards(root);
    updateStats();
    if (!noMeta) queueMetadata(shown, { priority: true });
  }
  function renderWestern({ noMeta = false } = {}) {
    const all = filteredWestern();
    renderOriginAtlas();
    const total = catalogBootstrap ? catalogPageTotals.regions || all.length : all.length;
    $('#westernResultCount').textContent = formatCount(total);
    const shown = all.slice(0, state.westernVisible);
    const root = $('#westernCards');
    root.classList.toggle('compact', state.westernCompact);
    root.innerHTML = shown.length
      ? shown.map((x) => cardHTML(x)).join('')
      : '<div class="empty-state">No titles match that origin filter.</div>';
    $('#westernLoadMoreBtn').parentElement.classList.toggle('hidden', state.westernVisible >= total);
    bindCards(root);
    if (!noMeta) queueMetadata(shown, { priority: true });
  }

  function renderOriginAtlas() {
    const atlas = $('#originAtlas');
    if (!atlas) return;
    const selected = $('#westernRegionFilter').value;
    const items = canonicalItems();
    const regionCounts = catalogBootstrap?.facets?.regionCounts || {};
    const regionCountryCounts = catalogBootstrap?.facets?.regionCountryCounts || {};
    atlas.innerHTML = REGIONS.filter((region) => region !== 'Unclassified')
      .filter(
        (region) =>
          Number(regionCounts[region]) > 0 || items.some((item) => titleMatchesRegion(item, region)),
      )
      .map((region, index) => {
        const count =
          Number(regionCounts[region]) || items.filter((item) => titleMatchesRegion(item, region)).length;
        const countryCount = Number(regionCountryCounts[region]) || countriesFor(items, region).length;
        const countryText = interfaceI18n.message(
          countryCount === 1 ? 'regions.country-count.one' : 'regions.country-count.other',
          countryCount === 1 ? '{count} COUNTRY' : '{count} COUNTRIES',
          { count: formatCount(countryCount) },
          { location: 'Regions origin index', context: 'Country count on a region card.', maxLength: 18 },
        );
        return `<button class="origin-atlas-card ${selected === region ? 'active' : ''}" type="button" data-origin-region="${esc(region)}" aria-label="Browse ${esc(region)}: ${formatCount(count)} titles across ${countryText.toLowerCase()}"><span class="origin-atlas-order">${String(index + 1).padStart(2, '0')}</span><span class="origin-atlas-name">${esc(region)}</span><span class="origin-atlas-detail">${esc(countryText)}</span><span class="origin-atlas-total"><b>${formatCount(count)}</b><small>TITLES</small></span></button>`;
      })
      .join('');
    $$('[data-origin-region]', atlas).forEach((button) =>
      button.addEventListener('click', () => {
        const region = button.dataset.originRegion;
        const select = $('#westernRegionFilter');
        select.value = selected === region ? '' : region;
        // Region cards intentionally use the exact same path as a native
        // selection. This keeps URL state, country options and the latest
        // server-side query in one reliable navigation flow.
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }),
    );
  }
  function renderKids({ noMeta = false } = {}) {
    const all = filteredKids();
    const total = catalogBootstrap ? catalogPageTotals.kids || all.length : all.length;
    const shown = all.slice(0, state.kidsVisible);
    const root = $('#kidsCards');
    root.classList.toggle('compact', state.kidsCompact);
    $('#kidsResultCount').textContent = formatCount(total);
    root.innerHTML = shown.length
      ? shown.map((x) => cardHTML(x)).join('')
      : `<div class="empty-state">${$('#kidsSearch').value.trim() ? 'No For Kids titles match that search.' : 'No titles are currently marked for For Kids.'}</div>`;
    $('#kidsLoadMoreBtn').parentElement.classList.toggle('hidden', state.kidsVisible >= total);
    bindCards(root);
    if (!noMeta) queueMetadata(shown, { priority: true });
  }
  function updateStats() {
    const items = canonicalItems(),
      completed = items.filter((x) => pFor(x.id).status === 'Completed').length,
      watching = items.filter((x) => pFor(x.id).status === 'Watching').length,
      films = items.filter((x) => /film/i.test(x.type || '')).length,
      favCount = items.filter((x) => isFavorite(x.id)).length;
    const browserCovers = items.filter((x) => {
      const m = meta[x.id]?.data || {};
      return !!(m.cover || m.image);
    }).length;
    const covers = Math.max(browserCovers, Number(state.serverCovers) || 0),
      coverTotal = Math.max(items.length, Number(state.serverCoverTotal) || 0);
    // Covers are saved when a title is rendered or opened. Do not present that
    // background work as a global progress task: a large catalog would make a
    // slowly moving counter look like a broken loader.
    const artworkLabel = `<span class="artwork-cache-label">${covers === coverTotal ? 'ARTWORK CACHED' : 'ARTWORK SAVED LOCALLY AS YOU BROWSE'}</span>`;
    $('#statStrip').innerHTML =
      `<div class="stat"><b>${formatCount(catalogBootstrap?.total || items.length)}</b><span>TITLES</span></div><div class="stat"><b>${formatCount(catalogBootstrap?.filmCount ?? films)}</b><span>FILMS / FILM SERIES</span></div><div class="stat"><b>${formatCount(catalogBootstrap?.collectionCount ?? CAT.collections.length)}</b><span>COLLECTIONS</span></div><div class="stat"><b>${formatCount(catalogBootstrap?.franchiseCount ?? CAT.franchises.length)}</b><span>FRANCHISE GUIDES</span></div><div class="stat"><b>${formatCount(covers)}</b>${artworkLabel}</div><div class="stat"><b>${formatCount(favCount)}</b><span>FAVORITES</span></div><div class="stat"><b>${formatCount(completed)}${watching ? `<strong class="stat-operator">+</strong>${formatCount(watching)}` : ''}</b><span>${watching ? 'COMPLETED + WATCHING' : 'COMPLETED'}</span></div>`;
    renderUserSummary();
  }

  // Favorites and adult-content views
  function renderFavorites() {
    const input = $('#favoriteSearch');
    if (!input) return;
    const favorites = canonicalItems().filter((item) => isFavorite(item.id));
    populateAwardFilter($('#favoriteAwardFilter'), favorites);
    populateGeographyFilters('favorite', favorites);
    const q = norm(input.value);
    const award = $('#favoriteAwardFilter').value;
    const arr = filterByGeography(
      favorites.filter((x) => {
        return titleMatchesSearch(x, q) && matchesAwardFilter(x, award);
      }),
      'favorite',
    );
    const sort = titleSortModes.includes($('#favoriteSort').value) ? $('#favoriteSort').value : 'rank';
    const ordered = sortTitleItems(arr, sort, state.favoriteSortOrder);
    $('#favoriteCount').textContent =
      `${formatCount(ordered.length)} FAVORITE${ordered.length === 1 ? '' : 'S'}`;
    const root = $('#favoriteCards');
    root.innerHTML = ordered.length
      ? ordered.map((x) => cardHTML(x)).join('')
      : q
        ? '<div class="empty-state">No favorites match that search.</div>'
        : '<div class="empty-state">No favorites yet. Use the heart on any title to add it here.</div>';
    bindCards(root);
    queueMetadata(ordered, { priority: true });
  }

  function matchesAdult(x, mode = 'all') {
    const c = x.content || {},
      tags = (c.tags || []).map((t) => t.toLowerCase()),
      g = liveGenres(x).join(' ').toLowerCase(),
      typ = (x.type || '').toLowerCase();
    if (mode === 'hentai') return tags.includes('hentai') || typ.includes('hentai');
    if (mode === 'ecchi') return tags.includes('ecchi') || g.includes('ecchi');
    if (mode === 'erotic') return tags.includes('erotic') || g.includes('erotic') || g.includes('sex comedy');
    if (mode === 'gore') return (c.gore || 0) >= 4 || tags.includes('gore');
    if (mode === 'violence') return (c.violence || 0) >= 5 || tags.includes('extreme violence');
    if (mode === 'disturbing') return (c.disturbing || 0) >= 5 || tags.includes('disturbing');
    return (
      tags.length > 0 ||
      Math.max(c.sex || 0, c.nudity || 0, c.violence || 0, c.gore || 0, c.disturbing || 0) >= 4
    );
  }

  function isAdultCatalogTitle(content = {}) {
    return normalizedContent(content).tags.some(
      (tag) => tag.toLowerCase() === ADULT_CATALOG_TAG.toLowerCase(),
    );
  }

  function setAdultCatalogTitle(content = {}, included = false) {
    const normalized = normalizedContent(content);
    normalized.tags = normalized.tags.filter((tag) => tag.toLowerCase() !== ADULT_CATALOG_TAG.toLowerCase());
    if (included) normalized.tags.push(ADULT_CATALOG_TAG);
    return normalized;
  }
  function adultFilterItems(mode = state.adult) {
    return canonicalItems()
      .filter((x) => matchesAdult(x, mode))
      .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999));
  }
  function filteredAdult() {
    const q = norm($('#adultSearch').value),
      tier = $('#adultTierFilter').value,
      award = $('#adultAwardFilter').value,
      type = $('#adultTypeFilter').value,
      genre = $('#adultGenreFilter').value,
      status = $('#adultStatusFilter').value;
    const filtered = filterByGeography(adultFilterItems(), 'adult').filter((x) => titleMatchesSearch(x, q));
    const narrowed = filtered.filter((x) => {
      if (tier && normalizeCuratedTier(x.tier) !== tier) return false;
      if (!matchesAwardFilter(x, award)) return false;
      if (type && displayType(x) !== type) return false;
      if (genre && !liveGenres(x).includes(genre)) return false;
      if (status && pFor(x.id).status !== status) return false;
      return true;
    });
    const sort = titleSortModes.includes($('#adultSort').value) ? $('#adultSort').value : 'rank';
    return sortTitleItems(narrowed, sort, state.adultSortOrder);
  }
  function updateAdultChipCounts() {
    const labels = {
      all: 'ALL MATURE CONTENT',
      ecchi: 'ECCHI',
      erotic: 'EROTIC',
      hentai: 'HENTAI',
      gore: 'GORE',
      violence: 'EXTREME VIOLENCE',
      disturbing: 'DISTURBING',
    };
    $$('.adult-chip').forEach((b) => {
      const mode = b.dataset.adult;
      b.textContent = `${labels[mode]} · ${formatCount(adultFilterItems(mode).length)}`;
    });
  }
  function renderAdult() {
    updateAdultChipCounts();
    const arr = filteredAdult();
    const root = $('#adultCards');
    root.innerHTML = arr.length
      ? arr.map((x) => cardHTML(x, { adult: true })).join('')
      : `<div class="empty-state">${$('#adultSearch').value.trim() ? 'No Mature Content titles match that search.' : 'No current master titles carry this tag.'}</div>`;
    bindCards(root);
    queueMetadata(arr, { priority: true });
  }

  // Curated collections and franchise watch orders
  function renderCollections() {
    const q = $('#collectionSearch').value.trim().toLowerCase();
    const all = CAT.collections.filter((c) => {
      const titles = c.items.map((id) => itemById(id)?.title || '').join(' ');
      return !q || `${c.name} ${c.kind} ${c.description} ${titles}`.toLowerCase().includes(q);
    });
    $('#collectionCount').textContent = `${formatCount(all.length)} COLLECTIONS`;
    $('#collectionGrid').innerHTML = all.length
      ? all
          .map(
            (c) =>
              `<button class="collection-card" data-cid="${esc(c.id)}" type="button"><span class="collection-kind">${esc(c.kind.toUpperCase())}</span><h3>${esc(c.name)}</h3><p>${esc(c.description)}</p><span class="collection-mode">${esc(c.mode.toUpperCase())}</span><span class="collection-count">${formatCount(c.items.length)}</span></button>`,
          )
          .join('')
      : '<div class="empty-state">No collections match that search.</div>';
    $$('.collection-card', $('#collectionGrid')).forEach((el) => {
      el.addEventListener('click', () => openCollection(el.dataset.cid));
    });
  }
  function openCollection(id) {
    const c = CAT.collections.find((x) => x.id === id);
    if (!c) return;
    const missingItems = catalogBootstrap && c.items.some((itemId) => !masterById.has(itemId));
    if (missingItems) {
      const dialog = $('#collectionDialog');
      dialog.dataset.collectionId = id;
      $('#collectionBody').innerHTML =
        `<div class="collection-detail collection-loading"><div class="meta">${esc(c.kind.toUpperCase())} // ${esc(c.mode.toUpperCase())}</div><h2>${esc(c.name)}</h2><p class="metadata-wait">Loading this collection…</p></div>`;
      if (!dialog.open) dialog.showModal();
      void loadCollectionItems(c).then((loaded) => {
        if (loaded && dialog.open && dialog.dataset.collectionId === id) openCollection(id);
      });
      return;
    }
    const arr = c.items.map(itemById).filter(Boolean);
    const ordered = sortTitleItems(arr, state.collectionSort, state.collectionSortOrder);
    const descending = state.collectionSortOrder === 'desc';
    const orderIcon = sortOrderIconHTML(descending);
    $('#collectionBody').innerHTML =
      `<div class="collection-detail"><div class="meta">${esc(c.kind.toUpperCase())} // ${esc(c.mode.toUpperCase())} // ${formatCount(ordered.length)} TITLES</div><h2>${esc(c.name)}</h2><p>${esc(c.description)}</p><div class="collection-title-tools"><label><span>SORT BY</span><select id="collectionTitleSort" aria-label="Sort collection titles by"><option value="rank" ${state.collectionSort === 'rank' ? 'selected' : ''}>MASTER RANK</option><option value="overall" ${state.collectionSort === 'overall' ? 'selected' : ''}>OVERALL SCORE</option><option value="production" ${state.collectionSort === 'production' ? 'selected' : ''}>PRODUCTION</option><option value="story" ${state.collectionSort === 'story' ? 'selected' : ''}>STORY</option><option value="emotional" ${state.collectionSort === 'emotional' ? 'selected' : ''}>EMOTIONAL PAYOFF</option><option value="year" ${state.collectionSort === 'year' ? 'selected' : ''}>RELEASE DATE</option><option value="title" ${state.collectionSort === 'title' ? 'selected' : ''}>NAME</option><option value="myrating" ${state.collectionSort === 'myrating' ? 'selected' : ''}>MY RATING</option></select></label><div class="collection-sort-order"><span>ORDER</span><button id="collectionSortOrder" type="button" aria-label="Change to ${descending ? 'ascending' : 'descending'} order" data-tooltip="Change to ${descending ? 'ascending' : 'descending'} order">${orderIcon}<b>${descending ? 'DESC' : 'ASC'}</b></button></div></div><div class="collection-title-list">${ordered.map((x) => `<button class="collection-title" data-id="${esc(x.id)}" type="button"><b>${x.rank ? `#${formatRank(x.rank)}` : 'ADD'}</b><span>${esc(x.title)}${x.year ? ` <small>(${x.year})</small>` : ''}</span><em>${esc(qualityRatingLabel(x.tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }))}</em></button>`).join('')}</div></div>`;
    const dialog = $('#collectionDialog');
    dialog.dataset.collectionId = id;
    if (!dialog.open) dialog.showModal();
    syncNavigationUrl();
    $('#collectionTitleSort').addEventListener('change', (event) => {
      state.collectionSort = event.target.value;
      saveUIState();
      openCollection(id);
    });
    $('#collectionSortOrder').addEventListener('click', () => {
      state.collectionSortOrder = state.collectionSortOrder === 'desc' ? 'asc' : 'desc';
      saveUIState();
      openCollection(id);
    });
    $$('.collection-title', $('#collectionBody')).forEach((b) =>
      b.addEventListener('click', () => {
        openDetail(b.dataset.id);
      }),
    );
  }

  function sortOrderIconHTML(descending) {
    return descending
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h9M3 9h7M3 13h5M15 4v12m-3-3 3 3 3-3"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15h9M3 11h7M3 7h5M15 16V4m-3 3 3-3 3 3"/></svg>';
  }

  function renderSortOrderButton(button, order) {
    if (!button) return;
    const descending = order === 'desc';
    button.innerHTML = `${sortOrderIconHTML(descending)}<b>${descending ? 'DESC' : 'ASC'}</b>`;
    button.setAttribute('aria-label', `Change to ${descending ? 'ascending' : 'descending'} order`);
    button.dataset.tooltip = `Change to ${descending ? 'ascending' : 'descending'} order`;
    button.removeAttribute('title');
  }

  // One sparse episode state is shared by title details and franchise guides.
  const EPISODE_STATES = ['unwatched', 'watching', 'watched'];

  function isFeatureFilm(x) {
    const type = String(x?.type || '').toLowerCase();
    return /\b(film|movie)\b/.test(type) && !/\bseries\b/.test(type);
  }

  function canTrackEpisodes(x) {
    if (isFeatureFilm(x)) return false;
    if (!x || !['anilist', 'tvmaze'].includes(x.api)) return false;
    return /series|tv|ova|ona|special/i.test(`${x.type || ''} ${meta[x.id]?.data?.format || ''}`);
  }

  function hasWatchTracker(x) {
    return isFeatureFilm(x) || canTrackEpisodes(x);
  }

  function episodeKey(entry) {
    return `${entry.provider || 'anilist'}:${entry.id}`;
  }

  function episodeState(entry, number) {
    const value = episodeProgress[episodeKey(entry)]?.[number];
    return EPISODE_STATES.includes(value) ? value : 'unwatched';
  }

  function setEpisodeState(entry, number, status) {
    const key = episodeKey(entry);
    if (!episodeProgress[key] || typeof episodeProgress[key] !== 'object') episodeProgress[key] = {};
    if (status === 'unwatched') delete episodeProgress[key][number];
    else episodeProgress[key][number] = status;
    if (!Object.keys(episodeProgress[key]).length) delete episodeProgress[key];
  }

  function entryEpisodeStats(entry) {
    const total = Math.max(0, Number(entry.episodes) || 0);
    let watching = 0,
      watched = 0;
    for (let number = 1; number <= total; number++) {
      const status = episodeState(entry, number);
      if (status === 'watching') watching++;
      if (status === 'watched') watched++;
    }
    return { total, watching, watched, touched: watching + watched };
  }

  function groupEpisodeStats(group) {
    return (group?.entries || []).reduce(
      (sum, entry) => {
        const current = entryEpisodeStats(entry);
        sum.total += current.total;
        sum.watching += current.watching;
        sum.watched += current.watched;
        return sum;
      },
      { total: 0, watching: 0, watched: 0 },
    );
  }

  function derivedEpisodeStatus(group) {
    const stats = groupEpisodeStats(group);
    if (stats.total && stats.watched === stats.total) return 'Completed';
    if (stats.watching) return 'Watching';
    if (stats.watched) return 'On hold';
    return 'Not started';
  }

  function seriesGroupNeedsRefresh(group) {
    if (typeof group?.refreshOnOpen === 'boolean') return group.refreshOnOpen;
    return (group?.entries || []).some((entry) =>
      ['RELEASING', 'NOT_YET_RELEASED', 'HIATUS'].includes(entry.status),
    );
  }

  function cachedSeriesGroup(x) {
    const record = seriesGroups[x.id];
    return record?.data || null;
  }

  function seriesGroupCacheFresh(x) {
    const record = seriesGroups[x.id];
    if (!record?.data) return false;
    return !seriesGroupNeedsRefresh(record.data) || Date.now() - Number(record.ts || 0) < SERIES_REFRESH_TTL;
  }

  function featureFilmGroup(x) {
    const m = meta[x.id]?.data || {};
    return {
      source: 'catalog',
      rootId: x.id,
      title: x.title,
      refreshOnOpen: false,
      entries: [
        {
          id: `film:${x.id}`,
          provider: 'catalog',
          title: x.title,
          year: x.year || m.year || 0,
          format: 'FEATURE FILM',
          status: 'FINISHED',
          episodes: 1,
          cover: m.cover || m.image || '',
          episodeTitles: ['Feature film'],
        },
      ],
    };
  }

  async function seriesMatchCandidates(x) {
    const response = await fetch(
      `/api/series/candidates?kind=${encodeURIComponent(x.api)}&title=${encodeURIComponent(x.lookupTitle || x.title)}`,
      { cache: 'no-store' },
    );
    const result = await response.json();
    if (!response.ok || !result.ok || !Array.isArray(result.data?.candidates))
      throw new Error(result.error || 'Series matches could not be loaded.');
    return result.data;
  }

  function seriesMatchChoiceError(candidates) {
    const error = new Error('Choose the matching series before loading episodes.');
    error.code = 'series-match-choice';
    error.candidates = candidates;
    return error;
  }

  async function loadSeriesGroup(x, { force = false, chooseMatch = false } = {}) {
    if (isFeatureFilm(x)) return featureFilmGroup(x);
    if (!canTrackEpisodes(x)) return null;
    const record = seriesGroups[x.id] || {};
    const cached = record.data || null;
    if (!force && cached && seriesGroupCacheFresh(x)) return cached;
    if (!state.server) {
      if (cached) return cached;
      throw new Error('Series metadata service is offline.');
    }
    if (seriesLoading.has(x.id)) return seriesLoading.get(x.id);
    const task = (async () => {
      const catalogMatch =
        ['anilist', 'tvmaze'].includes(x.api) && /^\d+$/.test(String(x.externalId || ''))
          ? { provider: x.api, id: String(x.externalId) }
          : null;
      // A user-selected match is authoritative. A curated provider ID is the
      // next-best identity signal and avoids a title-search collision. Users
      // can still explicitly choose a different match when needed.
      const selection = chooseMatch ? null : record.match || catalogMatch;
      if (!selection || chooseMatch) {
        const matches = await seriesMatchCandidates(x);
        if (matches.candidates.length && (chooseMatch || matches.requiresChoice))
          throw seriesMatchChoiceError(matches.candidates);
      }
      const params = new URLSearchParams({ kind: x.api, title: x.lookupTitle || x.title });
      if (selection?.provider && selection?.id) {
        params.set('provider', selection.provider);
        params.set('id', selection.id);
      }
      const response = await fetch(`/api/series?${params}`, { cache: force ? 'reload' : 'default' });
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.data?.entries))
        throw new Error(result.error || 'Series metadata was not found.');
      const matches = [
        { canonicalTitle: result.data.title, altTitle: '' },
        ...result.data.entries.map((entry) => ({
          canonicalTitle: entry.title,
          altTitle: entry.altTitle,
        })),
      ].some((candidate) => metadataMatchesTitle(x.lookupTitle || x.title, candidate, x.year));
      if (!selection && !matches) {
        const alternatives = await seriesMatchCandidates(x);
        if (alternatives.candidates.length) throw seriesMatchChoiceError(alternatives.candidates);
        throw new Error('The provider returned a different series.');
      }
      seriesGroups[x.id] = { ts: Date.now(), data: result.data, ...(selection ? { match: selection } : {}) };
      save(STORE.series, seriesGroups);
      return result.data;
    })().finally(() => seriesLoading.delete(x.id));
    seriesLoading.set(x.id, task);
    return task;
  }

  function trackerSeasonLabels(entries) {
    return providerSeriesLabels(
      entries.map((entry) => ({
        ...entry,
        format: entry.format === 'FEATURE FILM' ? 'MOVIE' : entry.format,
      })),
    );
  }

  function episodeProgressMeterHTML(ratio, className) {
    const percentage = Math.max(0, Math.min(100, Number(ratio || 0) * 100));
    return `<span class="${className}" aria-hidden="true"><svg class="episode-progress-svg" viewBox="0 0 100 4" preserveAspectRatio="none"><rect class="episode-progress-track" width="100" height="4"></rect><rect class="episode-progress-fill" width="${percentage}" height="4"></rect></svg></span>`;
  }

  function episodeButtonsHTML(entry, episodeNumbers) {
    return episodeNumbers
      .map((number) => {
        const status = episodeState(entry, number);
        const isFilm = entry.format === 'FEATURE FILM';
        const episodeCode = isFilm ? 'FEATURE FILM' : `E${String(number).padStart(2, '0')}`;
        const episodeName = String(entry.episodeTitles?.[number - 1] || '').trim();
        const episodeText = episodeName ? `${episodeCode}: ${episodeName}` : episodeCode;
        return `<button class="episode-button ${status} ${isFilm ? 'feature-film-button' : ''}" type="button" data-episode-action="cycle" data-entry-id="${esc(entry.id)}" data-episode="${number}" aria-label="${esc(`${entry.title}, ${episodeText}: ${status}`)}" data-tooltip="${esc(`${episodeText}: ${status}`)}"><span class="episode-number">${episodeCode}</span>${episodeName ? `<span class="episode-name">${esc(episodeName)}</span>` : '<span class="episode-name episode-name-pending">Episode title unavailable</span>'}<i></i></button>`;
      })
      .join('');
  }

  function trackerStepMatchesEntry(step, entry) {
    const stepTitle = norm(step?.title);
    const entryTitle = norm(entry?.title);
    return Boolean(stepTitle && entryTitle && (stepTitle === entryTitle || entryTitle.includes(stepTitle)));
  }

  function trackerStepEpisodes(step, entry) {
    const explicit = step?.episodes ?? step?.episodeRange;
    if (Array.isArray(explicit)) return explicit.map(Number).filter((number) => number > 0);
    const text = String(explicit || step?.note || step?.title || '');
    const match = text.match(/episodes?\s+(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/i);
    if (!match) return Array.from({ length: Number(entry.episodes) || 0 }, (_, index) => index + 1);
    const start = Number(match[1]);
    const end = Number(match[2] || start);
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index).filter(
      (number) => number <= Number(entry.episodes || 0),
    );
  }

  function placementAnchorMatches(entry, label, placement) {
    const raw = String(placement?.after || placement?.n || '');
    if (!/^(after|before)\b/i.test(raw)) return false;
    const compact = (value) =>
      norm(value)
        .replace(/\bseason\b/g, 's')
        .replace(/0+(?=\d)/g, '')
        .replace(/\s+/g, '');
    const anchor = compact(raw.replace(/^(after|before)\s+/i, ''));
    const labelValue = compact(label);
    const entryValue = compact(entry.title);
    if (!anchor) return false;
    if (labelValue === anchor || entryValue.includes(anchor)) return true;
    if (/part1$/.test(anchor)) {
      const seasonStart = anchor.replace(/part1$/, '');
      return labelValue === seasonStart || entryValue.endsWith(seasonStart);
    }
    return false;
  }

  function trackerRows(owner, group, labels) {
    const franchise = franchisesForItem(owner)[0]?.franchise;
    if (!franchise)
      return group.entries.map((entry, index) => ({ kind: 'entry', entry, label: labels[index] }));
    const placements = (franchise.orders || []).flatMap((order, orderIndex) => {
      const isPlacementOrder =
        orderIndex > 0 &&
        (/placement|extra/i.test(order.label || '') ||
          (order.steps || []).some((step) => /^(after|before)\b/i.test(String(step.n || step.after || ''))));
      if (!isPlacementOrder) return [];
      return (order.steps || []).map((step, stepIndex) => ({
        step,
        entry: group.entries.find((entry) => trackerStepMatchesEntry(step, entry)) || null,
        franchise,
        orderIndex,
        stepIndex,
      }));
    });
    if (!placements.length)
      return group.entries.map((entry, index) => ({ kind: 'entry', entry, label: labels[index] }));

    const linkedEntryIds = new Set(placements.filter((row) => row.entry).map((row) => row.entry.id));
    const emittedPlacements = new Set();
    const rows = [];
    group.entries.forEach((entry, index) => {
      if (!linkedEntryIds.has(entry.id)) rows.push({ kind: 'entry', entry, label: labels[index] });
      placements.forEach((placement, placementIndex) => {
        if (placementAnchorMatches(entry, labels[index], placement.step)) {
          rows.push({ kind: 'placement', ...placement, label: labels[index] });
          emittedPlacements.add(placementIndex);
        }
      });
    });
    placements.forEach((placement, index) => {
      if (emittedPlacements.has(index)) return;
      if (placement.entry) {
        const entryIndex = group.entries.indexOf(placement.entry);
        rows.push({ kind: 'entry', entry: placement.entry, label: labels[entryIndex] });
      } else {
        rows.push({ kind: 'placement', ...placement, label: '' });
      }
    });
    return rows;
  }

  function trackerRowStats(entry, episodeNumbers) {
    const states = episodeNumbers.map((number) => episodeState(entry, number));
    return {
      total: episodeNumbers.length,
      watched: states.filter((state) => state === 'watched').length,
      touched: states.some((state) => state !== 'unwatched'),
    };
  }

  function trackerSeasonRowHTML(row, index, firstIncomplete) {
    const { entry } = row;
    if (!entry) {
      const step = row.step;
      const liveAction = isLiveActionFranchiseStep(step);
      const key = liveAction
        ? franchiseStepProgressKey(row.franchise, row.orderIndex, row.stepIndex, 'full', row.step)
        : '';
      const watched = key && franchiseProgress[key] === true;
      return `<article class="franchise-watch-task ${liveAction ? 'is-live-action' : ''} ${watched ? 'is-watched' : ''}"><span>${esc(step.n || 'NEXT')}</span><div><b>${esc(step.title)}</b>${step.timeRange ? `<small>WATCH ${esc(step.timeRange)}</small>` : ''}${step.note ? `<small>${esc(step.note)}</small>` : ''}</div>${liveAction ? `<button class="franchise-step-toggle ${watched ? 'is-watched' : ''}" type="button" data-franchise-step-key="${esc(key)}" aria-pressed="${watched}"><i aria-hidden="true"></i><span>${watched ? 'WATCHED' : 'MARK AS WATCHED'}</span></button>` : `<em>${esc(step.flag || 'OPTIONAL')}</em>`}</article>`;
    }
    const episodeNumbers =
      row.kind === 'placement'
        ? trackerStepEpisodes(row.step, entry)
        : Array.from({ length: Number(entry.episodes) || 0 }, (_, episodeIndex) => episodeIndex + 1);
    const stats = trackerRowStats(entry, episodeNumbers);
    const state =
      stats.total && stats.watched === stats.total ? 'watched' : stats.touched ? 'watching' : 'unwatched';
    const ratio = stats.total ? stats.watched / stats.total : 0;
    const isFilm = entry.format === 'FEATURE FILM';
    const episodeLabel = isFilm
      ? 'Feature film'
      : stats.total
        ? `${formatCount(stats.total)} episode${stats.total === 1 ? '' : 's'}`
        : 'Episode count pending';
    const placement = row.kind === 'placement';
    const placementMeta = placement
      ? `<em class="franchise-placement-marker">${esc(row.step.n || 'WATCH HERE')} // ${esc(row.step.flag || 'OPTIONAL')}</em>`
      : '';
    const note =
      placement && (row.step.note || row.step.resumeNote)
        ? `<small>${esc(row.step.note || row.step.resumeNote)}</small>`
        : '';
    const episodes = isFilm
      ? ''
      : stats.total
        ? episodeButtonsHTML(entry, episodeNumbers)
        : '<div class="episode-empty">Episode count is not available from the provider.</div>';
    return `<details class="season-row ${state} ${isFilm ? 'feature-film-row' : ''} ${placement ? 'franchise-placement' : ''}" ${index === firstIncomplete ? 'open' : ''}><summary><span class="season-code">${esc(placement ? entry.format || 'OVA' : row.label)}</span>${!isFilm && entry.cover ? `<img src="${esc(entry.cover)}" alt="" loading="lazy">` : ''}<span class="season-copy">${placementMeta}<b>${esc(entry.title)}</b><small>${esc([entry.year || '', entry.format || '', episodeLabel].filter(Boolean).join(' // '))}</small>${note}${episodeProgressMeterHTML(ratio, 'season-meter')}</span><span class="season-count"><b>${formatCount(stats.watched)}/${formatCount(stats.total)}</b><small>${state}</small></span><span class="season-chevron">+</span></summary><div class="season-episodes ${isFilm ? 'feature-film-actions' : ''} ${placement ? 'placement-episodes' : ''}">${placement ? '' : `<div class="season-actions"><button type="button" data-episode-action="${isFilm ? 'watching' : 'continue'}" data-entry-id="${esc(entry.id)}">${isFilm ? 'MARK WATCHING' : 'NEXT EPISODE'}</button><button type="button" data-episode-action="all-watched" data-entry-id="${esc(entry.id)}">${isFilm ? 'MARK WATCHED' : 'MARK SEASON WATCHED'}</button><button type="button" data-episode-action="reset" data-entry-id="${esc(entry.id)}">RESET</button></div>`}${episodes ? `<div class="episode-grid">${episodes}</div>` : ''}</div></details>`;
  }

  function episodeTrackerHTML(owner, group, variant = 'detail') {
    const groupStats = groupEpisodeStats(group);
    const isFilm = group.entries.length === 1 && group.entries[0]?.format === 'FEATURE FILM';
    const completed = Boolean(groupStats.total && groupStats.watched === groupStats.total);
    const labels = trackerSeasonLabels(group.entries);
    const rows = trackerRows(owner, group, labels);
    const firstIncomplete = Math.max(
      0,
      rows.findIndex((row) => {
        if (!row.entry) return false;
        const episodeNumbers =
          row.kind === 'placement'
            ? trackerStepEpisodes(row.step, row.entry)
            : Array.from({ length: Number(row.entry.episodes) || 0 }, (_, index) => index + 1);
        const stats = trackerRowStats(row.entry, episodeNumbers);
        return stats.total && stats.watched < stats.total;
      }),
    );
    const percentage = groupStats.total ? Math.round((groupStats.watched / groupStats.total) * 100) : 0;
    const liveStatus = seriesGroupNeedsRefresh(group)
      ? '<span class="series-live-status"><i></i>RELEASING // CHECKED ON OPEN</span>'
      : '';
    const completionLabel = isFilm
      ? 'FILM COMPLETED'
      : variant === 'franchise'
        ? 'FRANCHISE COMPLETED'
        : 'SERIES COMPLETED';
    const trackerLabel = isFilm
      ? 'FEATURE FILM STATUS'
      : variant === 'franchise'
        ? 'FRANCHISE PROGRESS'
        : 'UNIFIED SERIES PROGRESS';
    const totalLabel = isFilm ? 'FILM WATCHED' : 'EPISODES WATCHED';
    const canChangeMatch = !isFilm && state.server && ['anilist', 'tvmaze'].includes(owner.api);
    return `<section class="episode-tracker ${isFilm ? 'feature-film-tracker' : ''} ${variant === 'franchise' ? 'franchise-tracker' : ''} ${completed ? 'is-complete' : ''}"><header class="episode-tracker-head"><div><span>${trackerLabel}</span><h4>${esc(owner.title)}</h4>${liveStatus}</div><div class="episode-total"><b>${formatCount(groupStats.watched)}<i>/</i>${formatCount(groupStats.total)}</b><span>${totalLabel}</span></div></header><div class="episode-overview ${completed ? 'is-complete' : ''}">${completed ? `<span class="episode-complete-label"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.2 3.2 7.8-8"></path></svg>${completionLabel}</span>` : ''}${episodeProgressMeterHTML(percentage / 100, 'episode-overview-meter')}<b>${percentage}%</b></div><div class="episode-key" aria-label="Episode status legend"><span class="unwatched">UNWATCHED</span><span class="watching">WATCHING</span><span class="watched">WATCHED</span></div>${canChangeMatch ? '<div class="episode-match-tools"><button type="button" data-series-match-change>CHOOSE A DIFFERENT SERIES MATCH</button></div>' : ''}<div class="season-stack">${rows.map((row, index) => trackerSeasonRowHTML(row, index, firstIncomplete)).join('')}</div></section>`;
  }

  function syncTitleStatusFromEpisodes(owner, group) {
    const current = pFor(owner.id);
    progress[owner.id] = { ...current, status: derivedEpisodeStatus(group) };
    save(STORE.progress, progress);
    const modal = $('#modalStatus');
    if (modal && $('#dialogBody').dataset.itemId === owner.id) modal.value = progress[owner.id].status;
  }

  function applyManualTitleStatusToEpisodes(group, status) {
    if (!group) return;
    if (status === 'Completed') {
      for (const entry of group.entries) {
        for (let number = 1; number <= Number(entry.episodes || 0); number++)
          setEpisodeState(entry, number, 'watched');
      }
    } else if (status === 'Not started') {
      for (const entry of group.entries) delete episodeProgress[episodeKey(entry)];
    } else if (status === 'Watching' && !groupEpisodeStats(group).watching) {
      const entry = group.entries.find((row) => Number(row.episodes) > 0);
      if (entry) setEpisodeState(entry, 1, 'watching');
    }
    save(STORE.episodes, episodeProgress);
  }

  const EPISODE_CONFIRM_ACTIONS = {
    'all-watched': {
      originalText: 'MARK SEASON WATCHED',
      originalLabel: 'Mark every episode in this season as watched',
      preparingLabel: 'Preparing mark season watched confirmation',
      confirmText: 'CONFIRM WATCHED',
      confirmLabel: 'Confirm marking every episode in this season as watched',
      confirmClass: 'episode-watched-confirm',
    },
    reset: {
      originalText: 'RESET',
      originalLabel: 'Reset watched episodes for this season',
      preparingLabel: 'Preparing reset confirmation',
      confirmText: 'CONFIRM RESET',
      confirmLabel: 'Confirm reset of watched episodes for this season',
      confirmClass: 'episode-reset-confirm',
    },
  };

  function cancelEpisodeActionConfirmation({ restoreButton = true } = {}) {
    if (!pendingEpisodeAction) return;
    clearTimeout(pendingEpisodeAction.timer);
    const { button, config } = pendingEpisodeAction;
    pendingEpisodeAction = null;
    if (!restoreButton || !button.isConnected) return;
    button.disabled = false;
    button.classList.remove('episode-action-arming', 'episode-reset-confirm', 'episode-watched-confirm');
    button.removeAttribute('aria-busy');
    button.setAttribute('aria-label', config.originalLabel);
    button.textContent = config.originalText;
  }

  function armEpisodeActionConfirmation(button, entry, action) {
    const config = EPISODE_CONFIRM_ACTIONS[action];
    if (!config) return false;
    cancelEpisodeActionConfirmation();
    const pending = {
      button,
      action,
      config,
      entryKey: episodeKey(entry),
      ready: false,
      timer: null,
    };
    pendingEpisodeAction = pending;
    button.disabled = true;
    button.classList.add('episode-action-arming');
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-label', config.preparingLabel);
    button.innerHTML =
      '<span class="episode-action-loading" aria-hidden="true"><i></i><i></i><i></i></span><b>WAIT</b>';
    pending.timer = setTimeout(() => {
      if (pendingEpisodeAction !== pending || !button.isConnected) {
        if (pendingEpisodeAction === pending) pendingEpisodeAction = null;
        return;
      }
      pending.ready = true;
      button.disabled = false;
      button.classList.remove('episode-action-arming');
      button.classList.add(config.confirmClass);
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-label', config.confirmLabel);
      button.textContent = config.confirmText;
    }, 2000);
    return true;
  }

  function mountEpisodeTracker(mount, owner, group, variant = 'detail') {
    mount.dataset.episodeOwner = owner.id;
    mount.dataset.episodeVariant = variant;
    mount.innerHTML = episodeTrackerHTML(owner, group, variant);
    $$('[data-open-franchise-id]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        if (mount.closest('#detailDialog')) $('#detailDialog').close();
        openFranchiseGuide(button.dataset.openFranchiseId);
      }),
    );
    $$('[data-franchise-step-key]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const key = button.dataset.franchiseStepKey;
        if (franchiseProgress[key]) delete franchiseProgress[key];
        else franchiseProgress[key] = true;
        save(STORE.franchiseProgress, franchiseProgress);
        mountEpisodeTracker(mount, owner, group, variant);
      }),
    );
    if (variant === 'franchise') syncFranchiseCompletionState(mount, group);
    $('[data-series-match-change]', mount)?.addEventListener('click', () => {
      delete seriesGroups[owner.id];
      save(STORE.series, seriesGroups);
      populateEpisodeMount(mount, owner, variant, { chooseMatch: true });
    });
    $$('[data-episode-action]', mount).forEach((button) =>
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const entry = group.entries.find((row) => row.id === button.dataset.entryId);
        if (!entry) return;
        const action = button.dataset.episodeAction;
        if (action in EPISODE_CONFIRM_ACTIONS) {
          const confirmed =
            pendingEpisodeAction?.button === button &&
            pendingEpisodeAction.action === action &&
            pendingEpisodeAction.entryKey === episodeKey(entry) &&
            pendingEpisodeAction.ready;
          if (!confirmed) {
            armEpisodeActionConfirmation(button, entry, action);
            return;
          }
          cancelEpisodeActionConfirmation({ restoreButton: false });
          if (action === 'all-watched') {
            for (let number = 1; number <= Number(entry.episodes || 0); number++)
              setEpisodeState(entry, number, 'watched');
          } else {
            delete episodeProgress[episodeKey(entry)];
          }
        } else if (action === 'cycle') {
          const number = Number(button.dataset.episode);
          const current = episodeState(entry, number);
          setEpisodeState(entry, number, EPISODE_STATES[(EPISODE_STATES.indexOf(current) + 1) % 3]);
        } else if (action === 'watching') {
          setEpisodeState(entry, 1, 'watching');
        } else if (action === 'continue') {
          const total = Number(entry.episodes || 0);
          const active = Array.from({ length: total }, (_, index) => index + 1).find(
            (number) => episodeState(entry, number) === 'watching',
          );
          if (active) setEpisodeState(entry, active, 'watched');
          const next = Array.from({ length: total }, (_, index) => index + 1).find(
            (number) => episodeState(entry, number) === 'unwatched',
          );
          if (next) setEpisodeState(entry, next, 'watching');
        }
        save(STORE.episodes, episodeProgress);
        syncTitleStatusFromEpisodes(owner, group);
        refreshEpisodeTrackers(owner, group);
        renderMaster({ noMeta: true });
        if (state.tab === 'regions') renderWestern({ noMeta: true });
        if (state.tab === 'adult') renderAdult();
        if (state.tab === 'kids') renderKids({ noMeta: true });
        if (state.tab === 'favorites') renderFavorites();
        updateStats();
      }),
    );
  }

  function refreshEpisodeTrackers(owner, group) {
    $$('.episode-tracker-mount').forEach((mount) => {
      if (mount.dataset.episodeOwner === owner.id)
        mountEpisodeTracker(mount, owner, group, mount.dataset.episodeVariant || 'detail');
    });
  }

  function seriesMatchChoiceHTML(owner, candidates) {
    return `<div class="episode-match-choice"><div><b>SELECT THE CORRECT SERIES</b><span>Several possible matches were found for “${esc(owner.title)}”. Choose the one that should supply this episode list.</span></div><div class="episode-match-list">${candidates
      .map(
        (candidate) =>
          `<button type="button" data-series-provider="${esc(candidate.provider)}" data-series-id="${esc(candidate.id)}"><span><b>${esc(candidate.title)}</b>${candidate.altTitle && candidate.altTitle !== candidate.title ? `<small>${esc(candidate.altTitle)}</small>` : ''}</span><em>${esc([candidate.year || '', candidate.format || '', candidate.status || ''].filter(Boolean).join(' // ') || candidate.provider.toUpperCase())}</em></button>`,
      )
      .join('')}</div></div>`;
  }

  async function populateEpisodeMount(mount, owner, variant = 'detail', { chooseMatch = false } = {}) {
    mount.dataset.episodeOwner = owner.id;
    mount.dataset.episodeVariant = variant;
    mount.innerHTML = '<div class="episode-loading"><i></i><span>Loading connected seasons…</span></div>';
    try {
      const group = await loadSeriesGroup(owner, { chooseMatch });
      if (!group || !document.contains(mount)) return;
      mountEpisodeTracker(mount, owner, group, variant);
    } catch (error) {
      if (!document.contains(mount)) return;
      if (error?.code === 'series-match-choice' && Array.isArray(error.candidates)) {
        mount.innerHTML = seriesMatchChoiceHTML(owner, error.candidates);
        $$('[data-series-provider][data-series-id]', mount).forEach((button) =>
          button.addEventListener('click', () => {
            seriesGroups[owner.id] = {
              match: { provider: button.dataset.seriesProvider, id: button.dataset.seriesId },
            };
            save(STORE.series, seriesGroups);
            populateEpisodeMount(mount, owner, variant);
          }),
        );
        return;
      }
      mount.innerHTML = `<div class="episode-load-error"><b>EPISODE DATA UNAVAILABLE</b><span>${esc(error.message)}</span><button type="button">TRY AGAIN</button></div>`;
      $('button', mount).onclick = () => populateEpisodeMount(mount, owner, variant);
    }
  }

  function franchiseRepresentative(franchise) {
    const all = canonicalItems();
    const direct = findEquivalent({ title: franchise.name, year: 0, type: 'Series' }, all);
    if (direct && canTrackEpisodes(direct)) return direct;
    const target = norm(franchise.name)
      .replace(/\bseries\b/g, '')
      .trim();
    const partial = all
      .filter((item) => canTrackEpisodes(item) && target && norm(item.title).includes(target))
      .sort(
        (a, b) => norm(a.title).length - norm(b.title).length || (a.rank ?? 999999) - (b.rank ?? 999999),
      )[0];
    if (partial) return partial;
    for (const step of franchise.orders.flatMap((order) => order.steps || [])) {
      const item =
        franchiseStepItem(step) || findEquivalent({ title: step.title, year: 0, type: 'Series' }, all);
      if (item && canTrackEpisodes(item)) return item;
    }
    return null;
  }

  function franchiseItemPositions(franchise, item) {
    const itemName = norm(item?.title);
    if (!itemName) return [];
    const itemNames = [item.title, ...(Array.isArray(item.aliases) ? item.aliases : [])]
      .map((value) => norm(value))
      .filter(Boolean);
    const franchiseName = norm(franchise.name)
      .replace(/\b(animated universe|universe|franchise)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const positions = [];
    franchise.orders.forEach((order, orderIndex) => {
      (order.steps || []).forEach((step, stepIndex) => {
        const stepName = norm(step.title);
        // This code runs whenever a detail modal opens. Do not call the global
        // fuzzy matcher here: it scans every catalog title for every franchise
        // step, which becomes millions of comparisons with the large catalog.
        const matchesTitle =
          step.itemId === item.id ||
          itemNames.some((name) => stepName === name || stepName.includes(name) || name.includes(stepName));
        const matchesFranchise =
          orderIndex === 0 && stepIndex === 0 && franchiseName && itemName === franchiseName;
        if (matchesTitle || matchesFranchise) positions.push({ order, orderIndex, step, stepIndex });
      });
    });
    return positions;
  }

  function franchisesForItem(item) {
    return CAT.franchises
      .map((franchise) => ({ franchise, positions: franchiseItemPositions(franchise, item) }))
      .filter((entry) => entry.positions.length);
  }

  function franchiseBannerHTML(item) {
    const links = franchisesForItem(item);
    if (!links.length) return '';
    return `<div class="detail-franchise-links" aria-label="Franchise guides">${links
      .map(({ franchise, positions }) => {
        const first = positions[0];
        const stepNumber = first.step.n || String(first.stepIndex + 1);
        const total = first.order.steps?.length || 0;
        const split = Array.isArray(first.step.segments) && first.step.segments.length > 1;
        const timeRange = first.step.timeRange ? ` // ${first.step.timeRange}` : '';
        const position = `STEP ${stepNumber}${total ? ` OF ${total}` : ''}${timeRange}${split ? ` // ${first.step.segments.length} PARTS` : ''}`;
        return `<button class="detail-franchise-banner" type="button" data-open-franchise-id="${esc(franchise.id)}" aria-label="Open ${esc(franchise.name)} franchise guide"><span class="detail-franchise-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 6.5h14M5 12h10M5 17.5h14M17 9l3 3-3 3" /></svg></span><span><small>PART OF A FRANCHISE // ${esc(position)}</small><b>${esc(franchise.name)}</b></span><strong>OPEN WATCH ORDER <i>→</i></strong></button>`;
      })
      .join('')}</div>`;
  }

  function franchiseStepProgressKey(franchise, orderIndex, stepIndex, segmentIndex = 'full', step = null) {
    const stableStepId = String(step?.id || '').trim();
    const stepIdentity = stableStepId || `${orderIndex}:${stepIndex}`;
    return `${franchise.id}:${stepIdentity}:${segmentIndex}`;
  }

  function isLiveActionFranchiseStep(step) {
    return String(step.kind || '').toLowerCase() === 'live-action';
  }

  function franchiseStepItem(step) {
    if (isLiveActionFranchiseStep(step)) return null;
    if (step?.itemId) {
      const direct = itemById(step.itemId);
      if (direct) return direct;
    }
    const title = norm(step.title);
    if (!title) return null;
    return (
      canonicalItems().find(
        (item) => norm(item.title) === title || (item.aliases || []).some((alias) => norm(alias) === title),
      ) || null
    );
  }

  function franchiseStatusLabel(status) {
    if (status === 'Completed') return 'WATCHED';
    if (status === 'Watching') return 'WATCHING';
    return 'UNWATCHED';
  }

  function franchiseIncludesAnimation(franchise) {
    return franchise.orders.some((order) =>
      (order.steps || []).some((step) => !isLiveActionFranchiseStep(step)),
    );
  }

  function renderFranchiseStepProgress(container, franchise, orderIndex, stepIndex, step) {
    const segments = Array.isArray(step.segments) && step.segments.length ? step.segments : [null];
    const item = franchiseStepItem(step);
    if (!isLiveActionFranchiseStep(step) && !Array.isArray(step.segments) && !item) return;
    container.classList.add('has-franchise-progress');
    if (isLiveActionFranchiseStep(step)) container.classList.add('is-live-action');
    const titleStatus = item
      ? `<button class="franchise-title-status ${pFor(item.id).status.toLowerCase().replace(/\s+/g, '-')}" type="button" data-franchise-title-id="${esc(item.id)}" aria-label="Change ${esc(item.title)} watch status" data-tooltip="Cycle: Unwatched, Watching, Watched"><i aria-hidden="true"></i><span>${franchiseStatusLabel(pFor(item.id).status)}</span></button>`
      : '';
    const controls = segments
      .map((segment, segmentIndex) => {
        const id = segment?.id || segmentIndex;
        const key = franchiseStepProgressKey(franchise, orderIndex, stepIndex, id, step);
        const watched = franchiseProgress[key] === true;
        const label =
          segment?.label ||
          (segments.length > 1
            ? `PART ${segmentIndex + 1}`
            : step.timeRange
              ? `WATCH ${step.timeRange}`
              : 'MARK AS WATCHED');
        const note = segment?.note || step.resumeNote || '';
        return `<button class="franchise-step-toggle ${watched ? 'is-watched' : ''}" type="button" data-franchise-step-key="${esc(key)}" aria-pressed="${watched}" data-tooltip="${watched ? 'Mark as not watched' : 'Mark as watched'}"><i aria-hidden="true"></i><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</button>`;
      })
      .join('');
    const kind = isLiveActionFranchiseStep(step)
      ? '<span class="franchise-live-action">LIVE ACTION</span>'
      : '';
    container.insertAdjacentHTML(
      'beforeend',
      `<div class="franchise-step-progress">${titleStatus}${kind}${controls}</div>`,
    );
  }

  function decorateFranchiseSteps(franchises) {
    $$('.franchise', $('#franchiseStack')).forEach((details, franchiseIndex) => {
      const franchise = franchises[franchiseIndex];
      if (!franchise) return;
      $$('.order-block', details).forEach((block, orderIndex) => {
        $$('.step', block).forEach((stepElement, stepIndex) => {
          const step = franchise.orders[orderIndex]?.steps?.[stepIndex];
          if (!step) return;
          if (step.timeRange) {
            $('.step-title', stepElement)?.insertAdjacentHTML(
              'beforeend',
              `<small class="franchise-time-range">WATCH ${esc(step.timeRange)}</small>`,
            );
          }
          if (step.resumeNote) {
            $('.step-title', stepElement)?.insertAdjacentHTML(
              'beforeend',
              `<small class="franchise-resume-note">${esc(step.resumeNote)}</small>`,
            );
          }
          renderFranchiseStepProgress(stepElement, franchise, orderIndex, stepIndex, step);
        });
        const order = franchise.orders[orderIndex];
        if (order?.mode === 'strict-chronology')
          $('h4', block)?.insertAdjacentHTML(
            'beforeend',
            '<span class="franchise-chronology-badge">STRICT TIMESTAMPS</span>',
          );
      });
    });
    $$('[data-franchise-step-key]', $('#franchiseStack')).forEach((button) =>
      button.addEventListener('click', () => {
        const key = button.dataset.franchiseStepKey;
        if (franchiseProgress[key]) delete franchiseProgress[key];
        else franchiseProgress[key] = true;
        save(STORE.franchiseProgress, franchiseProgress);
        renderFranchises();
      }),
    );
    $$('[data-franchise-title-id]', $('#franchiseStack')).forEach((button) =>
      button.addEventListener('click', () => {
        const item = itemById(button.dataset.franchiseTitleId);
        if (!item) return;
        const current = pFor(item.id);
        const next =
          current.status === 'Not started'
            ? 'Watching'
            : current.status === 'Watching'
              ? 'Completed'
              : 'Not started';
        progress[item.id] = { ...current, status: next };
        save(STORE.progress, progress);
        renderAll();
        toast(`${item.title}: ${franchiseStatusLabel(next).toLowerCase()}`);
      }),
    );
  }

  function franchiseCompletionBadgeHTML() {
    return '<span class="franchise-completion" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.2 3.2 7.8-8"></path></svg>COMPLETE</span>';
  }

  function syncFranchiseCompletionState(mount, group) {
    const details = mount.closest('details.franchise');
    if (!details) return;
    const stats = groupEpisodeStats(group);
    const completed = Boolean(stats.total && stats.watched === stats.total);
    details.classList.toggle('is-completed', completed);
    const badge = $('.franchise-completion', details);
    if (badge) badge.hidden = !completed;
  }

  function renderFranchises({ preserveExpanded = true } = {}) {
    const expanded = preserveExpanded
      ? $$('details.franchise[open]', $('#franchiseStack')).map((details) => details.dataset.franchiseId)
      : [];
    const q = $('#franchiseSearch').value.trim().toLowerCase();
    const arr = CAT.franchises.filter(
      (f) =>
        franchiseIncludesAnimation(f) &&
        (!q || `${f.name} ${f.summary} ${JSON.stringify(f.orders)}`.toLowerCase().includes(q)),
    );
    $('#franchiseCount').textContent = `${formatCount(arr.length)} GUIDES`;
    $('#franchiseStack').innerHTML = arr.length
      ? arr
          .map((f, i) => {
            const representative = franchiseRepresentative(f);
            const cachedGroup = representative ? cachedSeriesGroup(representative) : null;
            const cachedStats = groupEpisodeStats(cachedGroup);
            const completed = Boolean(cachedStats.total && cachedStats.watched === cachedStats.total);
            return `<details class="franchise ${completed ? 'is-completed' : ''}" data-franchise-id="${esc(f.id)}" ${representative ? `data-series-owner="${esc(representative.id)}"` : ''}><summary><span class="franchise-no">${String(i + 1).padStart(2, '0')}</span><h3>${esc(f.name)}</h3>${franchiseCompletionBadgeHTML()}<span class="franchise-chevron">+</span></summary><div class="franchise-body"><p class="franchise-summary">${esc(f.summary)}</p>${representative ? `<div class="episode-tracker-mount franchise-episode-mount" data-episode-owner="${esc(representative.id)}" data-episode-variant="franchise"></div>` : ''}${f.orders.map((o) => `<section class="order-block"><h4>${esc(o.label)}</h4>${o.note ? `<p class="order-note">${esc(o.note)}</p>` : ''}<div class="steps">${o.steps.map((s) => `<div class="step"><span class="step-n">${esc(s.n)}</span><span class="step-title">${esc(s.title)}${s.note ? `<small class="step-note">${esc(s.note)}</small>` : ''}</span><span class="flag ${esc(s.flag)}">${esc(s.flag)}</span></div>`).join('')}</div></section>`).join('')}</div></details>`;
          })
          .join('')
      : '<div class="empty-state">No franchise guides match that search.</div>';
    $$('.franchise.is-completed .franchise-completion', $('#franchiseStack')).forEach(
      (badge) => (badge.hidden = false),
    );
    decorateFranchiseSteps(arr);
    restoreExpandedFranchises(expanded);
    $$('details.franchise[data-series-owner]', $('#franchiseStack')).forEach((details) =>
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.seriesLoaded) return;
        details.dataset.seriesLoaded = '1';
        const owner = itemById(details.dataset.seriesOwner);
        const mount = $('.franchise-episode-mount', details);
        if (owner && mount) populateEpisodeMount(mount, owner, 'franchise');
      }),
    );
    $$('details.franchise', $('#franchiseStack')).forEach((details) =>
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.franchiseItemsLoaded) return;
        details.dataset.franchiseItemsLoaded = '1';
        const franchise = CAT.franchises.find((item) => item.id === details.dataset.franchiseId);
        if (!franchise) return;
        void loadFranchiseItems(franchise).then((loaded) => {
          if (loaded && details.open) renderFranchises();
        });
      }),
    );
  }

  function openFranchiseGuide(id) {
    const franchise = CAT.franchises.find((item) => item.id === id);
    if (!franchise) return;
    switchTab('franchises');
    $('#franchiseSearch').value = franchise.name;
    saveUIState();
    renderFranchises();
    const guide = $$('details.franchise', $('#franchiseStack')).find(
      (details) => $('h3', details)?.textContent === franchise.name,
    );
    if (!guide) return;
    guide.open = true;
    guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Server availability and UserList sharing
  function scheduleArtworkStatusPoll() {
    clearTimeout(artworkStatusPoll);
    if (!state.server || !state.serverCoverRunning) return;
    artworkStatusPoll = setTimeout(() => checkServer(), 3000);
  }
  function activeVisibleTitles() {
    if (state.tab === 'regions') return filteredWestern().slice(0, state.westernVisible);
    if (state.tab === 'kids') return filteredKids().slice(0, state.kidsVisible);
    if (state.tab === 'adult') return filteredAdult().slice(0, PAGE_SIZE);
    if (state.tab === 'favorites')
      return canonicalItems()
        .filter((item) => isFavorite(item.id))
        .slice(0, PAGE_SIZE);
    return filteredMaster().slice(0, state.visible);
  }
  async function checkServer() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) throw 0;
      const j = await r.json();
      state.server = !!j.ok;
      state.signerCompatible = Number(j.userListSchema) >= 3;
      state.signerFormat = j.format || 'UWL';
      state.keyId = j.keyId || '';
      state.updateToken = j.updateToken || '';
      state.catalogWriteEnabled = Boolean(j.catalogWriteEnabled);
      state.catalogToken = j.catalogToken || '';
      state.serverCovers = Number(j.covers?.cached) || 0;
      state.serverCoverTotal = Number(j.covers?.total) || masterItems.length;
      state.serverCoverRunning = !!j.covers?.running;
      state.serverArtworkFailed = Number(j.artwork?.failed) || 0;
      state.serverArtworkDone = Number(j.artwork?.done) || 0;
      state.serverArtworkTotal = Number(j.artwork?.total) || 0;
      scheduleArtworkStatusPoll();
      $('#securityState').classList.toggle('ok', state.signerCompatible);
      $('#securityState').classList.toggle('bad', !state.signerCompatible);
      $('#securityState').innerHTML = state.signerCompatible
        ? `<b>PORTABLE USERLIST // ${esc(state.signerFormat)}</b><span>Ed25519 signing is ready · key ${esc(state.keyId)}</span>`
        : '<b>SERVER RESTART REQUIRED</b><span>The page is newer than the running server. Restart npm start, then reload.</span>';
      updateStats();
      queueMetadata(activeVisibleTitles(), { priority: true });
      pumpMetadata();
      hydrateMissingCustomMetadata();
      renderCorrectionWorkspace();
    } catch {
      clearTimeout(artworkStatusPoll);
      state.server = false;
      state.signerCompatible = false;
      state.catalogWriteEnabled = false;
      state.catalogToken = '';
      $('#securityState').classList.add('bad');
      $('#securityState').innerHTML =
        '<b>USERLIST SIGNING OFFLINE</b><span>Start the included server to create or verify signed UserList codes.</span>';
      renderCorrectionWorkspace();
    }
  }
  async function checkForUpdates() {
    try {
      const response = await fetch('/api/version', { cache: 'no-store' });
      if (!response.ok) return;
      const release = await response.json();
      if (!release.ok || !release.updateAvailable || !release.latest || !release.releaseUrl) return;
      if (load(STORE.dismissedUpdate, '') === release.latest) return;
      const releaseUrl = new URL(release.releaseUrl);
      if (
        releaseUrl.protocol !== 'https:' ||
        releaseUrl.hostname !== 'github.com' ||
        !releaseUrl.pathname.startsWith('/Firehawk52/ultimate-animation-index/releases/tag/')
      )
        return;
      availableUpdate = release.latest;
      $('#updateLatestVersion').textContent = release.latest;
      $('#updateCurrentVersion').textContent = release.current || APP_VERSION;
      $('#updateReleaseLink').href = releaseUrl.href;
      const installButton = $('#installUpdateBtn');
      installButton.hidden = !state.updateToken;
      if (!state.updateToken)
        $('#updateStatus').textContent =
          `Installed: ${release.current || APP_VERSION} · manual update required`;
      const notice = $('#updateNotice');
      notice.hidden = false;
      requestAnimationFrame(() => notice.classList.add('show'));
    } catch {
      // Update checks are advisory and must never interrupt the local catalog.
    }
  }
  async function installAvailableUpdate() {
    const button = $('#installUpdateBtn');
    const status = $('#updateStatus');
    if (!state.updateToken) await checkServer();
    if (!availableUpdate || !state.updateToken) {
      status.textContent = 'Automatic updating is unavailable here. Open the release for instructions.';
      return;
    }
    button.disabled = true;
    button.textContent = 'UPDATING…';
    status.textContent = 'Downloading and validating the latest source…';
    try {
      const response = await fetch('/api/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-UAI-Update-Token': state.updateToken,
        },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || result.error || 'Update failed');
      button.textContent = 'RESTARTING…';
      status.textContent = 'Update installed. Restarting the server…';
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        try {
          const healthResponse = await fetch('/api/health', { cache: 'no-store' });
          if (!healthResponse.ok) continue;
          const health = await healthResponse.json();
          if (health.version === availableUpdate) {
            status.textContent = 'Updated. Refreshing…';
            location.reload();
            return;
          }
        } catch {}
      }
      throw new Error(
        'The update was installed, but the server did not restart automatically. Start it manually.',
      );
    } catch (error) {
      button.disabled = false;
      button.textContent = 'TRY AGAIN';
      status.textContent = error.message;
    }
  }
  function renderUserSummary() {
    const rec = Object.values(myOpinions).filter((v) => v === 'recommend').length,
      no = Object.values(myOpinions).filter((v) => v === 'avoid').length,
      adds = customTitles.filter((x) => x.addedByMe).length;
    $('#userListSummary').innerHTML =
      `<div><b>${rec}</b><span>RECOMMENDED</span></div><div><b>${no}</b><span>NOT RECOMMENDED</span></div><div><b>${adds}</b><span>ADDED TITLES</span></div>`;
    renderBackupSummary();
    renderSources();
  }

  function currentUserData() {
    return {
      progress,
      opinions: myOpinions,
      customTitles,
      sources,
      favorites,
      episodeProgress,
      franchiseProgress,
      coverOverrides,
      translations: translationSettings,
      ui: load(STORE.ui, {}),
      compact: state.compact,
    };
  }

  function backupSummaryHTML(summary) {
    return [
      [summary.statuses, 'STATUSES'],
      [summary.episodes, 'EPISODES'],
      [summary.favorites, 'FAVORITES'],
      [summary.notes, 'PRIVATE NOTES'],
      [summary.customTitles, 'CUSTOM TITLES'],
    ]
      .map(([value, label]) => `<span><b>${value}</b><small>${label}</small></span>`)
      .join('');
  }

  function renderBackupSummary() {
    const mount = $('#backupSummary');
    if (!mount) return;
    try {
      mount.innerHTML = backupSummaryHTML(summarizeUserData(currentUserData()));
    } catch {
      mount.innerHTML = '<span><b>!</b><small>LOCAL DATA NEEDS REVIEW</small></span>';
    }
  }

  function exportUserBackup() {
    const button = $('#exportBackupBtn');
    button.disabled = true;
    button.textContent = 'BUILDING BACKUP…';
    try {
      const backup = createUserBackup(currentUserData(), { appVersion: APP_VERSION });
      const blob = new Blob([JSON.stringify(backup, null, 2) + '\n'], { type: 'application/json' });
      if (blob.size > 5 * 1024 * 1024) throw new Error('backup-too-large');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ultimate-animation-index-backup-${backup.createdAt.slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Private backup downloaded');
    } catch (error) {
      toast(`Backup failed: ${humanBackupError(error)}`);
    } finally {
      button.disabled = false;
      button.textContent = 'DOWNLOAD PRIVATE BACKUP';
    }
  }

  let selectedBackup = null;

  async function previewUserBackup() {
    const file = $('#backupFile').files?.[0];
    const preview = $('#backupPreview');
    const result = $('#backupResult');
    selectedBackup = null;
    $('#importBackupBtn').disabled = true;
    result.className = 'import-result';
    result.textContent = '';
    if (!file) {
      preview.className = 'backup-preview';
      preview.innerHTML =
        '<b>NO BACKUP SELECTED</b><span>Choose a UAI JSON backup to validate it before importing.</span>';
      return;
    }
    preview.className = 'backup-preview loading';
    preview.innerHTML =
      '<b>VALIDATING BACKUP</b><span>Checking format, limits and every local data record…</span>';
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('backup-too-large');
      const raw = await file.text();
      const backup = validateUserBackup(JSON.parse(raw));
      const summary = summarizeUserData(backup.data);
      selectedBackup = backup;
      preview.className = 'backup-preview good';
      preview.innerHTML = `<b>VALID BACKUP // ${esc(backup.createdAt.slice(0, 10))}</b><span>${summary.statuses} statuses · ${summary.episodes} episode marks · ${summary.favorites} favorites · ${summary.notes} private notes · ${summary.customTitles} custom titles</span>`;
      $('#importBackupBtn').disabled = false;
    } catch (error) {
      preview.className = 'backup-preview bad';
      preview.innerHTML = `<b>BACKUP REJECTED</b><span>${esc(humanBackupError(error))}</span>`;
    }
  }

  async function storeUserDataAtomically(data) {
    const updates = [
      [STORE.progress, data.progress],
      [STORE.opinions, data.opinions],
      [STORE.custom, data.customTitles],
      [STORE.sources, data.sources],
      [STORE.favorites, data.favorites],
      [STORE.episodes, data.episodeProgress],
      [STORE.franchiseProgress, data.franchiseProgress],
      [STORE.coverOverrides, data.coverOverrides],
      [STORE.ui, data.ui],
      [STORE.compact, data.compact],
      [STORE.translations, data.translations],
    ];
    const previous = { ...persistentUserData };
    try {
      updates.forEach(([key, value]) => {
        persistentUserData[key] = value;
      });
      await writePersistentUserData();
    } catch (error) {
      persistentUserData = previous;
      throw error;
    }
  }

  let selectedTranslationPack = null;
  function downloadJson(data, filename) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }),
    );
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(link);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function sameTranslationContributors(left, right) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
  }
  async function fetchJson(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`translation-fetch-${response.status}`);
    return response.json();
  }
  async function fetchOfficialTranslationPack(descriptor, basePath) {
    const pack = validateTranslationPack(await fetchJson(`${basePath}${descriptor.file}`));
    if (
      pack.locale !== descriptor.locale ||
      pack.language !== descriptor.language ||
      pack.revision !== descriptor.revision ||
      !sameTranslationContributors(pack.contributors, descriptor.contributors)
    )
      throw new Error('official-translation-metadata-mismatch');
    return pack;
  }
  function activeOfficialTranslation(locale = translationSettings.locale) {
    const bundled = availableOfficialTranslations.get(locale);
    if (!bundled) return null;
    let cached = null;
    try {
      cached = translationSettings.officialUpdates?.[locale]
        ? validateTranslationPack(translationSettings.officialUpdates[locale])
        : null;
    } catch {}
    if (cached?.revision >= bundled.descriptor.revision)
      return { descriptor: { ...bundled.descriptor, revision: cached.revision }, pack: cached, cached: true };
    return bundled;
  }
  async function loadOfficialTranslations() {
    try {
      officialTranslationRegistry = validateOfficialTranslationRegistry(
        await fetchJson(OFFICIAL_TRANSLATIONS_PATH),
      );
      availableOfficialTranslations = new Map(
        officialTranslationRegistry.languages.map((language) => [language.locale, { descriptor: language }]),
      );
      if (translationSettings.source !== 'official') return;
      const selected = availableOfficialTranslations.get(translationSettings.locale);
      if (!selected) throw new Error('official-translation-not-installed');
      const active = activeOfficialTranslation();
      if (active?.pack) {
        interfaceI18n.setPack(active.pack);
        return;
      }
      selected.pack = await fetchOfficialTranslationPack(selected.descriptor, 'translations/');
      interfaceI18n.setPack(selected.pack);
    } catch (error) {
      if (translationSettings.source === 'official') interfaceI18n.setPack(null);
      console.warn('Official translations unavailable:', error.message);
    }
  }
  function renderTranslationCredits() {
    const mount = $('#translationCredits');
    const active = translationSettings.source === 'official' ? activeOfficialTranslation() : null;
    const names = officialCreditNames(active?.pack || active?.descriptor);
    if (!active || !names.length) {
      mount.hidden = true;
      mount.textContent = '';
      return;
    }
    mount.hidden = false;
    mount.innerHTML = `<b>OFFICIAL TRANSLATION</b><br>Translation by ${esc(
      names.join(names.length === 2 ? ' and ' : ', '),
    )}.`;
  }
  function renderInterfaceLanguages() {
    const select = $('#interfaceLanguage');
    if (!select) return;
    const localPack = translationSettings.pack;
    const officialOptions = [...availableOfficialTranslations.values()]
      .sort((left, right) => left.descriptor.language.localeCompare(right.descriptor.language))
      .map(
        ({ descriptor }) =>
          `<option value="official:${esc(descriptor.locale)}">${esc(descriptor.language).toUpperCase()} — OFFICIAL</option>`,
      )
      .join('');
    const localOption = localPack
      ? `<option value="local:${esc(localPack.locale)}">${esc(localPack.language || localPack.locale).toUpperCase()} — LOCAL</option>`
      : '';
    select.innerHTML = `<option value="en">ENGLISH</option>${officialOptions}${localOption}`;
    select.value =
      translationSettings.source === 'official'
        ? `official:${translationSettings.locale}`
        : translationSettings.source === 'local' && localPack
          ? `local:${localPack.locale}`
          : 'en';
    renderTranslationCredits();
  }
  function renderOfficialTranslationUpdate() {
    const mount = $('#officialTranslationUpdate');
    if (!availableRemoteTranslation || translationSettings.source !== 'official') {
      mount.hidden = true;
      return;
    }
    mount.hidden = false;
    $('#officialTranslationUpdateText').textContent =
      `Official ${availableRemoteTranslation.language} revision ${availableRemoteTranslation.revision} is available.`;
  }
  async function checkOfficialTranslationUpdate() {
    if (translationSettings.source !== 'official') return;
    const locale = translationSettings.locale;
    const checkedAt = Number(translationSettings.officialCheck?.[locale] || 0);
    if (Date.now() - checkedAt < OFFICIAL_TRANSLATION_CHECK_TTL) return;
    try {
      const registry = validateOfficialTranslationRegistry(
        await fetchJson(`${OFFICIAL_TRANSLATIONS_REMOTE}index.json`),
      );
      const remote = registry.languages.find((language) => language.locale === locale);
      const current = activeOfficialTranslation(locale);
      const currentRevision = current?.pack?.revision || current?.descriptor?.revision || 0;
      if (remote && current && remote.revision > currentRevision) availableRemoteTranslation = remote;
    } catch (error) {
      console.warn('Official translation update check failed:', error.message);
    } finally {
      translationSettings.officialCheck[locale] = Date.now();
      save(STORE.translations, translationSettings);
      renderOfficialTranslationUpdate();
    }
  }
  async function installOfficialTranslationUpdate() {
    if (!availableRemoteTranslation) return;
    const button = $('#installOfficialTranslationUpdate');
    button.disabled = true;
    button.textContent = 'DOWNLOADING…';
    try {
      const pack = await fetchOfficialTranslationPack(
        availableRemoteTranslation,
        OFFICIAL_TRANSLATIONS_REMOTE,
      );
      translationSettings.officialUpdates[pack.locale] = pack;
      translationSettings.locale = pack.locale;
      translationSettings.source = 'official';
      save(STORE.translations, translationSettings);
      toast('Official translation update installed. Refreshing…');
      setTimeout(() => location.reload(), 450);
    } catch (error) {
      toast('Official translation update could not be installed');
      console.warn('Official translation update failed:', error.message);
      button.disabled = false;
      button.textContent = 'INSTALL OFFICIAL UPDATE';
    }
  }
  function currentTranslationTemplate() {
    interfaceI18n.apply(document);
    const template = interfaceI18n.template();
    template.appVersion = APP_VERSION;
    const catalogIdentity = new Set(
      canonicalItems()
        .flatMap((item) => [item.title, item.lookupTitle, ...(item.aliases || [])])
        .filter(Boolean)
        .map(norm),
    );
    template.entries = template.entries.filter((entry) => {
      const source = norm(entry.source);
      return ![...catalogIdentity].some((identity) => identity && source.includes(identity));
    });
    if (!template.entries.length) throw new Error('translation-template-empty');
    return template;
  }
  function exportTranslationTemplate() {
    const result = $('#translationResult');
    try {
      const template = currentTranslationTemplate();
      downloadJson(template, `ultimate-animation-index-translation-template-${APP_VERSION}.json`);
      result.className = 'import-result good';
      result.textContent = `Template downloaded // ${formatCount(template.entries.length)} interface strings`;
      toast('Translation template downloaded');
    } catch (error) {
      console.error('Translation template export failed:', error);
      result.className = 'import-result bad';
      result.textContent = 'Template download failed. Open the browser console for the technical detail.';
    }
  }
  function downloadTranslationUpdate() {
    const result = $('#translationResult');
    if (!selectedTranslationPack) return;
    try {
      const template = currentTranslationTemplate();
      const previousByKey = new Map(selectedTranslationPack.entries.map((entry) => [entry.key, entry]));
      const previousBySourceHash = new Map(
        selectedTranslationPack.entries.map((entry) => [entry.sourceHash, entry]),
      );
      let carriedForward = 0;
      let needsTranslation = 0;
      template.locale = selectedTranslationPack.locale;
      template.language = selectedTranslationPack.language;
      template.revision = selectedTranslationPack.revision;
      template.contributors = selectedTranslationPack.contributors;
      template.update = { fromAppVersion: selectedTranslationPack.appVersion || 'unknown' };
      template.entries = template.entries.map((entry) => {
        // Source-hash fallback carries forward packs created before stable UI keys
        // were introduced. New templates use the key to identify edited text.
        const previous = previousByKey.get(entry.key) || previousBySourceHash.get(entry.sourceHash);
        const unchanged = previous && previous.sourceHash === entry.sourceHash;
        if (unchanged && previous.translation) carriedForward += 1;
        if (!unchanged) needsTranslation += 1;
        return {
          ...entry,
          // Keep the translator's previous wording visible when the English source
          // changes. The status tells them it needs a review; it never discards work.
          translation: previous?.translation || '',
          updateStatus: unchanged
            ? previous.translation
              ? 'carried-forward'
              : 'existing-untranslated'
            : previous
              ? 'source-changed'
              : 'new',
        };
      });
      if (!needsTranslation) {
        result.className = 'import-result good';
        result.textContent = 'No new or changed interface strings. This translation pack is up to date.';
        toast('Translation pack is up to date');
        return;
      }
      template.update.carriedForward = carriedForward;
      template.update.needsTranslation = needsTranslation;
      downloadJson(
        template,
        `ultimate-animation-index-translation-update-${selectedTranslationPack.locale}-${APP_VERSION}.json`,
      );
      result.className = 'import-result good';
      result.textContent = `Updated template downloaded // ${carriedForward} carried forward // ${needsTranslation} to translate`;
      toast('Updated translation template downloaded');
    } catch (error) {
      console.error('Translation update template export failed:', error);
      result.className = 'import-result bad';
      result.textContent =
        'Updated template download failed. Open the browser console for the technical detail.';
    }
  }
  async function previewTranslationPack() {
    const file = $('#translationPackFile').files?.[0],
      result = $('#translationResult');
    selectedTranslationPack = null;
    $('#importTranslationPack').disabled = true;
    $('#downloadTranslationUpdate').disabled = true;
    result.className = 'import-result';
    result.textContent = '';
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('translation-pack-too-large');
      selectedTranslationPack = validateTranslationPack(JSON.parse(await file.text()));
      const translated = selectedTranslationPack.entries.filter((entry) => entry.translation).length;
      result.classList.add('good');
      result.textContent = `${selectedTranslationPack.language} // ${formatCount(translated)}/${formatCount(selectedTranslationPack.entries.length)} translated lines // ready to update`;
      $('#importTranslationPack').disabled = false;
      $('#downloadTranslationUpdate').disabled = false;
    } catch (error) {
      result.classList.add('bad');
      result.textContent =
        error.message === 'outdated-translation-source'
          ? 'This pack is outdated: its English source changed.'
          : 'Translation pack rejected. Check its format and source hashes.';
    }
  }
  function installTranslationPack() {
    if (!selectedTranslationPack) return;
    translationSettings.locale = selectedTranslationPack.locale;
    translationSettings.source = 'local';
    translationSettings.pack = selectedTranslationPack;
    save(STORE.translations, translationSettings);
    saveUIState();
    toast('Translation pack installed. Refreshing…');
    setTimeout(() => location.reload(), 450);
  }

  async function importUserBackup() {
    const result = $('#backupResult');
    result.className = 'import-result';
    result.textContent = '';
    if (!selectedBackup) {
      result.classList.add('bad');
      result.textContent = 'Choose and validate a backup first.';
      return;
    }
    const mode = $('#backupImportMode').value;
    if (
      mode === 'replace' &&
      !confirm(
        'Replace all current local user data with this backup? This cannot be undone without another backup.',
      )
    )
      return;
    try {
      const next = combineUserData(currentUserData(), selectedBackup.data, mode);
      await storeUserDataAtomically(next);
      location.reload();
    } catch (error) {
      result.classList.add('bad');
      result.textContent = `Nothing was imported. ${humanBackupError(error)}`;
    }
  }

  function humanBackupError(error) {
    const code = typeof error === 'string' ? error : error?.message || '';
    const messages = {
      'unsupported-backup': 'This is not a supported Ultimate Animation Index backup.',
      'backup-too-large': 'The backup is larger than the 5 MB safety limit.',
      'invalid-watch-status': 'The backup contains an invalid watch status.',
      'invalid-rating': 'The backup contains an invalid personal rating.',
      'invalid-private-note': 'The backup contains an invalid private note.',
      'invalid-episode-state': 'The backup contains an invalid episode state.',
      'too-many-episode-states': 'The backup contains too many episode states.',
      'invalid-custom-titles': 'The backup contains invalid custom titles.',
      'invalid-catalog-score': 'The backup contains an invalid custom-title quality score.',
      'invalid-import-mode': 'Choose a valid import mode.',
    };
    if (error instanceof SyntaxError || /JSON|Unexpected token|Unexpected end/i.test(code))
      return 'The file is not valid JSON.';
    if (code.startsWith('invalid-') || code.startsWith('too-many-'))
      return messages[code] || 'The backup contains invalid or unsafe data.';
    return messages[code] || 'The browser could not store the backup data.';
  }

  function renderSources() {
    const arr = Object.entries(sources).sort((a, b) =>
      (b[1].importedAt || '').localeCompare(a[1].importedAt || ''),
    );
    $('#sourceList').innerHTML = arr.length
      ? arr
          .map(([sid, s]) => {
            const rec = Object.values(s.opinions || {}).filter((v) => v === 'recommend').length,
              no = Object.values(s.opinions || {}).filter((v) => v === 'avoid').length;
            return `<div class="source-item"><div><b>${esc(s.label)}</b><span>${rec} rec · ${no} no · ${(s.titleIds || []).length} custom titles</span></div><span>${esc((s.importedAt || '').slice(0, 10))}</span><button data-remove-source="${esc(sid)}" type="button">REMOVE</button></div>`;
          })
          .join('')
      : '<div class="empty-state" style="padding:24px">No imported UserLists yet.</div>';
    $$('[data-remove-source]', $('#sourceList')).forEach((b) =>
      b.addEventListener('click', () => removeSource(b.dataset.removeSource)),
    );
  }
  function removeSource(sid) {
    if (!sources[sid]) return;
    delete sources[sid];
    save(STORE.sources, sources);
    // Remove imported-only custom titles that no remaining source uses and that you did not add yourself / opine on.
    const used = new Set(
      Object.values(sources).flatMap((s) => [...Object.keys(s.opinions || {}), ...(s.titleIds || [])]),
    );
    customTitles = customTitles.filter(
      (x) => x.addedByMe || myOpinions[x.id] || favorites[x.id] || used.has(x.id),
    );
    save(STORE.custom, customTitles);
    populateFilters();
    renderAll();
    toast('Imported source removed');
  }

  async function generateUserList() {
    if (!state.server) {
      toast('Secure signer is offline');
      return;
    }
    if (!state.signerCompatible) {
      toast('Restart the included server, then reload');
      return;
    }
    const opinionEntries = Object.entries(myOpinions)
      .filter(([id, v]) => itemById(id) && ['recommend', 'avoid'].includes(v))
      .map(([id, verdict]) => ({ id, verdict }));
    const needed = new Set([
      ...customTitles.filter((x) => x.addedByMe || coverSourceFor(x)).map((x) => x.id),
      ...opinionEntries.map((o) => o.id).filter((id) => !masterById.has(id)),
      ...Object.keys(coverOverrides).filter((id) => itemById(id)),
    ]);
    const titleEntries = canonicalItems()
      .filter((x) => needed.has(x.id))
      .map((x) => ({
        id: x.id,
        title: x.title,
        year: Number(x.year) || 0,
        type: x.type || 'Series',
        origin: x.origin || 'Unknown',
        api: x.api || 'none',
        lookupTitle: x.lookupTitle || x.title,
        externalId: String(x.externalId || ''),
        genres: x.genres || '',
        content: normalizedContent(x.content),
        ...(coverSourceFor(x) ? { coverSource: coverSourceFor(x) } : {}),
      }));
    $('#generateCodeBtn').disabled = true;
    $('#generateCodeBtn').textContent = 'SIGNING…';
    try {
      const r = await fetch('/api/userlist/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          created: new Date().toISOString(),
          opinions: opinionEntries,
          titles: titleEntries,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'sign-failed');
      $('#exportCode').value = j.code;
      toast('Signed UserList generated');
    } catch (e) {
      toast(`Could not sign: ${e.message}`);
    } finally {
      $('#generateCodeBtn').disabled = false;
      $('#generateCodeBtn').textContent = 'GENERATE SIGNED CODE';
    }
  }
  async function importUserList() {
    const label = $('#importSourceName').value.trim(),
      code = $('#importCode').value.trim(),
      out = $('#importResult');
    out.className = 'import-result';
    out.textContent = '';
    if (!label) {
      out.classList.add('bad');
      out.textContent = 'Choose the local source name first.';
      return;
    }
    if (label.length > 40 || /[<>\u0000-\u001F]/.test(label)) {
      out.classList.add('bad');
      out.textContent = 'Source name is invalid.';
      return;
    }
    if (!code) {
      out.classList.add('bad');
      out.textContent = 'Paste a UserList code.';
      return;
    }
    if (!state.server) {
      out.classList.add('bad');
      out.textContent = 'Signature service is offline.';
      return;
    }
    if (!state.signerCompatible) {
      out.classList.add('bad');
      out.textContent = 'Restart the included server, reload the page and try again.';
      return;
    }
    $('#importCodeBtn').disabled = true;
    $('#importCodeBtn').textContent = 'VERIFYING…';
    try {
      const r = await fetch('/api/userlist/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'verification-failed');
      const payload = j.payload;
      // Work on clones. Commit only after every item is merged successfully.
      const nextCustom = JSON.parse(JSON.stringify(customTitles)),
        nextSources = JSON.parse(JSON.stringify(sources));
      const all = [...masterItems, ...nextCustom];
      const idMap = new Map(all.map((x) => [x.id, x]));
      const incomingMap = new Map();
      let newCount = 0,
        mergedCount = 0;
      for (const t of payload.titles) {
        let existing = idMap.get(t.id) || findEquivalent(t, all);
        if (existing) {
          if (existing.custom && !existing.addedByMe) applySharedCustomMetadata(existing, t);
          if (t.coverSource) coverOverrides[existing.id] = t.coverSource;
          incomingMap.set(t.id, existing.id);
          mergedCount++;
          continue;
        }
        const x = customFromPayload(t, false);
        nextCustom.push(x);
        all.push(x);
        idMap.set(x.id, x);
        incomingMap.set(t.id, x.id);
        newCount++;
      }
      const existingSid = Object.keys(nextSources).find(
        (s) => nextSources[s].label.toLowerCase() === label.toLowerCase(),
      );
      const sid = existingSid || `src:${crypto.randomUUID()}`;
      const record = { label, importedAt: new Date().toISOString(), opinions: {}, titleIds: [] };
      for (const o of payload.opinions) {
        const mapped = incomingMap.get(o.id) || idMap.get(o.id)?.id || o.id;
        if (!idMap.has(mapped) && !masterById.has(mapped)) throw new Error('unknown-title-reference');
        record.opinions[mapped] = o.verdict;
      }
      record.titleIds = payload.titles
        .map((t) => incomingMap.get(t.id) || t.id)
        .filter((id) => !masterById.has(id));
      nextSources[sid] = record;
      customTitles = nextCustom;
      sources = nextSources;
      save(STORE.custom, customTitles);
      save(STORE.sources, sources);
      save(STORE.coverOverrides, coverOverrides);
      populateFilters();
      renderAll();
      hydrateMissingCustomMetadata();
      hydrateManualCoverSources();
      out.classList.add('good');
      out.textContent = `Verified key ${j.keyId}. ${formatCount(newCount)} new title${newCount === 1 ? '' : 's'}, ${formatCount(mergedCount)} merged without duplicates, ${formatCount(payload.opinions.length)} opinions attached to “${label}”.`;
      toast(`UserList imported: ${label}`);
    } catch (e) {
      out.classList.add('bad');
      out.textContent = `Rejected. Nothing was imported. ${humanImportError(e.message)}`;
    } finally {
      $('#importCodeBtn').disabled = false;
      $('#importCodeBtn').textContent = 'VERIFY + IMPORT';
    }
  }
  function humanImportError(e) {
    const m = {
      'signature-failed': 'The code was modified or the signature is invalid.',
      'not-userlist-code': 'This is not a supported UWL code.',
      'invalid-schema': 'The payload does not match the UserList schema.',
      'invalid-code': 'The code is malformed.',
    };
    return m[e] || e;
  }
  function findEquivalent(t, all) {
    const n = norm(t.title);
    const aliasId = aliasMap.get(n);
    if (aliasId) {
      const m = masterById.get(aliasId);
      if (!t.year || !m?.year || Math.abs(Number(t.year) - Number(m.year)) <= 1) return m;
    }
    return (
      all.find((x) => {
        const same = norm(x.title) === n || (x.aliases || []).some((a) => norm(a) === n);
        if (!same) return false;
        const y1 = Number(x.year) || 0,
          y2 = Number(t.year) || 0;
        if (y1 && y2 && Math.abs(y1 - y2) > 1) return false;
        return roughlySameType(x.type, t.type);
      }) || null
    );
  }
  function roughlySameType(a = '', b = '') {
    const A = a.toLowerCase(),
      B = b.toLowerCase();
    if (A.includes('film') !== B.includes('film')) return false;
    if (
      A.includes('series') !== B.includes('series') &&
      A.includes('film') === false &&
      B.includes('film') === false
    )
      return true;
    return true;
  }
  function customFromPayload(t, addedByMe) {
    const adult = (t.type || '').toLowerCase().includes('hentai');
    const fallbackContent = adult
      ? { sex: 5, nudity: 5, violence: 0, gore: 0, disturbing: 1, tags: ['Hentai', 'Adult Only'] }
      : { sex: 0, nudity: 0, violence: 0, gore: 0, disturbing: 0, tags: [] };
    return {
      id: t.id,
      title: t.title,
      year: Number(t.year) || 0,
      type: t.type,
      origin: t.origin || 'Unknown',
      genres: t.genres || (adult ? 'Adult, Hentai' : 'Custom addition'),
      tier: 'CUSTOM',
      rank: null,
      quality_band: 'CUSTOM',
      api: t.api || 'none',
      lookupTitle: t.lookupTitle || t.title,
      externalId: t.externalId || '',
      ...(t.coverSource ? { coverSource: t.coverSource } : {}),
      custom: true,
      addedByMe,
      content: t.content ? normalizedContent(t.content) : fallbackContent,
      scores: {
        overall: Math.max(0, Math.min(100, Number(t.scores?.overall) || 0)),
        production: Math.max(0, Math.min(10, Number(t.scores?.production) || 0)),
        story: Math.max(0, Math.min(10, Number(t.scores?.story) || 0)),
        emotional: Math.max(0, Math.min(10, Number(t.scores?.emotional) || 0)),
      },
    };
  }

  function normalizedContent(content = {}) {
    const level = (key) => Math.max(0, Math.min(5, Math.round(Number(content[key]) || 0)));
    const tags = Array.isArray(content.tags)
      ? [
          ...new Map(
            content.tags.map((tag) => [String(tag).trim().toLowerCase(), String(tag).trim()]),
          ).values(),
        ]
          .filter(Boolean)
          .slice(0, 20)
      : [];
    return {
      sex: level('sex'),
      nudity: level('nudity'),
      violence: level('violence'),
      gore: level('gore'),
      disturbing: level('disturbing'),
      tags,
    };
  }

  function applySharedCustomMetadata(target, incoming) {
    target.title = incoming.title;
    target.year = Number(incoming.year) || 0;
    target.type = incoming.type;
    target.origin = incoming.origin || 'Unknown';
    target.genres = incoming.genres || target.genres || 'Custom addition';
    target.api = incoming.api || target.api || 'none';
    target.lookupTitle = incoming.lookupTitle || incoming.title;
    target.externalId = incoming.externalId || '';
    if (incoming.content) target.content = normalizedContent(incoming.content);
    if (incoming.coverSource) target.coverSource = incoming.coverSource;
  }

  function customMetadataKinds(type = '', origin = '') {
    const format = type.toLowerCase();
    const place = origin.toLowerCase();
    const asian = /japan|japanese|china|chinese|korea|korean/.test(place);
    if (format.includes('western series')) return ['tvmaze', 'wiki', 'anilist'];
    if (format.includes('western film')) return ['wiki', 'tvmaze', 'anilist'];
    if (/ova|ona|donghua|hentai/.test(format) || asian) return ['anilist', 'wiki', 'tvmaze'];
    if (format.includes('series')) return ['tvmaze', 'anilist', 'wiki'];
    return ['anilist', 'wiki', 'tvmaze'];
  }

  function metadataMatchesTitle(title, data, year = 0) {
    const target = norm(title);
    const candidates = [data?.canonicalTitle, data?.altTitle].filter(Boolean).map(norm);
    if (!target || !candidates.length) return false;
    if (year && data?.year && Math.abs(Number(year) - Number(data.year)) > 1) return false;
    const targetTokens = new Set(target.split(' ').filter(Boolean));
    return candidates.some((candidate) => {
      if (candidate === target) return true;
      if (
        Math.min(candidate.length, target.length) >= 5 &&
        (candidate.includes(target) || target.includes(candidate))
      )
        return true;
      const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
      const shared = [...targetTokens].filter((token) => candidateTokens.has(token)).length;
      const union = new Set([...targetTokens, ...candidateTokens]).size;
      return union > 0 && shared / union >= 0.6;
    });
  }

  function contentIsEmpty(content) {
    const value = normalizedContent(content);
    return (
      !value.tags.some((tag) => tag.toLowerCase() !== ADULT_CATALOG_TAG.toLowerCase()) &&
      !['sex', 'nudity', 'violence', 'gore', 'disturbing'].some((key) => value[key])
    );
  }

  function metadataCompleteness(data) {
    if (!data) return 0;
    let score = 0;
    if (data.cover) score += 4;
    if (data.description) score += 2;
    if (Array.isArray(data.genres) && data.genres.length) score += 2;
    if (data.year) score += 1;
    if (data.studio) score += 1;
    if (data.content && !contentIsEmpty(data.content)) score += 1;
    return score;
  }

  async function findCustomMetadata(title, type, origin, year = 0) {
    if (!state.server || NO_META) return null;
    let best = null;
    for (const kind of customMetadataKinds(type, origin)) {
      try {
        const response = await fetch(
          `/api/resolve?kind=${encodeURIComponent(kind)}&title=${encodeURIComponent(title)}`,
        );
        const result = await response.json();
        if (response.ok && result.ok && metadataMatchesTitle(title, result.data, year)) {
          const candidate = { kind, data: result.data, score: metadataCompleteness(result.data) };
          if (!best || candidate.score > best.score) best = candidate;
          if (candidate.score >= 8) return candidate;
        }
      } catch {}
    }
    return best;
  }

  function applyResolvedCustomMetadata(x, match) {
    if (!match?.data) return;
    const data = match.data;
    x.api = match.kind;
    x.lookupTitle = x.title;
    x.externalId = data.externalId || '';
    if (!x.year && data.year) x.year = Number(data.year) || 0;
    if ((!x.genres || x.genres === 'Custom addition') && Array.isArray(data.genres) && data.genres.length)
      x.genres = data.genres.join(', ');
    if (contentIsEmpty(x.content) && data.content) {
      x.content = setAdultCatalogTitle(data.content, isAdultCatalogTitle(x.content));
      x.contentEstimated = true;
    }
    meta[x.id] = { ts: Date.now(), data };
    save(STORE.custom, customTitles);
    save(STORE.meta, meta);
  }

  async function refreshCustomMetadata(x, { force = false, silent = false } = {}) {
    if (!x?.custom) return false;
    if (!force && metaFresh(x.id) && metadataCompleteness(meta[x.id]?.data) >= 6) return true;
    const match = await findCustomMetadata(x.lookupTitle || x.title, x.type, x.origin, x.year);
    if (!match) {
      if (!silent) toast('No reliable metadata match found');
      return false;
    }
    applyResolvedCustomMetadata(x, match);
    refreshArtwork();
    if (!silent) toast('Metadata and estimated content ratings updated');
    return true;
  }

  async function hydrateMissingCustomMetadata() {
    for (const x of customTitles) {
      if (!state.server) return;
      if (!metaFresh(x.id) || metadataCompleteness(meta[x.id]?.data) < 6)
        await refreshCustomMetadata(x, { silent: true });
    }
  }

  // Manual title resolution and deduplication
  async function addTitle(ev) {
    ev.preventDefault();
    const out = $('#addResult'),
      raw = $('#addTitleName').value.trim(),
      year = Number($('#addTitleYear').value) || 0,
      type = $('#addTitleType').value,
      origin = $('#addTitleOrigin').value.trim() || 'Unknown',
      includeInAdult = $('#addTitleAdult').checked || type === 'Adult / Hentai';
    out.className = 'import-result';
    if (!raw) {
      return;
    }
    const pre = findEquivalent({ title: raw, year, type }, canonicalItems());
    if (pre) {
      out.classList.add('bad');
      out.innerHTML = `Already exists: <button class="inline-open" data-open-id="${esc(pre.id)}" type="button">${esc(pre.title)}</button>`;
      out.querySelector('button').onclick = () => openDetail(pre.id);
      return;
    }
    let match = null;
    out.textContent = 'Resolving title and checking canonical metadata…';
    if (state.server) match = await findCustomMetadata(raw, type, origin, year);
    const resolved = match?.data || null,
      kind = match?.kind || customMetadataKinds(type, origin)[0],
      title = raw,
      finalYear = year || resolved?.year || 0;
    const second = findEquivalent(
      { title: resolved?.canonicalTitle || title, year: finalYear, type },
      canonicalItems(),
    );
    if (second) {
      out.classList.add('bad');
      out.innerHTML = `Resolved to an existing title: <button class="inline-open" data-open-id="${esc(second.id)}" type="button">${esc(second.title)}</button>`;
      out.querySelector('button').onclick = () => openDetail(second.id);
      return;
    }
    let id;
    if (resolved?.externalId) {
      id = `${kind === 'anilist' ? 'a' : kind === 'tvmaze' ? 't' : 'w'}:${resolved.externalId}`;
    } else {
      id = await fallbackId(title, finalYear, type);
    }
    if (itemById(id)) {
      out.classList.add('bad');
      out.textContent = 'That canonical title already exists.';
      return;
    }
    const t = {
      id,
      title,
      year: finalYear,
      type,
      origin,
      api: kind,
      lookupTitle: title,
      externalId: resolved?.externalId || '',
      genres: Array.isArray(resolved?.genres) ? resolved.genres.join(', ') : '',
      content: resolved?.content,
    };
    const x = customFromPayload(t, true);
    x.content = setAdultCatalogTitle(x.content, includeInAdult);
    if (resolved?.content && !contentIsEmpty(resolved.content)) x.contentEstimated = true;
    customTitles.push(x);
    save(STORE.custom, customTitles);
    if (resolved) meta[id] = { ts: Date.now(), data: resolved };
    save(STORE.meta, meta);
    populateFilters();
    renderAll();
    out.classList.add('good');
    out.innerHTML = `Added “${esc(title)}” without changing the editorial master ranking. <button class="inline-open" type="button">EDIT DETAILS</button>`;
    out.querySelector('button').onclick = () => openDetail(id);
    $('#addTitleForm').reset();
    toast('Custom title added');
  }
  async function fallbackId(title, year, type) {
    const input = `${norm(title)}|${year || 0}|${norm(type)}`;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const hex = [...new Uint8Array(hash)]
      .slice(0, 6)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `c:${norm(title).replace(/ /g, '-').slice(0, 70) || 'title'}:${hex}`;
  }

  function customEditorHTML(x) {
    const content = normalizedContent(x.content);
    const kidsCandidate = isForKidsCandidate(x);
    const formats = [
      'Series',
      'Film',
      'OVA',
      'ONA',
      'Special',
      'Donghua series',
      'Western series',
      'Western film',
      'Adult / Hentai',
    ];
    if (x.type && !formats.includes(x.type)) formats.unshift(x.type);
    const levels = [
      ['Sexual content', 'sex'],
      ['Nudity', 'nudity'],
      ['Violence', 'violence'],
      ['Gore', 'gore'],
      ['Disturbing', 'disturbing'],
    ];
    const contentControls = kidsCandidate
      ? notForKidsToggleHTML(content, 'customNotForKids')
      : `<label class="field-label">CONTENT LABELS<input id="customContentTags" type="text" maxlength="500" value="${esc(content.tags.join(', '))}" placeholder="Family, Adventure, …"></label>${adultCatalogToggleHTML(content, 'customAdult')}<div class="custom-content-fields">${levels.map(([label, key]) => `<label>${esc(label)}<input id="customContent-${key}" type="number" min="0" max="5" step="1" value="${content[key]}"><span>/5</span></label>`).join('')}</div>`;
    return `<details class="custom-editor optional-editor"><summary class="optional-editor-summary"><div><span>CUSTOM DATA</span><h4>Edit custom metadata</h4></div><b>LOCAL TITLE</b><i class="optional-editor-chevron" aria-hidden="true"></i></summary><div class="optional-editor-body"><p>These fields are included when this title is exported in a signed UserList. Provider-based content ratings are estimates and should be reviewed.</p><button id="refreshCustomMetadata" class="slash-button small" type="button">${x.contentEstimated ? 'REFRESH ESTIMATED METADATA' : 'FIND MISSING METADATA'}</button><div class="custom-editor-grid"><label class="field-label">TITLE<input id="customTitle" type="text" maxlength="180" value="${esc(x.title)}"></label><div class="field-row"><label class="field-label">YEAR<input id="customYear" type="number" min="0" max="2200" value="${Number(x.year) || ''}" placeholder="Unknown"></label><label class="field-label">FORMAT<select id="customType">${formats.map((type) => `<option ${x.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}</select></label></div><label class="field-label">ORIGIN<input id="customOrigin" type="text" maxlength="80" value="${esc(x.origin || '')}" placeholder="Japan / US / China / …"></label><label class="field-label">GENRES / TAGS<textarea id="customGenres" maxlength="500" placeholder="Fantasy, Adventure, Drama">${esc(x.genres || '')}</textarea></label>${coverManagementHTML(x, 'customCover')}${contentControls}</div></div></details>`;
  }

  const CATALOG_SCORE_FIELDS = [
    ['Overall', 'overall', 100],
    ['Production', 'production', 10],
    ['Story', 'story', 10],
    ['Emotion', 'emotional', 10],
  ];
  const CATALOG_CONTENT_FIELDS = [
    ['Sexual content', 'sex'],
    ['Nudity', 'nudity'],
    ['Violence', 'violence'],
    ['Gore', 'gore'],
    ['Disturbing', 'disturbing'],
  ];

  function catalogScoreFieldsHTML(scores = {}, prefix = 'catalogScore') {
    return `<div class="catalog-score-fields">${CATALOG_SCORE_FIELDS.map(([label, key, maximum]) => `<label>${esc(label)}<input id="${prefix}-${key}" type="number" min="1" max="${maximum}" step="1" value="${Number(scores[key]) || ''}" required><span>/${maximum}</span></label>`).join('')}</div>`;
  }

  function catalogContentFieldsHTML(content = {}, prefix = 'catalogContent') {
    const normalized = normalizedContent(content);
    return `<label class="field-label">CONTENT LABELS<input id="${prefix}-tags" type="text" maxlength="500" value="${esc(normalized.tags.join(', '))}" placeholder="Family, Adventure, …"></label>${adultCatalogToggleHTML(normalized, `${prefix}-adult`)}<div class="custom-content-fields">${CATALOG_CONTENT_FIELDS.map(([label, key]) => `<label>${esc(label)}<input id="${prefix}-${key}" type="number" min="0" max="5" step="1" value="${normalized[key]}" required><span>/5</span></label>`).join('')}</div>`;
  }
  function coverSourceFieldsHTML(source, prefix) {
    const status = source?.status ? ` // ${source.status.toUpperCase()}` : '';
    return `<div class="cover-source-field"><label class="field-label">COVER LINK${status}<input id="${prefix}-url" type="url" inputmode="url" maxlength="2000" placeholder="https://…/cover.jpg" value="${esc(source?.url || '')}"></label><button id="${prefix}-fetch" class="slash-button small" type="button">SAVE COVER</button><small>The source and its verified/dead state travel with exports.</small></div>`;
  }
  function coverManagementHTML(x, prefix) {
    const cover = meta[x.id]?.data?.cover || meta[x.id]?.data?.image || '';
    const sourceControl = cover ? '' : coverSourceFieldsHTML(coverSourceFor(x), prefix);
    const wrongLabel = coverSourceFor(x)?.status === 'wrong' ? 'COVER MARKED WRONG' : 'MARK COVER WRONG';
    return `${sourceControl}${cover ? `<div class="cover-management-actions"><button id="${prefix}-download" class="slash-button small" type="button">DOWNLOAD COVER</button><button id="${prefix}-wrong" class="cover-wrong-button" type="button">${wrongLabel}</button></div>` : ''}`;
  }

  function adultCatalogToggleHTML(content, id) {
    return `<label class="adult-catalog-toggle" for="${id}"><input id="${id}" type="checkbox" ${isAdultCatalogTitle(content) ? 'checked' : ''}><span aria-hidden="true"></span><b>PROMOTE TO MATURE CONTENT</b><small>Explicitly includes this title in the Mature Content section.</small></label>`;
  }
  function setNotForKidsLabel(content, excluded) {
    const tags = (content.tags || []).filter((tag) => norm(tag) !== norm(NOT_FOR_KIDS_LABEL));
    if (excluded) tags.push(NOT_FOR_KIDS_LABEL);
    return { ...content, tags };
  }
  function notForKidsToggleHTML(content, id) {
    return `<label class="kids-catalog-toggle" for="${id}"><input id="${id}" type="checkbox" ${hasNotForKidsOverride({ content }) ? 'checked' : ''}><span aria-hidden="true"></span><b>NOT FOR KIDS</b><small>Excludes this title from the For Kids section.</small></label>`;
  }

  function catalogCorrectionEditorHTML(x) {
    const pending = Boolean(catalogDrafts[x.id]);
    const contentControls = isForKidsCandidate(x)
      ? notForKidsToggleHTML(x.content, 'catalogContent-not-for-kids')
      : catalogContentFieldsHTML(x.content);
    return `<details class="catalog-editor optional-editor ${pending ? 'has-draft' : ''}"><summary class="catalog-editor-head optional-editor-summary"><div><span>CURATED DATA</span><h4>Edit catalog ratings</h4></div><b>${pending ? 'DRAFT SAVED' : 'CATALOG VALUES'}</b><i class="optional-editor-chevron" aria-hidden="true"></i></summary><div class="optional-editor-body"><p>Changes can be saved to this installation or added to a correction package for review and sharing.</p>${catalogScoreFieldsHTML(x.scores)}${contentControls}${coverManagementHTML(x, 'catalogCover')}<div class="catalog-editor-actions"><button id="saveCatalogDraft" class="slash-button wide" type="button">SAVE TO REVIEW PACKAGE</button>${state.catalogWriteEnabled ? '<button id="applyCatalogDirect" class="slash-button hot wide" type="button">SAVE TO THIS INSTALLATION</button>' : ''}</div><div id="catalogEditorResult" class="import-result"></div></div></details>`;
  }

  function customPromotionHTML(x) {
    const pending = Boolean(catalogDrafts[x.id]);
    return `<details class="catalog-editor optional-editor promotion-editor ${pending ? 'has-draft' : ''}"><summary class="catalog-editor-head optional-editor-summary"><div><span>CATALOG CANDIDATE</span><h4>Promote custom title</h4></div><b>${pending ? 'READY FOR REVIEW' : 'QUALITY SCORES REQUIRED'}</b><i class="optional-editor-chevron" aria-hidden="true"></i></summary><div class="optional-editor-body"><p>All four quality scores and all five content ratings are required before a custom title can become part of the installation catalog.</p>${catalogScoreFieldsHTML(x.scores, 'promotionScore')}<div class="catalog-editor-actions"><button id="stageCustomPromotion" class="slash-button wide" type="button">ADD TO REVIEW PACKAGE</button>${state.catalogWriteEnabled ? '<button id="applyCustomDirect" class="slash-button hot wide" type="button">ADD TO THIS INSTALLATION</button>' : ''}</div><div id="promotionResult" class="import-result"></div></div></details>`;
  }

  function readCatalogScores(prefix) {
    return Object.fromEntries(
      CATALOG_SCORE_FIELDS.map(([, key, maximum]) => {
        const value = Number($(`#${prefix}-${key}`).value);
        if (!Number.isInteger(value) || value < 1 || value > maximum)
          throw new Error(`Complete every quality score from 1 to ${maximum}.`);
        return [key, value];
      }),
    );
  }

  function readCatalogContent(prefix) {
    const content = {};
    for (const [, key] of CATALOG_CONTENT_FIELDS) {
      const value = Number($(`#${prefix}-${key}`).value);
      if (!Number.isInteger(value) || value < 0 || value > 5)
        throw new Error('Content ratings must be whole numbers from 0 to 5.');
      content[key] = value;
    }
    content.tags = parseCustomTags($(`#${prefix}-tags`).value);
    return setNotForKidsLabel(
      setAdultCatalogTitle(content, $(`#${prefix}-adult`).checked),
      $(`#${prefix}-not-for-kids`).checked,
    );
  }
  function readCoverSource(prefix, fallback = '') {
    const input = $(`#${prefix}-url`);
    if (!input) return fallback;
    const url = input.value.trim();
    return url ? newCoverSource(url).url : '';
  }

  function catalogSnapshotForBrowser(item) {
    return {
      scores: Object.fromEntries(
        CATALOG_SCORE_FIELDS.map(([, key]) => [key, Number(item.scores?.[key]) || 0]),
      ),
      content: normalizedContent(item.content),
      coverSource: typeof item.coverSource === 'string' ? item.coverSource : '',
    };
  }

  function saveCatalogDraft(entry) {
    catalogDrafts[entry.id] = entry;
    save(STORE.catalogCorrections, catalogDrafts);
    renderCorrectionWorkspace();
  }

  function stageOfficialCorrection(x) {
    const official = masterById.get(x.id);
    if (!official) throw new Error('The official catalog title could not be found.');
    const entry = {
      operation: 'update',
      id: official.id,
      title: official.title,
      base: catalogSnapshotForBrowser(official),
      values: {
        scores: readCatalogScores('catalogScore'),
        content: isForKidsCandidate(official)
          ? setNotForKidsLabel(normalizedContent(official.content), $('#catalogContent-not-for-kids').checked)
          : readCatalogContent('catalogContent'),
        coverSource: readCoverSource('catalogCover', coverSourceFor(official)?.url || ''),
      },
    };
    if (JSON.stringify(entry.base) === JSON.stringify(entry.values))
      throw new Error('Change at least one rating before saving.');
    saveCatalogDraft(entry);
    return entry;
  }

  function stageCustomPromotion(x) {
    saveCustomMetadata(x);
    x.scores = readCatalogScores('promotionScore');
    save(STORE.custom, customTitles);
    const entry = {
      operation: 'add',
      id: x.id,
      title: x.title,
      base: null,
      values: {
        year: Number(x.year) || 0,
        type: x.type || 'Series',
        origin: x.origin || 'Unknown',
        api: ['anilist', 'tvmaze', 'wiki'].includes(x.api) ? x.api : 'none',
        lookupTitle: x.lookupTitle || x.title,
        externalId: String(x.externalId || ''),
        genres: x.genres || '',
        scores: { ...x.scores },
        content: normalizedContent(x.content),
        coverSource: coverSourceFor(x)?.url || '',
      },
    };
    saveCatalogDraft(entry);
    return entry;
  }

  function correctionCode(entries = Object.values(catalogDrafts)) {
    if (!entries.length) throw new Error('Add at least one correction first.');
    const payload = {
      format: 'ultimate-animation-index-corrections',
      schema: 1,
      createdAt: new Date().toISOString(),
      catalogVersion: Number(CAT.version) || 1,
      entries,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `UAIC.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
  }

  async function applyCorrectionEntries(entries, { keepForExport = false } = {}) {
    if (!state.catalogWriteEnabled || !state.catalogToken)
      throw new Error('Direct catalog saving is only available on the computer running the server.');
    const response = await fetch('/api/catalog/corrections/apply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UAI-Catalog-Token': state.catalogToken,
      },
      body: JSON.stringify({ code: correctionCode(entries) }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(humanCorrectionError(result.error));
    for (const entry of entries) {
      if (keepForExport) catalogDrafts[entry.id] = entry;
      else delete catalogDrafts[entry.id];
      if (entry.operation === 'add') customTitles = customTitles.filter((title) => title.id !== entry.id);
    }
    save(STORE.catalogCorrections, catalogDrafts);
    save(STORE.custom, customTitles);
    location.reload();
  }

  let reviewedCorrection = null;

  function humanCorrectionError(code) {
    const messages = {
      'invalid-correction-code': 'This is not a valid correction package.',
      'invalid-correction-package': 'The package contains missing, unsafe or out-of-range data.',
      'unsupported-correction-package': 'This correction package version is not supported.',
      'unknown-catalog-title': 'The package refers to a title that is not in this catalog.',
      'catalog-correction-conflict': 'The catalog has changed since this package was created.',
      'empty-correction-package': 'The package does not change any catalog values.',
      'catalog-write-forbidden': 'Direct saving is only available on the computer running the server.',
    };
    return messages[code] || 'The correction package could not be processed.';
  }

  function correctionFieldLabel(group, key) {
    const labels = {
      overall: 'Overall',
      production: 'Production',
      story: 'Story',
      emotional: 'Emotion',
      sex: 'Sexual content',
      nudity: 'Nudity',
      violence: 'Violence',
      gore: 'Gore',
      disturbing: 'Disturbing content',
      tags: 'Content labels',
    };
    return labels[key] || `${group} ${key}`;
  }

  function correctionValue(value) {
    return Array.isArray(value) ? value.join(', ') || 'None' : String(value);
  }

  function correctionChangesHTML(entry) {
    if (entry.operation === 'add')
      return `<article class="correction-review-entry addition"><header><span>NEW CATALOG TITLE</span><h4>${esc(entry.title)}</h4></header><div class="correction-new-meta"><span>${esc(entry.values.type)}</span><span>${entry.values.year || 'YEAR UNKNOWN'}</span><span>${esc(entry.values.origin)}</span></div><div class="correction-diff-labels"><span>FIELD</span><span>BEFORE</span><i>AFTER</i></div>${Object.entries(
        entry.values.scores,
      )
        .map(
          ([key, value]) =>
            `<div class="correction-diff"><b>${esc(correctionFieldLabel('scores', key))}</b><span>NOT IN CATALOG</span><i>${esc(value)}</i></div>`,
        )
        .join('')}${Object.entries(entry.values.content)
        .map(
          ([key, value]) =>
            `<div class="correction-diff"><b>${esc(correctionFieldLabel('content', key))}</b><span>NOT IN CATALOG</span><i>${esc(correctionValue(value))}</i></div>`,
        )
        .join('')}</article>`;
    const changes = [];
    for (const group of ['scores', 'content']) {
      for (const [key, next] of Object.entries(entry.values[group])) {
        const before = entry.base[group][key];
        if (JSON.stringify(before) === JSON.stringify(next)) continue;
        changes.push(
          `<div class="correction-diff"><b>${esc(correctionFieldLabel(group, key))}</b><span>${esc(correctionValue(before))}</span><i>${esc(correctionValue(next))}</i></div>`,
        );
      }
    }
    return `<article class="correction-review-entry"><header><span>RATING CORRECTION</span><h4>${esc(entry.title)}</h4></header><div class="correction-diff-labels"><span>FIELD</span><span>BEFORE</span><i>AFTER</i></div>${changes.join('')}</article>`;
  }

  function renderCorrectionWorkspace() {
    const summary = $('#correctionDraftSummary');
    if (!summary) return;
    const entries = Object.values(catalogDrafts);
    const additions = entries.filter((entry) => entry.operation === 'add').length;
    summary.innerHTML = `<span><b>${entries.length}</b><small>TOTAL DRAFTS</small></span><span><b>${entries.length - additions}</b><small>RATING EDITS</small></span><span><b>${additions}</b><small>NEW TITLES</small></span>`;
    $('#correctionDraftList').innerHTML = entries.length
      ? entries
          .map(
            (entry) =>
              `<div class="correction-draft"><div><b>${esc(entry.title)}</b><span>${entry.operation === 'add' ? 'NEW CATALOG TITLE' : 'RATING CORRECTION'}</span></div><button type="button" data-remove-correction="${esc(entry.id)}">REMOVE</button></div>`,
          )
          .join('')
      : '<div class="empty-state">Edit a catalog title to begin a review package.</div>';
    $$('[data-remove-correction]', $('#correctionDraftList')).forEach((button) =>
      button.addEventListener('click', () => {
        delete catalogDrafts[button.dataset.removeCorrection];
        save(STORE.catalogCorrections, catalogDrafts);
        renderCorrectionWorkspace();
        renderAll();
      }),
    );
    $('#generateCorrectionCode').disabled = !entries.length;
    $('#clearCorrectionDrafts').disabled = !entries.length;
    const apply = $('#applyReviewedCorrections');
    if (apply) {
      apply.disabled = !reviewedCorrection || !state.catalogWriteEnabled;
      apply.dataset.tooltip = state.catalogWriteEnabled
        ? 'Apply the validated package to this installation'
        : 'Open the site on the computer running the server to apply changes';
      apply.removeAttribute('title');
    }
  }

  function generateCorrectionPackage() {
    try {
      $('#correctionExportCode').value = correctionCode();
      toast('Correction review package generated');
    } catch (error) {
      toast(error.message);
    }
  }

  async function previewCorrectionPackage() {
    const code = $('#correctionImportCode').value.trim();
    const result = $('#correctionImportResult');
    const mount = $('#correctionReviewResult');
    reviewedCorrection = null;
    result.className = 'import-result';
    result.textContent = '';
    $('#applyReviewedCorrections').disabled = true;
    if (!code) {
      result.classList.add('bad');
      result.textContent = 'Paste a correction package first.';
      return;
    }
    mount.classList.add('loading');
    mount.innerHTML = '<div class="empty-state">Validating every proposed catalog value…</div>';
    try {
      const response = await fetch('/api/catalog/corrections/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'invalid-correction-package');
      reviewedCorrection = data.correction;
      mount.classList.remove('loading');
      mount.innerHTML = `<div class="correction-review-head"><b>VALID PACKAGE</b><span>${data.correction.entries.length} proposed change${data.correction.entries.length === 1 ? '' : 's'} · created ${esc(data.correction.createdAt.slice(0, 10))}</span></div>${data.correction.entries.map(correctionChangesHTML).join('')}`;
      result.classList.add('good');
      result.textContent = 'Nothing has been written. Review every change before applying.';
      renderCorrectionWorkspace();
    } catch (error) {
      mount.classList.remove('loading');
      mount.innerHTML =
        '<div class="empty-state">The package was rejected before any data was changed.</div>';
      result.classList.add('bad');
      result.textContent = humanCorrectionError(error.message);
    }
  }

  async function applyReviewedCorrectionPackage() {
    if (!reviewedCorrection) return;
    const button = $('#applyReviewedCorrections');
    const result = $('#correctionImportResult');
    button.disabled = true;
    button.textContent = 'VALIDATING + APPLYING…';
    try {
      await applyCorrectionEntries(reviewedCorrection.entries);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'APPLY TO THIS INSTALLATION';
      result.className = 'import-result bad';
      result.textContent = error.message;
    }
  }

  let selectedReleaseUpdatePackage = null;
  let reviewedReleaseUpdates = null;

  function releaseUpdateError(error) {
    const messages = {
      'invalid-release-update-package': 'This is not a valid release-update package.',
      'unsupported-release-update-package': 'This release-update package version is not supported.',
      'release-update-add-missing-fields': 'A new title is missing required catalog information.',
      'unreleased-editorial-update':
        'Editorial quality or content ratings cannot be imported before release.',
      'catalog-write-forbidden': 'Open the site on the computer running the server to apply changes.',
      'release-update-not-applicable':
        'A selected change is no longer applicable. Preview the package again.',
      'invalid-release-update-selection': 'Select at least one valid change.',
    };
    return messages[error] || 'The release-update package could not be processed.';
  }

  function releaseValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) return value.join(', ') || '—';
    if (typeof value === 'object')
      return Object.entries(value)
        .map(([key, next]) => `${key}: ${releaseValue(next)}`)
        .join(' · ');
    return String(value);
  }

  function releaseDiffHTML(changes = []) {
    const visible = changes.filter(
      (change) => !['id', 'rank', 'provisional', 'releaseSources'].includes(change.field),
    );
    if (!visible.length) return '<div class="release-update-no-diff">No catalog field changes.</div>';
    return `<div class="release-update-diffs">${visible.map((change) => `<div class="correction-diff"><b>${esc(change.field.replace(/([A-Z])/g, ' $1').toUpperCase())}</b><span>${esc(releaseValue(change.before))}</span><i>${esc(releaseValue(change.after))}</i></div>`).join('')}</div>`;
  }

  function releaseEntryHTML(entry) {
    const selectable = entry.state === 'valid';
    const checked = selectable ? 'checked' : '';
    const state = entry.state.toUpperCase();
    const matchText = entry.matches?.length
      ? entry.matches.map((match) => `${match.title}${match.year ? ` (${match.year})` : ''}`).join(' · ')
      : 'New catalog title';
    return `<article class="release-update-entry ${esc(entry.state)}"><header><label><input type="checkbox" data-release-update-id="${esc(entry.updateId)}" ${checked} ${selectable ? '' : 'disabled'}><span class="release-update-state">${esc(state)}</span></label><div><h4>${esc(entry.patch.title || entry.match.title)}</h4><small>${esc(entry.action === 'add' ? 'NEW TITLE' : 'EXISTING TITLE')} · ${esc(matchText)}</small></div><b>${esc(entry.release.status.toUpperCase())}</b></header><div class="release-update-meta"><span>${esc(entry.release.date || 'TBA')}</span><span>${esc(entry.reasons.join(' · '))}</span><span>${entry.sources.length} SOURCE${entry.sources.length === 1 ? '' : 'S'}</span>${entry.audience.mature === true ? '<span>MATURE</span>' : ''}${entry.audience.forKids === true ? '<span>FOR KIDS</span>' : ''}</div>${entry.state === 'conflict' ? `<div class="release-update-conflict">Multiple possible matches: ${esc(matchText)}. Resolve this in a future package; it will not be applied.</div>` : releaseDiffHTML(entry.changes)}</article>`;
  }

  function renderReleaseUpdateHistory() {
    const mount = $('#releaseUpdateHistory');
    if (!mount) return;
    const history = Array.isArray(releaseUpdateHistory) ? releaseUpdateHistory.slice(0, 12) : [];
    mount.innerHTML = history.length
      ? history
          .map(
            (entry) =>
              `<div><b>${esc(String(entry.generatedAt || '').slice(0, 10))}</b><span>${esc(entry.packageId || '')}</span><small>${Number(entry.added) || 0} added · ${Number(entry.updated) || 0} updated · ${Number(entry.skipped) || 0} skipped</small></div>`,
          )
          .join('')
      : '<div class="empty-state">No release-update package has been applied locally.</div>';
    $('#clearReleaseUpdateHistory').disabled = !history.length;
  }

  function renderReleaseUpdatePreview() {
    const mount = $('#releaseUpdatePreview');
    const summary = $('#releaseUpdateSummary');
    const apply = $('#applySelectedReleaseUpdates');
    if (!reviewedReleaseUpdates) {
      mount.innerHTML = '<div class="empty-state">Select a package, then preview it before applying.</div>';
      summary.innerHTML = '';
      apply.disabled = true;
      return;
    }
    const counts = reviewedReleaseUpdates.summary;
    summary.innerHTML = [
      ['NEW TITLES', counts.newTitles],
      ['DATE CHANGES', counts.dateChanges],
      ['BECAME RELEASED', counts.becameReleased],
      ['METADATA', counts.metadataUpdates],
      ['QUALITY', counts.qualityUpdates],
      ['CONTENT', counts.contentUpdates],
      ['MATURE', counts.mature],
      ['FOR KIDS', counts.forKids],
      ['CONFLICTS', counts.conflicts],
      ['NO-OPS', counts.noops],
    ]
      .map(([label, value]) => `<span><b>${value}</b><small>${label}</small></span>`)
      .join('');
    mount.innerHTML = reviewedReleaseUpdates.entries.map(releaseEntryHTML).join('');
    $$('[data-release-update-id]', mount).forEach((input) =>
      input.addEventListener('change', syncReleaseUpdateApply),
    );
    syncReleaseUpdateApply();
  }

  function selectedReleaseUpdateIds() {
    return $$('[data-release-update-id]:checked', $('#releaseUpdatePreview')).map(
      (input) => input.dataset.releaseUpdateId,
    );
  }

  function syncReleaseUpdateApply() {
    const apply = $('#applySelectedReleaseUpdates');
    const selected = selectedReleaseUpdateIds();
    apply.disabled = !selected.length || !state.catalogWriteEnabled;
    apply.dataset.tooltip = state.catalogWriteEnabled
      ? 'Apply selected catalog changes atomically'
      : 'Open the site on the computer running the server to apply changes';
  }

  async function selectReleaseUpdateFile() {
    const file = $('#releaseUpdateFile').files?.[0];
    const summary = $('#releaseUpdateFileSummary');
    selectedReleaseUpdatePackage = null;
    reviewedReleaseUpdates = null;
    $('#previewReleaseUpdates').disabled = true;
    $('#clearReleaseUpdates').disabled = !file;
    $('#releaseUpdateResult').className = 'import-result';
    $('#releaseUpdateResult').textContent = '';
    if (!file) {
      summary.innerHTML =
        '<b>NO PACKAGE SELECTED</b><span>Choose a version 1 release-update JSON file to begin.</span>';
      renderReleaseUpdatePreview();
      return;
    }
    summary.innerHTML =
      '<b>READING PACKAGE</b><span>Nothing will be changed until preview and explicit apply.</span>';
    try {
      if (file.size > 1024 * 1024) throw new Error('invalid-release-update-package');
      selectedReleaseUpdatePackage = JSON.parse(await file.text());
      const generated = String(selectedReleaseUpdatePackage.generatedAt || '').slice(0, 10) || 'unknown date';
      const total = Array.isArray(selectedReleaseUpdatePackage.entries)
        ? selectedReleaseUpdatePackage.entries.length
        : 0;
      summary.innerHTML = `<b>PACKAGE READY // ${esc(generated)}</b><span>${esc(selectedReleaseUpdatePackage.packageId || 'Unvalidated package')} · ${total} proposed changes</span>`;
      $('#previewReleaseUpdates').disabled = false;
    } catch (error) {
      summary.innerHTML =
        '<b>PACKAGE REJECTED</b><span>The selected file is not valid JSON or exceeds 1 MB.</span>';
      $('#releaseUpdateResult').className = 'import-result bad';
      $('#releaseUpdateResult').textContent = releaseUpdateError(error.message);
    }
    renderReleaseUpdatePreview();
  }

  async function previewReleaseUpdates() {
    const result = $('#releaseUpdateResult');
    if (!selectedReleaseUpdatePackage) return;
    $('#previewReleaseUpdates').disabled = true;
    $('#previewReleaseUpdates').textContent = 'VALIDATING…';
    result.className = 'import-result';
    result.textContent = '';
    try {
      const response = await fetch('/api/catalog/release-updates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: selectedReleaseUpdatePackage }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'invalid-release-update-package');
      reviewedReleaseUpdates = data.preview;
      result.className = 'import-result good';
      result.textContent = 'Validated. Nothing has been written; select the changes to apply.';
    } catch (error) {
      reviewedReleaseUpdates = null;
      result.className = 'import-result bad';
      result.textContent = releaseUpdateError(error.message);
    } finally {
      $('#previewReleaseUpdates').disabled = !selectedReleaseUpdatePackage;
      $('#previewReleaseUpdates').textContent = 'PREVIEW';
      renderReleaseUpdatePreview();
    }
  }

  async function applySelectedReleaseUpdates() {
    const selectedUpdateIds = selectedReleaseUpdateIds();
    if (!reviewedReleaseUpdates || !selectedUpdateIds.length) return;
    const button = $('#applySelectedReleaseUpdates');
    const result = $('#releaseUpdateResult');
    button.disabled = true;
    button.textContent = 'APPLYING…';
    try {
      const response = await fetch('/api/catalog/release-updates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-UAI-Catalog-Token': state.catalogToken },
        body: JSON.stringify({ package: selectedReleaseUpdatePackage, selectedUpdateIds }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'release-update-not-applicable');
      const applied = data.applied || [];
      releaseUpdateHistory = [
        {
          packageId: reviewedReleaseUpdates.packageId,
          generatedAt: reviewedReleaseUpdates.generatedAt,
          appliedAt: new Date().toISOString(),
          added: applied.filter((entry) => entry.action === 'add').length,
          updated: applied.filter((entry) => entry.action === 'update').length,
          skipped: reviewedReleaseUpdates.entries.length - applied.length,
        },
        ...(Array.isArray(releaseUpdateHistory) ? releaseUpdateHistory : []),
      ].slice(0, 12);
      save(STORE.releaseUpdateHistory, releaseUpdateHistory);
      result.className = 'import-result good';
      result.textContent = `${formatCount(applied.length)} change${applied.length === 1 ? '' : 's'} applied atomically.${data.unranked ? ` ${formatCount(data.unranked)} title${data.unranked === 1 ? '' : 's'} still require a global rank.` : ''}`;
      renderReleaseUpdateHistory();
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      result.className = 'import-result bad';
      result.textContent = releaseUpdateError(error.message);
      button.disabled = false;
      button.textContent = 'APPLY SELECTED';
    }
  }

  function clearReleaseUpdateSelection() {
    $('#releaseUpdateFile').value = '';
    selectedReleaseUpdatePackage = null;
    reviewedReleaseUpdates = null;
    $('#clearReleaseUpdates').disabled = true;
    $('#previewReleaseUpdates').disabled = true;
    $('#releaseUpdateFileSummary').innerHTML =
      '<b>NO PACKAGE SELECTED</b><span>Choose a version 1 release-update JSON file to begin.</span>';
    $('#releaseUpdateResult').className = 'import-result';
    $('#releaseUpdateResult').textContent = '';
    renderReleaseUpdatePreview();
  }

  function hasUnsafeText(value) {
    return /[<>\u0000-\u001f\u007f]/.test(value);
  }

  function parseCustomTags(raw) {
    const tags = [];
    const seen = new Set();
    for (const part of String(raw).split(',')) {
      const tag = part.trim();
      if (!tag) continue;
      if (tag.length > 40 || hasUnsafeText(tag))
        throw new Error('Each content label must be 40 safe characters or fewer.');
      const key = tag.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    }
    if (tags.length > 20) throw new Error('Use no more than 20 content labels.');
    return tags;
  }

  function saveCustomMetadata(x) {
    const title = $('#customTitle').value.trim();
    const year = Number($('#customYear').value) || 0;
    const type = $('#customType').value;
    const origin = $('#customOrigin').value.trim() || 'Unknown';
    const genres = $('#customGenres').value.trim();
    const lookupChanged =
      norm(title) !== norm(x.lookupTitle || x.title) || type !== x.type || norm(origin) !== norm(x.origin);
    if (!title || title.length > 180 || hasUnsafeText(title)) throw new Error('Enter a valid title.');
    if (!Number.isInteger(year) || year < 0 || year > 2200) throw new Error('Enter a valid year.');
    if (origin.length > 80 || hasUnsafeText(origin)) throw new Error('Enter a valid origin.');
    if (genres.length > 500 || hasUnsafeText(genres))
      throw new Error('Genres and tags must be 500 safe characters or fewer.');
    const duplicate = findEquivalent(
      { title, year, type },
      canonicalItems().filter((item) => item.id !== x.id),
    );
    if (duplicate) throw new Error(`This matches the existing title “${duplicate.title}”.`);
    const level = (key) => {
      const value = Number($(`#customContent-${key}`).value);
      if (!Number.isInteger(value) || value < 0 || value > 5)
        throw new Error('Content ratings must be whole numbers from 0 to 5.');
      return value;
    };
    x.title = title;
    x.year = year;
    x.type = type;
    x.origin = origin;
    x.genres = genres;
    x.lookupTitle = title;
    if (lookupChanged) {
      x.api = customMetadataKinds(type, origin)[0];
      x.externalId = '';
      delete meta[x.id];
      save(STORE.meta, meta);
    }
    if (isForKidsCandidate(x)) {
      x.content = setNotForKidsLabel(x.content, $('#customNotForKids').checked);
    } else {
      x.content = setNotForKidsLabel(
        setAdultCatalogTitle(
          {
            sex: level('sex'),
            nudity: level('nudity'),
            violence: level('violence'),
            gore: level('gore'),
            disturbing: level('disturbing'),
            tags: parseCustomTags($('#customContentTags').value),
          },
          $('#customAdult').checked,
        ),
        $('#customNotForKids').checked,
      );
    }
    x.contentEstimated = false;
    const coverInput = $('#customCover-url');
    if (coverInput) {
      const coverUrl = coverInput.value.trim();
      if (coverUrl) {
        const previous = coverSourceFor(x);
        x.coverSource = newCoverSource(
          coverUrl,
          previous?.url === coverUrl ? previous.status : 'pending',
          previous?.url === coverUrl ? previous.checkedAt : '',
        );
      } else delete x.coverSource;
    }
    save(STORE.custom, customTitles);
    return lookupChanged;
  }

  function removeCustomTitle(x) {
    if (!x?.custom) return;
    const group = cachedSeriesGroup(x);
    for (const entry of group?.entries || []) delete episodeProgress[episodeKey(entry)];
    delete seriesGroups[x.id];
    customTitles = customTitles.filter((title) => title.id !== x.id);
    delete progress[x.id];
    delete myOpinions[x.id];
    delete favorites[x.id];
    delete meta[x.id];
    delete catalogDrafts[x.id];
    metaQueued.delete(x.id);
    for (let index = metaQueue.length - 1; index >= 0; index--) {
      if (metaQueue[index]?.id === x.id) metaQueue.splice(index, 1);
    }
    for (const source of Object.values(sources)) {
      if (source.opinions) delete source.opinions[x.id];
      if (Array.isArray(source.titleIds)) source.titleIds = source.titleIds.filter((id) => id !== x.id);
    }
    save(STORE.custom, customTitles);
    save(STORE.progress, progress);
    save(STORE.opinions, myOpinions);
    save(STORE.favorites, favorites);
    save(STORE.meta, meta);
    save(STORE.sources, sources);
    save(STORE.episodes, episodeProgress);
    save(STORE.series, seriesGroups);
    save(STORE.catalogCorrections, catalogDrafts);
    populateFilters();
    $('#detailDialog').close();
    renderAll();
    toast(`Removed “${x.title}”`);
  }

  // Detail dialog and personal progress
  function ratingEditorHTML(value, format = state.ratingFormat) {
    const rating = Number(value) || 0;
    if (format === 'ten')
      return `<input id="modalRating" type="number" min="0" max="10" step="0.5" value="${rating || ''}" placeholder="Unrated" aria-label="Personal rating out of 10">`;
    if (format === 'stars')
      return `<div id="modalRating" class="star-rating-picker" role="radiogroup" aria-label="Personal star rating">${Array.from(
        { length: 5 },
        (_, index) => {
          const fullValue = (index + 1) * 2;
          const state = rating >= fullValue ? 'is-full' : rating === fullValue - 1 ? 'is-half' : '';
          return `<span class="star-rating-unit ${state}"><span class="star-rating-glyph" aria-hidden="true">★</span><button type="button" class="star-rating-half star-rating-half-left" data-star-value="${fullValue - 1}" aria-label="${(fullValue - 1) / 2} stars" data-tooltip="${(fullValue - 1) / 2} stars"></button><button type="button" class="star-rating-half star-rating-half-right" data-star-value="${fullValue}" aria-label="${fullValue / 2} stars" data-tooltip="${fullValue / 2} stars"></button></span>`;
        },
      ).join(
        '',
      )}<span class="star-rating-caption">${rating ? `<span class="star-rating-value">${rating / 2} / 5</span> STARS` : 'SELECT A RATING'}</span></div>`;
    const selectedTier = personalRatingTier(rating);
    return `<select id="modalRating" aria-label="Personal rating tier"><option value="">UNRATED</option>${personalTierOptions()
      .map(
        ({ tier, value: tierValue }) =>
          `<option value="${tierValue}" ${selectedTier === tier ? 'selected' : ''}>${tier}</option>`,
      )
      .join('')}</select>`;
  }

  function ratingScaleHelp(format = state.ratingFormat) {
    return format === 'ten'
      ? 'Rate this title privately from 0 to 10. Half-points are allowed; leave it blank if you do not want to rate it.'
      : format === 'stars'
        ? 'Choose from 0.5 to 5 stars in half-star steps. Your star rating is private and works with personal sorting.'
        : 'Choose a private letter rating from F to S. The 10 equal steps are F, E, D, C, C+, B, B+, A, A+ and S.';
  }

  function openDetail(id) {
    const x = itemById(id);
    if (!x || x.catalogSummary) {
      // Cards deliberately carry a compact record.  Open a lightweight detail
      // shell first, then replace it with the complete local record as soon as
      // it arrives.  A click must always give immediate visual feedback.
      if (x?.catalogSummary) {
        const dialog = $('#detailDialog');
        const quality = qualityRatingLabel(x.tier, state.ratingFormat, {
          suffix: state.ratingFormat === 'ten',
        });
        $('#dialogBody').dataset.itemId = id;
        $('#dialogBody').innerHTML =
          `<div class="detail-hero"><div class="detail-heading"><div class="kicker">${x.rank ? `MASTER RANK #${formatRank(x.rank)}` : 'CUSTOM ADDITION'} // ${esc(quality)}</div><h2>${esc(x.title)}</h2></div></div><div class="detail-content detail-loading-preview"><div class="detail-facts"><span class="fact">${esc(displayType(x))}</span><span class="fact">${esc(liveYear(x))}</span><span class="fact">${esc(x.origin || '')}</span></div><p class="metadata-wait">Loading title details…</p></div>`;
        dialog.classList.toggle('kids-detail', isForKids(x));
        dialog.classList.toggle('for-kids-detail', isForKids(x));
        if (!dialog.open) dialog.showModal();
      }
      if (catalogBootstrap)
        void loadCatalogTitle(id).then((loaded) => {
          if (loaded) openDetail(id);
        });
      return;
    }
    $('#detailDialog').classList.toggle('kids-detail', isForKids(x));
    const rawMeta = meta[id]?.data || {},
      // A small number of checkpoint records carry an editorial source synopsis
      // while provider metadata has not been fetched yet. Prefer provider text,
      // but never hide the verified checkpoint text in the interim.
      m = { ...rawMeta, description: rawMeta.description || x.sourceSynopsis || '' },
      p = pFor(id),
      verdict = ownVerdict(id),
      ops = sourceOpinions(id),
      bg = m.banner || m.cover || m.image || '';
    // Catalog evidence remains useful before or without a provider lookup.
    // Metadata links take priority because they are title-specific live sources.
    if (!m.siteUrl) m.siteUrl = safeAwardSourceUrl({ sourceUrl: x.sourceUrl });
    const sc = x.scores || {};
    const quality = qualityRatingLabel(x.tier, state.ratingFormat, {
      suffix: state.ratingFormat === 'ten',
    });
    const facts = [
      { value: x.rank ? `#${formatRank(x.rank)}` : 'CUSTOM' },
      { value: quality },
      { value: displayType(x) },
      { value: liveYear(x) },
      { value: x.origin },
      { value: m.studio },
      { value: sc.overall ? `Overall ${sc.overall}` : '' },
    ].filter((fact) => fact.value);
    const aliases = [...new Set((x.aliases || []).filter((alias) => alias && alias !== x.title))];
    const kidSafeDetail = isForKids(x);
    $('#dialogBody').innerHTML =
      `<div class="detail-hero">${bg ? `<img class="detail-bg" src="${esc(bg)}" alt="">` : ''}<div class="detail-heading"><div class="kicker">${x.rank ? `MASTER RANK #${formatRank(x.rank)}` : 'CUSTOM ADDITION'} // ${esc(quality)}</div><h2>${esc(x.title)}</h2></div></div><div class="detail-content"><div class="detail-facts">${facts.map((fact) => `<span class="fact">${esc(fact.value)}</span>`).join('')}</div>${aliases.length ? `<p class="detail-aliases"><b>Also known as:</b> ${aliases.map(esc).join(', ')}</p>` : ''}<div class="detail-grid"><div>${m.description ? `<h4>Synopsis</h4><p>${esc(m.description)}</p>` : '<p class="metadata-wait">Synopsis will appear when metadata is available.</p>'}${x.watch_note ? `<div class="callout"><h4>Watch note</h4><p>${esc(x.watch_note)}</p></div>` : ''}${x.caveat ? `<div class="callout"><h4>Worth knowing</h4><p>${esc(x.caveat)}</p></div>` : ''}${m.siteUrl ? `<a class="external-link" href="${esc(m.siteUrl)}" target="_blank" rel="noopener">OPEN SOURCE ↗</a>` : ''}${awardSectionHTML(x)}${kidSafeDetail ? '' : `<h4>Content</h4>${contentGuide(x, false)}`}${x.custom ? `${customEditorHTML(x)}${customPromotionHTML(x)}` : catalogCorrectionEditorHTML(x)}${hasWatchTracker(x) ? `<div id="episodeTrackerMount" class="episode-tracker-mount" data-episode-owner="${esc(x.id)}" data-episode-variant="detail"></div>` : ''}${ops.length ? `<h4>Imported opinions</h4><div class="source-opinion-list">${ops.map((o) => `<div class="source-opinion"><b>${esc(o.label)}</b><span class="${o.verdict === 'recommend' ? 'yes' : 'no'}">${o.verdict === 'recommend' ? 'RECOMMENDED' : 'NOT RECOMMENDED'}</span></div>`).join('')}</div>` : ''}</div><aside aria-label="Personal title settings"><div class="user-edit"><button id="modalFavorite" class="favorite-detail ${isFavorite(id) ? 'active' : ''}" type="button">${isFavorite(id) ? '♥ FAVORITE' : '♡ ADD TO FAVORITES'}</button><div class="user-edit-label" id="recommendationLabel">MY RECOMMENDATION</div><div class="verdict-row" role="group" aria-labelledby="recommendationLabel"><button class="verdict-btn rec ${verdict === 'recommend' ? 'active' : ''}" data-v="recommend" type="button">RECOMMEND</button><button class="verdict-btn no ${verdict === 'avoid' ? 'active' : ''}" data-v="avoid" type="button">DON'T RECOMMEND</button><button class="verdict-btn neutral ${!verdict ? 'active' : ''}" data-v="" type="button">NEUTRAL</button></div><label for="modalStatus">WATCH STATUS</label><select id="modalStatus">${['Not started', 'Watching', 'Completed', 'On hold', 'Dropped'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><div class="rating-format-head"><span>MY RATING</span></div><div id="modalRatingEditor">${ratingEditorHTML(p.rating)}</div><small class="rating-scale-help" id="ratingScaleHelp">${esc(ratingScaleHelp())}</small><label for="modalNote">PRIVATE NOTE</label><textarea id="modalNote" maxlength="2000">${esc(p.note || '')}</textarea><button class="slash-button hot wide" id="saveDetail" type="button">${x.custom ? 'SAVE TITLE + LOCAL DATA' : 'SAVE LOCAL DATA'}</button>${x.custom ? '<button class="danger-button wide" id="removeCustomTitle" type="button">REMOVE CUSTOM TITLE</button>' : ''}</div></aside></div></div>`;
    const profile = curatedProfileHTML(x);
    if (profile) $('.detail-grid > div', $('#dialogBody'))?.insertAdjacentHTML('beforeend', profile);
    $('#dialogBody').dataset.itemId = id;
    $('#detailDialog').classList.toggle('for-kids-detail', kidSafeDetail);
    const insertFranchiseBanner = () => {
      if ($('#dialogBody').dataset.itemId !== id || $('.detail-franchise-links', $('#dialogBody'))) return;
      const franchiseBanner = franchiseBannerHTML(x);
      if (!franchiseBanner) return;
      $('.detail-facts', $('#dialogBody')).insertAdjacentHTML('afterend', franchiseBanner);
      $$('[data-open-franchise-id]', $('#dialogBody')).forEach((button) =>
        button.addEventListener('click', () => {
          $('#detailDialog').close();
          openFranchiseGuide(button.dataset.openFranchiseId);
        }),
      );
    };
    insertFranchiseBanner();
    $('#modalFavorite').onclick = () => {
      toggleFavorite(id);
      const b = $('#modalFavorite');
      b.classList.toggle('active', isFavorite(id));
      b.textContent = isFavorite(id) ? '♥ FAVORITE' : '♡ ADD TO FAVORITES';
    };
    let selectedVerdict = verdict;
    $$('.verdict-btn', $('#dialogBody')).forEach((b) =>
      b.addEventListener('click', () => {
        selectedVerdict = b.dataset.v;
        $$('.verdict-btn', $('#dialogBody')).forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      }),
    );
    let draftRating = Number(p.rating) || 0;
    const renderPersonalRating = () => {
      $('#modalRatingEditor').innerHTML = ratingEditorHTML(draftRating);
      $('#ratingScaleHelp').textContent = ratingScaleHelp();
      const updateDraftRating = (event) => {
        draftRating = Number(event.target.value) || 0;
      };
      const ratingInput = $('#modalRating');
      if (ratingInput instanceof HTMLInputElement || ratingInput instanceof HTMLSelectElement) {
        ratingInput.addEventListener('input', updateDraftRating);
        ratingInput.addEventListener('change', updateDraftRating);
      }
      $$('[data-star-value]', $('#modalRatingEditor')).forEach((button) =>
        button.addEventListener('click', () => {
          draftRating = Number(button.dataset.starValue) || 0;
          renderPersonalRating();
        }),
      );
    };
    renderPersonalRating();
    if (!x.custom) {
      bindCoverManagement(x, 'catalogCover');
      $('#saveCatalogDraft').onclick = () => {
        const result = $('#catalogEditorResult');
        result.className = 'import-result';
        try {
          stageOfficialCorrection(x);
          result.classList.add('good');
          result.textContent = 'Saved to the review package and applied to this browser view.';
          renderAll();
        } catch (error) {
          result.classList.add('bad');
          result.textContent = error.message;
        }
      };
      if ($('#applyCatalogDirect'))
        $('#applyCatalogDirect').onclick = async () => {
          const button = $('#applyCatalogDirect');
          const result = $('#catalogEditorResult');
          result.className = 'import-result';
          try {
            const entry = stageOfficialCorrection(x);
            button.disabled = true;
            button.textContent = 'VALIDATING + SAVING…';
            await applyCorrectionEntries([entry], { keepForExport: true });
          } catch (error) {
            button.disabled = false;
            button.textContent = 'SAVE TO THIS INSTALLATION';
            result.classList.add('bad');
            result.textContent = error.message;
          }
        };
    }
    if (x.custom) {
      bindCoverManagement(x, 'customCover');
      $('#refreshCustomMetadata').onclick = async () => {
        const button = $('#refreshCustomMetadata');
        button.disabled = true;
        button.textContent = 'SEARCHING…';
        const found = await refreshCustomMetadata(x, { force: true });
        if (found) {
          $('#detailDialog').close();
          openDetail(id);
        } else {
          button.disabled = false;
          button.textContent = 'FIND MISSING METADATA';
        }
      };
      let removeArmed = false;
      let removeTimer;
      $('#removeCustomTitle').onclick = () => {
        const button = $('#removeCustomTitle');
        if (removeArmed) {
          clearTimeout(removeTimer);
          removeCustomTitle(x);
          return;
        }
        removeArmed = true;
        button.classList.add('confirm');
        button.textContent = 'CONFIRM REMOVE TITLE';
        removeTimer = setTimeout(() => {
          removeArmed = false;
          button.classList.remove('confirm');
          button.textContent = 'REMOVE CUSTOM TITLE';
        }, 5000);
      };
      $('#stageCustomPromotion').onclick = () => {
        const result = $('#promotionResult');
        result.className = 'import-result';
        try {
          stageCustomPromotion(x);
          result.classList.add('good');
          result.textContent = 'The completed title is ready in the review package.';
        } catch (error) {
          result.classList.add('bad');
          result.textContent = error.message;
        }
      };
      if ($('#applyCustomDirect'))
        $('#applyCustomDirect').onclick = async () => {
          const button = $('#applyCustomDirect');
          const result = $('#promotionResult');
          result.className = 'import-result';
          try {
            const entry = stageCustomPromotion(x);
            button.disabled = true;
            button.textContent = 'VALIDATING + ADDING…';
            await applyCorrectionEntries([entry], { keepForExport: true });
          } catch (error) {
            button.disabled = false;
            button.textContent = 'ADD TO THIS INSTALLATION';
            result.classList.add('bad');
            result.textContent = error.message;
          }
        };
    }
    $('#saveDetail').onclick = () => {
      let metadataChanged = false;
      if (x.custom) {
        try {
          metadataChanged = saveCustomMetadata(x);
        } catch (error) {
          toast(error.message);
          return;
        }
      }
      if (!Number.isFinite(draftRating) || draftRating < 0 || draftRating > 10) {
        toast('Personal rating must be between 0 and 10');
        return;
      }
      progress[id] = {
        status: $('#modalStatus').value,
        rating: draftRating,
        note: $('#modalNote').value.trim(),
      };
      applyManualTitleStatusToEpisodes(
        cachedSeriesGroup(x) || (isFeatureFilm(x) ? featureFilmGroup(x) : null),
        progress[id].status,
      );
      if (selectedVerdict) myOpinions[id] = selectedVerdict;
      else delete myOpinions[id];
      save(STORE.progress, progress);
      save(STORE.opinions, myOpinions);
      $('#detailDialog').close();
      renderAll();
      toast('Saved locally');
      if (metadataChanged) refreshCustomMetadata(x, { force: true, silent: true });
    };
    if (!$('#detailDialog').open) $('#detailDialog').showModal();
    const episodeMount = $('#episodeTrackerMount');
    // Showing a detail dialog must never wait for episode/franchise rendering
    // or metadata work. Defer those potentially expensive operations until the
    // browser has painted the open dialog once.
    setTimeout(() => {
      if (!$('#detailDialog').open || $('#dialogBody').dataset.itemId !== id) return;
      syncNavigationUrl();
      if (episodeMount) {
        episodeMount.closest('.detail-grid')?.after(episodeMount);
        populateEpisodeMount(episodeMount, x, 'detail');
      }
      if (catalogBootstrap)
        void loadCatalogEntity('franchises').then(() => {
          if ($('#detailDialog').open) insertFranchiseBanner();
        });
      if (x.custom) refreshCustomMetadata(x, { silent: true });
      else queueMetadata([x], { priority: true });
    }, 80);
  }

  function metaFresh(id) {
    const cur = meta[id];
    if (!cur?.data || Date.now() - cur.ts >= META_TTL) return false;
    return Boolean(cur.data.cover) || Date.now() - cur.ts < MISSING_COVER_RETRY_TTL;
  }

  // Batched metadata loading keeps provider traffic bounded.
  function queueMetadata(items, { priority = false } = {}) {
    if (NO_META) return;
    const add = [];
    for (const x of items || []) {
      if (x?.custom) continue;
      if (!x?.id || !x.api || x.api === 'none' || metaFresh(x.id) || metaQueued.has(x.id)) continue;
      metaQueued.add(x.id);
      add.push(x);
    }
    if (priority) metaQueue.unshift(...add.reverse());
    else metaQueue.push(...add);
    if (state.server) pumpMetadata();
  }
  function scheduleMetaSave() {
    clearTimeout(metaSaveTimer);
    metaSaveTimer = setTimeout(() => save(STORE.meta, meta), 350);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function replaceBrokenCover(img, x) {
    const slot = img.closest('.cover');
    if (!slot) return;
    const ph = document.createElement('div');
    ph.className = 'cover-placeholder';
    ph.textContent = initials(x.title);
    img.replaceWith(ph);
  }
  function bindCoverErrors(root = document) {
    $$('.title-card img', root).forEach((img) => {
      if (img.dataset.errBound) return;
      img.dataset.errBound = '1';
      img.addEventListener(
        'error',
        () => {
          const x = itemById(img.closest('.title-card')?.dataset.id);
          if (x) replaceBrokenCover(img, x);
        },
        { once: true },
      );
    });
  }
  function refreshArtwork() {
    $$('.title-card').forEach((card) => {
      const x = itemById(card.dataset.id),
        m = meta[card.dataset.id]?.data || {},
        url = m.cover || m.image || '';
      if (!x || !url) return;
      const slot = card.querySelector('.cover'),
        img = slot?.querySelector('img'),
        ph = slot?.querySelector('.cover-placeholder');
      if (!slot) return;
      if (img) {
        if (img.src !== url) img.src = url;
      } else {
        const n = document.createElement('img');
        n.loading = 'lazy';
        n.alt = `${x.title} cover`;
        n.src = url;
        if (ph) ph.replaceWith(n);
        else slot.prepend(n);
      }
    });
    bindCoverErrors();
    updateHero();
    updateStats();
  }
  async function pumpMetadata() {
    if (metaPumping || !state.server || NO_META) return;
    metaPumping = true;
    try {
      while (metaQueue.length && state.server) {
        const chunk = [];
        while (metaQueue.length && chunk.length < META_BATCH_SIZE) {
          const x = metaQueue.shift();
          metaQueued.delete(x.id);
          if (!metaFresh(x.id) && x.api && x.api !== 'none') chunk.push(x);
        }
        if (!chunk.length) continue;
        try {
          const r = await fetch('/api/meta/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: chunk.map((x) => ({
                key: x.id,
                kind: x.api,
                title: x.lookupTitle || x.title,
                externalId: x.externalId || '',
              })),
            }),
          });
          const j = await r.json();
          if (r.ok && j.ok) {
            for (const row of j.results || []) {
              if (row?.data && itemById(row.key)) {
                meta[row.key] = { ts: Date.now(), data: row.data };
              }
            }
            scheduleMetaSave();
            refreshArtwork();
          }
        } catch {}
        if (metaQueue.length) await sleep(META_BATCH_DELAY);
      }
    } finally {
      metaPumping = false;
      if (metaQueue.length && state.server) setTimeout(pumpMetadata, META_BATCH_DELAY);
    }
  }
  function updateHero() {
    const x = masterItems[0];
    if (!x) return;
    const m = meta[x.id]?.data || {};
    const h = $('#heroFeature');
    h.innerHTML = `${m.banner || m.cover ? `<img class="hero-bg" src="${esc(m.banner || m.cover)}" alt="">` : ''}<div class="feature-rank">#001</div><div class="feature-lines"><span></span><span></span><span></span></div><div class="feature-title">${esc(x.title)}</div><div class="feature-sub">NO. 1 IN THE CURRENT RANKING.</div>`;
    if (m.banner || m.cover) h.classList.add('with-image');
  }

  // Navigation, global rendering and event wiring
  function switchTab(name, { history = 'push', scroll = true } = {}) {
    state.tab = name;
    ensureDestinationFilters(name);
    $$('.rail-tab').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `${name}Tab`));
    if (name === 'master' && catalogBootstrap) refreshCatalogDestination('master', renderMaster);
    else if (name === 'master') renderMaster();
    if (name === 'regions' && catalogBootstrap) refreshCatalogDestination('regions', renderWestern);
    else if (name === 'regions') renderWestern();
    if (name === 'adult' && catalogBootstrap) refreshCatalogDestination('mature', renderAdult);
    else if (name === 'adult') renderAdult();
    if (name === 'kids' && catalogBootstrap) refreshCatalogDestination('kids', renderKids);
    else if (name === 'kids') renderKids();
    if (name === 'collections' && catalogBootstrap)
      void loadCatalogEntity('collections').then(renderCollections);
    else if (name === 'collections') renderCollections();
    if (name === 'franchises' && catalogBootstrap)
      void loadCatalogEntity('franchises').then(renderFranchises);
    else if (name === 'franchises') renderFranchises();
    if (name === 'favorites' && catalogBootstrap) void loadFavoriteItems().then(renderFavorites);
    else if (name === 'favorites') renderFavorites();
    if (name === 'userlist') renderUserSummary();
    syncNavigationUrl({ history });
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function restoreExpandedFranchises(ids = []) {
    ids.filter(Boolean).forEach((id) => {
      const details = $(`details.franchise[data-franchise-id="${CSS.escape(id)}"]`, $('#franchiseStack'));
      if (details) details.open = true;
    });
  }
  function restoreOpenDialogs() {
    const detail = urlOpenDetailId && itemById(urlOpenDetailId);
    const collection = urlOpenCollectionId && CAT.collections.find((item) => item.id === urlOpenCollectionId);
    if (!detail && urlOpenDetailId && catalogBootstrap) {
      void loadCatalogTitle(urlOpenDetailId).then((loaded) => {
        if (loaded && urlOpenDetailId === loaded.id) restoreOpenDialogs();
      });
      return;
    }
    if (detail) {
      if ($('#collectionDialog').open) $('#collectionDialog').close();
      if (!$('#detailDialog').open || $('#dialogBody').dataset.itemId !== detail.id) openDetail(detail.id);
      return;
    }
    if (collection) {
      if ($('#detailDialog').open) $('#detailDialog').close();
      if (!$('#collectionDialog').open || $('#collectionDialog').dataset.collectionId !== collection.id)
        openCollection(collection.id);
      return;
    }
    if ($('#detailDialog').open) $('#detailDialog').close();
    if ($('#collectionDialog').open) $('#collectionDialog').close();
  }
  $('#franchiseStack').addEventListener(
    'toggle',
    (event) => {
      if (event.target.matches?.('details.franchise')) syncNavigationUrl();
    },
    true,
  );
  function renderAll({ expandedFranchiseIds = null } = {}) {
    const openFranchiseIds =
      expandedFranchiseIds ||
      $$('details.franchise[open]', $('#franchiseStack')).map((details) => details.dataset.franchiseId);
    renderMaster({ noMeta: true });
    if (state.tab === 'regions') renderWestern({ noMeta: true });
    if (state.tab === 'kids') renderKids({ noMeta: true });
    renderCollections();
    renderFranchises();
    if (state.tab === 'adult') renderAdult();
    if (state.tab === 'favorites') renderFavorites();
    renderUserSummary();
    restoreExpandedFranchises(openFranchiseIds);
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    if (typeof t.showPopover === 'function' && !t.matches(':popover-open')) t.showPopover();
    t.classList.add('show');
    clearTimeout(toast.t);
    clearTimeout(toast.hide);
    toast.t = setTimeout(() => {
      t.classList.remove('show');
      toast.hide = setTimeout(() => {
        if (typeof t.hidePopover === 'function' && t.matches(':popover-open')) t.hidePopover();
      }, 220);
    }, 2100);
  }
  function showRatingFormatOnboarding() {
    if (load(STORE.ratingFormatOnboardingSeen, false)) return;
    const dialog = $('#ratingFormatDialog');
    if (!dialog.open) dialog.showModal();
  }
  function chooseRatingFormat(format) {
    applyRatingFormat(format);
    save(STORE.ratingFormatOnboardingSeen, true);
    $('#ratingFormatDialog').close();
  }
  function applyRatingFormat(format) {
    state.ratingFormat = normalizeRatingFormat(format);
    state.visible = PAGE_SIZE;
    state.westernVisible = PAGE_SIZE;
    saveUIState();
    populateFilters();
    $('#ratingFormatSelect').value = state.ratingFormat;
    renderMaster();
    renderWestern();
    renderKids();
    renderFavorites();
    renderAdult();
  }
  const globalTooltip = document.createElement('div');
  globalTooltip.id = 'globalTooltip';
  globalTooltip.className = 'global-tooltip';
  globalTooltip.setAttribute('role', 'tooltip');
  globalTooltip.setAttribute('popover', 'manual');
  document.body.append(globalTooltip);

  function upgradeTooltip(target) {
    if (!(target instanceof Element) || !target.hasAttribute('title')) return;
    const message = target.getAttribute('title')?.trim();
    if (message && !target.dataset.tooltip) target.dataset.tooltip = message;
    target.removeAttribute('title');
  }
  function upgradeTooltips(root) {
    if (!(root instanceof Element) && root !== document) return;
    if (root instanceof Element) upgradeTooltip(root);
    root.querySelectorAll?.('[title]').forEach(upgradeTooltip);
  }
  upgradeTooltips(document);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') upgradeTooltip(record.target);
      else record.addedNodes.forEach(upgradeTooltips);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });

  function showGlobalTooltip(target) {
    const message = (target.dataset.tooltip || '').trim();
    if (!message) return;
    globalTooltip.textContent = message;
    if (typeof globalTooltip.showPopover === 'function' && !globalTooltip.matches(':popover-open'))
      globalTooltip.showPopover();
    globalTooltip.classList.add('show');
    const rect = target.getBoundingClientRect();
    const gap = 10;
    const width = globalTooltip.offsetWidth;
    const height = globalTooltip.offsetHeight;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2),
    );
    const top = rect.top - height - gap >= 12 ? rect.top - height - gap : rect.bottom + gap;
    globalTooltip.style.left = `${Math.round(left)}px`;
    globalTooltip.style.top = `${Math.round(top)}px`;
  }
  function hideGlobalTooltip() {
    globalTooltip.classList.remove('show');
    if (typeof globalTooltip.hidePopover === 'function' && globalTooltip.matches(':popover-open'))
      globalTooltip.hidePopover();
  }
  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest('[data-tooltip]');
    if (target) showGlobalTooltip(target);
  });
  document.addEventListener('pointerout', (event) => {
    const target = event.target.closest('[data-tooltip]');
    if (target && !target.contains(event.relatedTarget)) hideGlobalTooltip();
  });
  document.addEventListener('focusin', (event) => {
    const target = event.target.closest('[data-tooltip]');
    if (target) showGlobalTooltip(target);
  });
  document.addEventListener('focusout', hideGlobalTooltip);
  window.addEventListener('scroll', hideGlobalTooltip, { capture: true, passive: true });
  window.addEventListener('resize', hideGlobalTooltip);
  function randomPick() {
    const a = filteredMaster();
    if (!a.length) return toast('No titles match');
    openDetail(a[Math.floor(Math.random() * a.length)].id);
  }
  function topUnseen() {
    const x = masterItems.find((x) => pFor(x.id).status !== 'Completed');
    if (x) openDetail(x.id);
    else toast('You have completed every title in the list.');
  }

  function scheduleSearch(render, reset) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      reset();
      saveUIState();
      render();
    }, SEARCH_DEBOUNCE_MS);
  }

  // UI events
  $$('.rail-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  ['searchInput'].forEach((id) =>
    $('#' + id).addEventListener('input', () => {
      scheduleSearch(
        () => refreshCatalogDestination('master', renderMaster),
        () => (state.visible = PAGE_SIZE),
      );
    }),
  );
  ['kidsSearch'].forEach((id) =>
    $('#' + id).addEventListener('input', () => {
      scheduleSearch(
        () => refreshCatalogDestination('kids', renderKids),
        () => (state.kidsVisible = PAGE_SIZE),
      );
    }),
  );
  $('#westernSearch').addEventListener('input', () => {
    scheduleSearch(
      () => refreshCatalogDestination('regions', renderWestern),
      () => (state.westernVisible = PAGE_SIZE),
    );
  });
  [
    'tierFilter',
    'typeFilter',
    'genreFilter',
    'countryFilter',
    'statusFilter',
    'sortSelect',
    'hideCompleted',
    'customOnly',
  ].forEach((id) =>
    $('#' + id).addEventListener('change', () => {
      state.visible = PAGE_SIZE;
      saveUIState();
      refreshCatalogDestination('master', renderMaster);
    }),
  );
  $('#regionFilter').addEventListener('change', () => {
    state.visible = PAGE_SIZE;
    onRegionFilterChange('', () => {
      saveUIState();
      refreshCatalogDestination('master', renderMaster);
    });
  });
  $('#ratingFormatSelect').addEventListener('change', () => {
    applyRatingFormat($('#ratingFormatSelect').value);
  });
  $$('[data-onboarding-rating-format]').forEach((button) =>
    button.addEventListener('click', () => chooseRatingFormat(button.dataset.onboardingRatingFormat)),
  );
  $('#masterSortOrder').addEventListener('click', () => {
    state.masterSortOrder = state.masterSortOrder === 'desc' ? 'asc' : 'desc';
    renderSortOrderButton($('#masterSortOrder'), state.masterSortOrder);
    state.visible = PAGE_SIZE;
    saveUIState();
    refreshCatalogDestination('master', renderMaster);
  });
  [
    'westernTierFilter',
    'westernTypeFilter',
    'westernGenreFilter',
    'westernCountryFilter',
    'westernStatusFilter',
    'westernSort',
    'westernHideCompleted',
    'westernCustomOnly',
  ].forEach((id) =>
    $('#' + id).addEventListener('change', () => {
      state.westernVisible = PAGE_SIZE;
      saveUIState();
      refreshCatalogDestination('regions', renderWestern);
    }),
  );
  $('#westernRegionFilter').addEventListener('change', () => {
    state.westernVisible = PAGE_SIZE;
    onRegionFilterChange('western', () => {
      saveUIState();
      refreshCatalogDestination('regions', renderWestern);
    });
  });
  $('#westernSortOrder').addEventListener('click', () => {
    state.westernSortOrder = state.westernSortOrder === 'desc' ? 'asc' : 'desc';
    renderSortOrderButton($('#westernSortOrder'), state.westernSortOrder);
    state.westernVisible = PAGE_SIZE;
    saveUIState();
    refreshCatalogDestination('regions', renderWestern);
  });
  [
    'kidsTierFilter',
    'kidsTypeFilter',
    'kidsGenreFilter',
    'kidsCountryFilter',
    'kidsStatusFilter',
    'kidsSort',
    'kidsHideCompleted',
    'kidsCustomOnly',
  ].forEach((id) =>
    $('#' + id).addEventListener('change', () => {
      state.kidsVisible = PAGE_SIZE;
      saveUIState();
      refreshCatalogDestination('kids', renderKids);
    }),
  );
  $('#kidsRegionFilter').addEventListener('change', () => {
    state.kidsVisible = PAGE_SIZE;
    onRegionFilterChange('kids', () => {
      saveUIState();
      refreshCatalogDestination('kids', renderKids);
    });
  });
  $('#kidsSortOrder').addEventListener('click', () => {
    state.kidsSortOrder = state.kidsSortOrder === 'desc' ? 'asc' : 'desc';
    renderSortOrderButton($('#kidsSortOrder'), state.kidsSortOrder);
    state.kidsVisible = PAGE_SIZE;
    saveUIState();
    refreshCatalogDestination('kids', renderKids);
  });
  $('#adultSearch').addEventListener('input', () => {
    scheduleSearch(
      () => refreshCatalogDestination('mature', renderAdult),
      () => {},
    );
  });
  [
    'adultTierFilter',
    'adultTypeFilter',
    'adultGenreFilter',
    'adultCountryFilter',
    'adultStatusFilter',
  ].forEach((id) =>
    $('#' + id).addEventListener('change', () => {
      saveUIState();
      refreshCatalogDestination('mature', renderAdult);
    }),
  );
  $('#adultRegionFilter').addEventListener('change', () => {
    onRegionFilterChange('adult', () => {
      saveUIState();
      refreshCatalogDestination('mature', renderAdult);
    });
  });
  $('#adultSort').addEventListener('change', () => {
    saveUIState();
    refreshCatalogDestination('mature', renderAdult);
  });
  $('#adultSortOrder').addEventListener('click', () => {
    state.adultSortOrder = state.adultSortOrder === 'desc' ? 'asc' : 'desc';
    renderSortOrderButton($('#adultSortOrder'), state.adultSortOrder);
    saveUIState();
    refreshCatalogDestination('mature', renderAdult);
  });
  $('#loadMoreBtn').addEventListener('click', () => {
    state.visible += PAGE_SIZE;
    syncNavigationUrl();
    refreshCatalogDestination('master', renderMaster);
  });
  $('#westernLoadMoreBtn').addEventListener('click', () => {
    state.westernVisible += PAGE_SIZE;
    syncNavigationUrl();
    refreshCatalogDestination('regions', renderWestern);
  });
  $('#kidsLoadMoreBtn').addEventListener('click', () => {
    state.kidsVisible += PAGE_SIZE;
    syncNavigationUrl();
    refreshCatalogDestination('kids', renderKids);
  });
  $('#viewToggle').addEventListener('click', () => {
    state.compact = !state.compact;
    save(STORE.compact, state.compact);
    syncNavigationUrl();
    $('#viewToggle').textContent = state.compact ? '▤' : '▥';
    renderMaster();
  });
  $('#westernViewToggle').addEventListener('click', () => {
    state.westernCompact = !state.westernCompact;
    $('#westernViewToggle').textContent = state.westernCompact ? '▤' : '▥';
    saveUIState();
    renderWestern();
  });
  $('#kidsViewToggle').addEventListener('click', () => {
    state.kidsCompact = !state.kidsCompact;
    $('#kidsViewToggle').textContent = state.kidsCompact ? '▤' : '▥';
    saveUIState();
    renderKids();
  });
  $('#surpriseBtn').addEventListener('click', randomPick);
  $('#topUnseenBtn').addEventListener('click', topUnseen);
  $('#quickAddBtn').addEventListener('click', () => {
    switchTab('userlist');
    setTimeout(() => $('#addTitleName').focus(), 50);
  });
  $('#collectionSearch').addEventListener('input', () => {
    saveUIState();
    renderCollections();
  });
  $('#franchiseSearch').addEventListener('input', () => {
    saveUIState();
    renderFranchises();
  });
  $('#favoriteSearch').addEventListener('input', () => {
    scheduleSearch(renderFavorites, () => {});
  });
  $('#favoriteAwardFilter').addEventListener('change', () => {
    saveUIState();
    renderFavorites();
  });
  $('#favoriteCountryFilter').addEventListener('change', () => {
    saveUIState();
    renderFavorites();
  });
  $('#favoriteRegionFilter').addEventListener('change', () => {
    onRegionFilterChange('favorite', () => {
      saveUIState();
      renderFavorites();
    });
  });
  $('#favoriteSort').addEventListener('change', () => {
    saveUIState();
    renderFavorites();
  });
  $('#favoriteSortOrder').addEventListener('click', () => {
    state.favoriteSortOrder = state.favoriteSortOrder === 'desc' ? 'asc' : 'desc';
    renderSortOrderButton($('#favoriteSortOrder'), state.favoriteSortOrder);
    saveUIState();
    renderFavorites();
  });
  $$('.adult-chip').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.adult-chip').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.adult = b.dataset.adult;
      populateAdultFilters();
      saveUIState();
      refreshCatalogDestination('mature', renderAdult);
    }),
  );
  $('#generateCodeBtn').addEventListener('click', generateUserList);
  $('#copyCodeBtn').addEventListener('click', async () => {
    const v = $('#exportCode').value;
    if (!v) return toast('Generate a code first');
    try {
      await navigator.clipboard.writeText(v);
      toast('UserList code copied');
    } catch {
      $('#exportCode').select();
      document.execCommand('copy');
      toast('UserList code copied');
    }
  });
  $('#importCodeBtn').addEventListener('click', importUserList);
  $('#exportBackupBtn').addEventListener('click', exportUserBackup);
  $('#backupFile').addEventListener('change', previewUserBackup);
  $('#importBackupBtn').addEventListener('click', importUserBackup);
  $('#exportTranslationTemplate').addEventListener('click', exportTranslationTemplate);
  $('#translationPackFile').addEventListener('change', previewTranslationPack);
  $('#downloadTranslationUpdate').addEventListener('click', downloadTranslationUpdate);
  $('#importTranslationPack').addEventListener('click', installTranslationPack);
  $('#installOfficialTranslationUpdate').addEventListener('click', installOfficialTranslationUpdate);
  $('#interfaceLanguage').addEventListener('change', () => {
    const [source, locale] = $('#interfaceLanguage').value.split(':');
    translationSettings.locale = locale || 'en';
    translationSettings.source =
      source === 'official' ? 'official' : source === 'local' ? 'local' : 'english';
    save(STORE.translations, translationSettings);
    saveUIState();
    location.reload();
  });
  $('#generateCorrectionCode').addEventListener('click', generateCorrectionPackage);
  $('#copyCorrectionCode').addEventListener('click', async () => {
    const code = $('#correctionExportCode').value;
    if (!code) return toast('Generate a correction package first');
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      $('#correctionExportCode').select();
      document.execCommand('copy');
    }
    toast('Correction package copied');
  });
  $('#clearCorrectionDrafts').addEventListener('click', () => {
    if (!Object.keys(catalogDrafts).length || !confirm('Clear every saved catalog correction draft?')) return;
    catalogDrafts = {};
    save(STORE.catalogCorrections, catalogDrafts);
    $('#correctionExportCode').value = '';
    renderCorrectionWorkspace();
    renderAll();
    toast('Correction drafts cleared');
  });
  $('#previewCorrectionCode').addEventListener('click', previewCorrectionPackage);
  $('#applyReviewedCorrections').addEventListener('click', applyReviewedCorrectionPackage);
  $('#releaseUpdateFile').addEventListener('change', selectReleaseUpdateFile);
  $('#previewReleaseUpdates').addEventListener('click', previewReleaseUpdates);
  $('#applySelectedReleaseUpdates').addEventListener('click', applySelectedReleaseUpdates);
  $('#clearReleaseUpdates').addEventListener('click', clearReleaseUpdateSelection);
  $('#clearReleaseUpdateHistory').addEventListener('click', () => {
    if (!Array.isArray(releaseUpdateHistory) || !releaseUpdateHistory.length) return;
    releaseUpdateHistory = [];
    save(STORE.releaseUpdateHistory, releaseUpdateHistory);
    renderReleaseUpdateHistory();
    toast('Release-update history cleared');
  });
  $('#addTitleForm').addEventListener('submit', addTitle);
  $('#addTitleType').addEventListener('change', (event) => {
    if (event.target.value === 'Adult / Hentai') $('#addTitleAdult').checked = true;
  });
  $('#dialogClose')?.addEventListener('click', () => $('#detailDialog').close());
  $('#collectionClose').addEventListener('click', () => $('#collectionDialog').close());
  $('#detailDialog').addEventListener('click', (e) => {
    if (e.target === $('#detailDialog')) $('#detailDialog').close();
  });
  $('#collectionDialog').addEventListener('click', (e) => {
    if (e.target === $('#collectionDialog')) $('#collectionDialog').close();
  });
  $('#ratingFormatDialog').addEventListener('cancel', (event) => event.preventDefault());
  document.addEventListener(
    'click',
    (event) => {
      if (!pendingEpisodeAction || !(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (button !== pendingEpisodeAction.button) cancelEpisodeActionConfirmation();
    },
    true,
  );
  $('#detailDialog').addEventListener('close', () => {
    cancelEpisodeActionConfirmation();
    syncNavigationUrl();
  });
  $('#collectionDialog').addEventListener('close', () => {
    cancelEpisodeActionConfirmation();
    syncNavigationUrl();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !$('#detailDialog').open || !$('#collectionDialog').open) return;
      event.preventDefault();
      event.stopPropagation();
      $('#detailDialog').close();
    },
    true,
  );
  $('#dismissUpdateBtn').addEventListener('click', () => {
    if (availableUpdate) save(STORE.dismissedUpdate, availableUpdate);
    const notice = $('#updateNotice');
    notice.classList.remove('show');
    setTimeout(() => {
      notice.hidden = true;
    }, 280);
  });
  $('#installUpdateBtn').addEventListener('click', installAvailableUpdate);

  function restoreNavigationFromUrl() {
    applyUrlNavigationState();
    const tab = location.hash.replace('#', '');
    const validTab = [
      'master',
      'regions',
      'collections',
      'franchises',
      'adult',
      'kids',
      'favorites',
      'userlist',
    ].includes(tab)
      ? tab
      : 'master';
    ensureDestinationFilters(validTab);
    // Dynamic controls are populated lazily. Apply the URL a second time only
    // after those options exist, then rebuild the dependent country list.
    applyUrlNavigationState();
    restoreGeographyControls(validTab);
    renderAll({ expandedFranchiseIds: urlExpandedFranchiseIds });
    switchTab(validTab, { history: 'replace', scroll: false });
    restoreExpandedFranchises(urlExpandedFranchiseIds);
    restoreOpenDialogs();
    syncNavigationUrl({ history: 'replace' });
  }

  window.addEventListener('popstate', restoreNavigationFromUrl);
  window.addEventListener('hashchange', restoreNavigationFromUrl);

  // boot
  await loadOfficialTranslations();
  rebuildTitleSearchIndex();
  // Only build controls visible on the first page. The other destinations
  // initialise their large facet lists when the user actually opens them.
  populateFilters({ eager: false });
  restoreUIState();
  applyUrlNavigationState();
  $('#viewToggle').textContent = state.compact ? '▤' : '▥';
  $('#westernViewToggle').textContent = state.westernCompact ? '▤' : '▥';
  $('#kidsViewToggle').textContent = state.kidsCompact ? '▤' : '▥';
  const hash = location.hash.replace('#', '');
  const initialTab = [
    'master',
    'regions',
    'collections',
    'franchises',
    'adult',
    'kids',
    'favorites',
    'userlist',
  ].includes(hash)
    ? hash
    : 'master';
  state.tab = initialTab;
  // Initialise the controls for the destination being opened before any slow
  // health or update check runs. Otherwise a user can select a Region while
  // the page is visible and have that selection overwritten by late state
  // restoration.
  ensureDestinationFilters(initialTab);
  // URL state takes precedence over persisted controls. Reapply it now that
  // lazy destination controls exist, so a saved Region also narrows Country.
  applyUrlNavigationState();
  restoreGeographyControls(initialTab);
  // Render exactly one destination at boot. Rendering cards and queueing cover
  // lookups for every hidden area made the initial page compete with itself.
  if (initialTab === 'master') renderMaster({ noMeta: true });
  if (initialTab === 'regions') renderWestern({ noMeta: true });
  if (initialTab === 'adult') renderAdult();
  if (initialTab === 'kids') renderKids({ noMeta: true });
  if (initialTab === 'collections') renderCollections();
  if (initialTab === 'franchises') renderFranchises();
  if (initialTab === 'favorites') renderFavorites();
  if (initialTab === 'userlist') renderUserSummary();
  renderInterfaceLanguages();
  checkOfficialTranslationUpdate();
  renderCorrectionWorkspace();
  renderReleaseUpdateHistory();
  updateHero();
  await checkServer();
  hydrateManualCoverSources();
  checkForUpdates();
  // Do not let a slow health/update check overwrite a click made while the
  // first cards are already visible.
  if (state.tab === initialTab) {
    switchTab(initialTab, { history: 'replace' });
    restoreExpandedFranchises(urlExpandedFranchiseIds);
    restoreOpenDialogs();
    syncNavigationUrl();
  }
  interfaceI18n.start();
  setTimeout(showRatingFormatOnboarding, 350);
})().catch((error) => {
  console.error('Catalog startup failed:', error);
  const main = document.querySelector('.main-shell');
  if (main) {
    main.innerHTML =
      '<section class="panel active"><div class="empty-state">The catalog could not be loaded. Start the included server and reload the page.</div></section>';
  }
});
