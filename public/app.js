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
  const APP_VERSION = '3.0.3';
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
    editorDrafts: 'uai:editor-drafts:v1',
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
  const formatTimeUntil = (value) => {
    const milliseconds = Date.parse(value) - Date.now();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Expired';
    const days = Math.ceil(milliseconds / (24 * 60 * 60 * 1000));
    return `Expires in ${formatCount(days)} ${days === 1 ? 'day' : 'days'}`;
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
    const hasNoPersistentFiles = !Object.keys(fileStorage).length && !Object.keys(cacheStorage).length;
    if (hasNoPersistentFiles && Object.keys(legacy).length) {
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
    } else if (legacy[STORE.ui] && typeof legacy[STORE.ui] === 'object') {
      // UI state is mirrored synchronously in the browser. This protects a
      // just-changed filter if the user refreshes before the background file
      // write has had a chance to complete.
      persistentUserData[STORE.ui] = legacy[STORE.ui];
      try {
        await writePersistentUserData();
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
    if (k === STORE.ui) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    }
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
  // Keep the primary path natural: a click advances from unwatched to
  // watching to completed, then through the exceptional states before looping.
  const WATCH_STATUSES = ['Not started', 'Watching', 'Watched', 'On hold', 'Dropped', 'Skipped'];
  const WATCH_STATUS_ALIASES = { Completed: 'Watched' };
  const watchStatusDisplay = (status) =>
    status === 'Watched' ? 'Completed' : status === 'On hold' ? 'Paused' : status;
  const normalizeWatchStatus = (status) => {
    const normalized = WATCH_STATUS_ALIASES[status] || status;
    return WATCH_STATUSES.includes(normalized) ? normalized : 'Not started';
  };
  const watchStatusSlug = (status) => normalizeWatchStatus(status).toLowerCase().replace(/\s+/g, '-');
  const isHandledWatchStatus = (status) => ['Watched', 'Skipped'].includes(normalizeWatchStatus(status));
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
    coverArtworkMode: ['never', 'own', 'download'].includes(savedUI.coverArtworkMode)
      ? savedUI.coverArtworkMode
      : savedUI.coverArtworkEnabled === false
        ? 'never'
        : 'download',
    catalogUpdateMode: savedUI.catalogUpdateMode === 'manual' ? 'manual' : 'auto',
    dismissedCoverPackHash:
      typeof savedUI.dismissedCoverPackHash === 'string' ? savedUI.dismissedCoverPackHash : '',
    installedCoverPackHash:
      typeof savedUI.installedCoverPackHash === 'string' ? savedUI.installedCoverPackHash : '',
    summaryLanguage:
      typeof savedUI.summaryLanguage === 'string' ? savedUI.summaryLanguage.trim().toLowerCase() : '',
    franchiseRoute: savedUI.franchiseRoute === 'story' ? 'story' : 'recommended',
    franchiseRoutes:
      savedUI.franchiseRoutes && typeof savedUI.franchiseRoutes === 'object'
        ? Object.fromEntries(
            Object.entries(savedUI.franchiseRoutes).filter(
              ([, route]) => route === 'story' || route === 'recommended',
            ),
          )
        : {},
    franchiseFocusStep: typeof savedUI.franchiseFocusStep === 'string' ? savedUI.franchiseFocusStep : '',
    server: false,
    signerCompatible: false,
    signerFormat: 'UWL',
    keyId: '',
    shareLinksEnabled: false,
    shareServiceUrl: '',
    turnstileSiteKey: '',
    updateToken: '',
    catalogWriteEnabled: false,
    catalogToken: '',
  };
  let progress = load(STORE.progress, {}),
    myOpinions = load(STORE.opinions, {}),
    customTitles = load(STORE.custom, []),
    sources = load(STORE.sources, {}),
    meta = load(STORE.meta, {}),
    installedArtwork = {},
    favorites = load(STORE.favorites, {}),
    episodeProgress = load(STORE.episodes, {}),
    seriesGroups = load(STORE.series, {}),
    franchiseProgress = load(STORE.franchiseProgress, {}),
    catalogDrafts = {},
    editorDrafts = load(STORE.editorDrafts, {}),
    releaseUpdateHistory = load(STORE.releaseUpdateHistory, []);
  let watchStatusMigrationNeeded = false;
  progress = Object.fromEntries(
    Object.entries(progress || {}).map(([id, record]) => {
      const status = normalizeWatchStatus(record?.status);
      if (record?.status !== status) watchStatusMigrationNeeded = true;
      return [id, { ...record, status }];
    }),
  );
  franchiseProgress = Object.fromEntries(
    Object.entries(franchiseProgress || {}).map(([id, status]) => [
      id,
      status === true ? 'Watched' : normalizeWatchStatus(status),
    ]),
  );
  if (watchStatusMigrationNeeded) save(STORE.progress, progress);
  if (
    Object.values(load(STORE.franchiseProgress, {})).some(
      (status) => status === true || status === 'Completed',
    )
  )
    save(STORE.franchiseProgress, franchiseProgress);
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
  let availableCoverPack = null;
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
  // Franchise details are rebuilt when metadata arrives. Keep load state outside
  // the DOM so restoring an open guide cannot start the same request repeatedly.
  const franchiseItemsLoaded = new Set();
  const franchiseItemsLoading = new Set();
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
    ];
    for (const [key, record] of affected) if (migrateCatalogIdKeys(record)) save(key, record);
    let sourceChanged = false;
    for (const source of Object.values(sources)) {
      if (migrateCatalogIdKeys(source?.opinions)) sourceChanged = true;
      if (Array.isArray(source?.completed)) {
        const migrated = source.completed.map((id) => catalogIdMigrations[id] || id);
        if (migrated.some((id, index) => id !== source.completed[index])) {
          source.completed = [...new Set(migrated)];
          sourceChanged = true;
        }
      }
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
    const titles = [
      ...new Set(
        (franchise.orders || [])
          .flatMap((order) => order.steps || [])
          .filter((step) => !isLiveActionFranchiseStep(step) && step.title)
          .map((step) => step.title),
      ),
    ];
    if (!ids.length && !titles.length) return false;
    const key = `franchise|${franchise.id}|${ids.join(',')}|${titles.join(',')}`;
    let result = catalogPageCache.get(key);
    if (!result) {
      try {
        const response = await fetch('/api/catalog/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: {
              scope: 'master',
              ids,
              titles,
              onlyIds: !titles.length,
              limit: Math.max(ids.length, titles.length, 1),
            },
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
    const editor = editorDrafts[item?.id];
    if (!item) return item;
    let result = item;
    if (draft?.operation === 'update')
      result = {
        ...item,
        scores: { ...draft.values.scores },
        content: { ...draft.values.content, tags: [...draft.values.content.tags] },
      };
    if (editor?.values && typeof editor.values === 'object') {
      const values = editor.values;
      result = {
        ...result,
        ...values,
        description: values.description ?? result.description,
        sourceUrl: values.sourceUrl || result.sourceUrl || '',
        aliases: Array.isArray(values.aliases) ? values.aliases : result.aliases,
        editorEpisodes: values.editorEpisodes || result.editorEpisodes,
        editorFranchise: values.editorFranchise || result.editorFranchise,
      };
    }
    return result;
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
    if (official) return itemWithCatalogDraft(official);
    const custom = customTitles.find((x) => x.id === id) || null;
    const editor = editorDrafts[id];
    if (custom && editor?.values) return itemWithCatalogDraft({ ...custom, id });
    return custom;
  }
  function localArtworkFor(item) {
    if (!item?.id || state.coverArtworkMode === 'never') return '';
    const cover =
      installedArtwork[item.id]?.cover ||
      meta[item.id]?.data?.cover ||
      meta[item.id]?.data?.image ||
      item.cover ||
      '';
    return String(cover).startsWith('/covers/') ? cover : '';
  }
  function localBackdropFor(item) {
    if (!item?.id || state.coverArtworkMode === 'never') return '';
    const backdrop = installedArtwork[item.id]?.banner || meta[item.id]?.data?.banner || '';
    return String(backdrop).startsWith('/covers/') ? backdrop : '';
  }
  function localArtworkForTitle(title) {
    const needle = norm(title);
    if (!needle) return '';
    const item = canonicalItems().find(
      (candidate) =>
        norm(candidate.title) === needle || (candidate.aliases || []).some((alias) => norm(alias) === needle),
    );
    return localArtworkFor(item);
  }
  function pFor(id) {
    const record = progress[id] || { status: 'Not started', rating: 0, note: '' };
    return { ...record, status: normalizeWatchStatus(record.status) };
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
  function sourceCompletionOrigins(id) {
    return Object.entries(sources)
      .filter(([, source]) => Array.isArray(source?.completed) && source.completed.includes(id))
      .map(([sid]) => sid);
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
        franchiseRoute: state.franchiseRoute,
        franchiseFocusStep: state.franchiseFocusStep,
        summaryLanguage: state.summaryLanguage,
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
      if (settings.franchiseRoute === 'story' || settings.franchiseRoute === 'recommended')
        state.franchiseRoute = settings.franchiseRoute;
      if (settings.franchiseRoutes && typeof settings.franchiseRoutes === 'object')
        state.franchiseRoutes = Object.fromEntries(
          Object.entries(settings.franchiseRoutes).filter(
            ([, route]) => route === 'story' || route === 'recommended',
          ),
        );
      if (typeof settings.franchiseFocusStep === 'string')
        state.franchiseFocusStep = settings.franchiseFocusStep;
      if (typeof settings.summaryLanguage === 'string')
        state.summaryLanguage = normalizeSummaryLocale(settings.summaryLanguage);
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
    renderCoverPackMode();
    renderCatalogUpdateMode();
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
      coverArtworkMode: state.coverArtworkMode,
      catalogUpdateMode: state.catalogUpdateMode,
      dismissedCoverPackHash: state.dismissedCoverPackHash,
      installedCoverPackHash: state.installedCoverPackHash,
      summaryLanguage: state.summaryLanguage,
      activeTab: state.tab,
      franchiseRoute: state.franchiseRoute,
      franchiseRoutes: state.franchiseRoutes,
      franchiseFocusStep: state.franchiseFocusStep,
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
      if ($('#hideCompleted').checked && p.status === 'Watched') return false;
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
      if ($('#westernHideCompleted').checked && p.status === 'Watched') return false;
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
      if ($('#kidsHideCompleted').checked && p.status === 'Watched') return false;
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
      Watched: {
        slug: 'watched',
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
      Skipped: {
        slug: 'skipped',
        icon: '<path d="M7 8.5h5.5m0 0-2.5-2.5m2.5 2.5-2.5 2.5M17 15.5h-5.5m0 0 2.5-2.5m-2.5 2.5 2.5 2.5"></path>',
      },
    };
    const normalized = normalizeWatchStatus(status);
    const mark = marks[normalized] || marks['Not started'];
    const label = `Watch status: ${watchStatusDisplay(normalized)}`;
    const text = normalized === 'Watched' ? '<b>WATCHED</b>' : '';
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
      cover = localArtworkFor(x);
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
    return `<article class="title-card ${p.status === 'Watched' ? 'is-completed' : ''}" data-id="${esc(x.id)}">
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
        const edition = award.edition
          ? `<small class="award-edition-label">EDITION</small><b>${esc(String(award.edition))}</b>`
          : '';
        const cycle = String(award.cycle || '').trim();
        const eventYear = String(award.eventYear || '').trim();
        const awardDate =
          cycle && eventYear && cycle !== eventYear ? `${cycle} // ${eventYear}` : eventYear || cycle;
        const workDetail = award.sourceWorkDetail
          ? `<em class="award-work-detail">${esc(award.sourceWorkDetail)}</em>`
          : '';
        const body = `${awardMarkHTML(profile)}<span class="award-copy"><small>${esc(award.organization || profile.label)}</small><strong>${esc(award.award)}</strong><em>${esc(`${award.category}${sourceLabel}`)}</em>${workDetail}</span><span class="award-result is-${esc(resultClass)}">${esc(award.result)}</span><span class="award-cycle">${edition}<small>${esc(awardDate)}</small></span>`;
        const label = `${award.award}: ${award.category}, ${award.result}, ${award.cycle}`;
        return sourceHref
          ? `<a class="award-entry" role="listitem" href="${esc(sourceHref)}" target="_blank" rel="noopener" aria-label="${esc(`Open source for ${label}`)}" data-tooltip="Open award source">${body}</a>`
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
      films = items.filter((x) => /film/i.test(x.type || '')).length,
      favCount = items.filter((x) => isFavorite(x.id)).length,
      recommendations = items.filter((x) => ownVerdict(x.id) === 'recommend').length,
      watched = watchedContentUnitStats(items),
      watchedTooltip = watchedContentTooltip(watched),
      watchedTooltipHtml = watchedContentTooltipHTML(watched);
    $('#statStrip').innerHTML =
      `<div class="stat"><b>${formatCount(catalogBootstrap?.total || items.length)}</b><span>TITLES</span></div><div class="stat"><b>${formatCount(catalogBootstrap?.filmCount ?? films)}</b><span>FILMS / FILM SERIES</span></div><div class="stat"><b>${formatCount(catalogBootstrap?.collectionCount ?? CAT.collections.length)}</b><span>COLLECTIONS</span></div><div class="stat"><b>${formatCount(catalogBootstrap?.franchiseCount ?? CAT.franchises.length)}</b><span>FRANCHISE GUIDES</span></div><div class="stat"><b>${formatCount(recommendations)}</b><span>RECOMMENDATIONS</span></div><div class="stat"><b>${formatCount(favCount)}</b><span>FAVORITES</span></div><div class="stat stat--watched" tabindex="0" role="img" aria-label="${esc(watchedTooltip)}" data-tooltip="${esc(watchedTooltip)}" data-tooltip-html="${esc(watchedTooltipHtml)}"><b>${formatCount(watched.total)}</b><span>WATCHED EPISODES + FILMS</span></div>`;
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
    const format = String(x?.format || meta[x?.id]?.data?.format || '').toLowerCase();
    return (
      (/\b(film|movie)\b/.test(type) || /\b(feature film|film|movie)\b/.test(format)) &&
      !/\bseries\b/.test(type)
    );
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

  // This is intentionally not the share counter. It reflects only this
  // installation's actual watched units: marked episodes, OVAs, specials and
  // completed films. A title is shareable only when its whole group is done.
  function watchedContentUnitStats(items = canonicalItems()) {
    const watchedUnits = new Map();
    const entryOwners = new Map();
    const watchedTitleIds = new Set();
    const counts = { seriesEpisodes: 0, ovaEpisodes: 0, specialEpisodes: 0, films: 0 };
    const seriesParts = new Set();
    const addUnit = (key, category, itemId = '', seriesPart = '') => {
      if (watchedUnits.has(key)) return;
      watchedUnits.set(key, category);
      if (itemId) watchedTitleIds.add(itemId);
      // A "series / season part" is a completed TV/series entry, not every
      // episodic item.  OVAs, ONAs and specials remain visible in their own
      // metrics and must not inflate this summary.
      if (seriesPart && category === 'seriesEpisodes') seriesParts.add(seriesPart);
      counts[category]++;
    };
    for (const item of items) {
      if (isFeatureFilm(item)) continue;
      for (const entry of cachedSeriesGroup(item)?.entries || []) {
        const key = episodeKey(entry);
        if (!entryOwners.has(key)) entryOwners.set(key, { entry, item });
      }
    }
    const episodeCategory = ({ entry, item }) => {
      const text = `${entry.format || ''} ${entry.title || ''} ${item.type || ''}`.toLowerCase();
      if (/\b(film|movie)\b/.test(text)) return 'films';
      if (/\b(ova|ona)\b/.test(text)) return 'ovaEpisodes';
      if (/\bspecial\b/.test(text)) return 'specialEpisodes';
      return 'seriesEpisodes';
    };
    for (const [entryKey, records] of Object.entries(episodeProgress)) {
      if (!records || typeof records !== 'object') continue;
      for (const [number, state] of Object.entries(records)) {
        if (state !== 'watched') continue;
        const owner = entryOwners.get(entryKey);
        const category = owner ? episodeCategory(owner) : 'seriesEpisodes';
        addUnit(`${entryKey}:${number}`, category, owner?.item?.id || '', entryKey);
      }
    }
    for (const item of items) {
      if (isFeatureFilm(item)) {
        if (pFor(item.id).status === 'Watched') addUnit(`film:${item.id}`, 'films', item.id);
        continue;
      }
      // A legacy title-level Watched state can predate per-episode progress.
      // Fill it from known episode data without double-counting any marks above.
      if (pFor(item.id).status !== 'Watched') continue;
      for (const entry of cachedSeriesGroup(item)?.entries || []) {
        const total = Math.max(0, Number(entry.episodes) || 0);
        const category = episodeCategory({ entry, item });
        for (let number = 1; number <= total; number++)
          addUnit(`${episodeKey(entry)}:${number}`, category, item.id, episodeKey(entry));
      }
    }
    const franchises = CAT.franchises.filter((franchise) =>
      franchise.orders?.some((order) =>
        (order.steps || []).some((step) => watchedTitleIds.has(franchiseStepItem(step)?.id)),
      ),
    ).length;
    return { total: watchedUnits.size, ...counts, seriesParts: seriesParts.size, franchises };
  }

  function watchedContentTooltip(stats) {
    if (!stats.total)
      return 'No watched content yet. This counter is local and does not use shared-list completion signals.';
    const parts = [];
    if (stats.seriesEpisodes) parts.push(`${formatCount(stats.seriesEpisodes)} series episodes`);
    if (stats.ovaEpisodes) parts.push(`${formatCount(stats.ovaEpisodes)} OVA / ONA episodes`);
    if (stats.specialEpisodes) parts.push(`${formatCount(stats.specialEpisodes)} specials`);
    if (stats.films) parts.push(`${formatCount(stats.films)} films`);
    if (stats.seriesParts) parts.push(`${formatCount(stats.seriesParts)} seasons`);
    if (stats.franchises) parts.push(`${formatCount(stats.franchises)} franchises`);
    return `${formatCount(stats.total)} watched units: ${parts.join(' · ')}. Local watch history only.`;
  }

  function watchedContentTooltipHTML(stats) {
    const unit = stats.total === 1 ? 'WATCHED UNIT' : 'WATCHED UNITS';
    const metric = (value, label) =>
      `<div><strong><b>${formatCount(value)}</b><i aria-hidden="true">//</i></strong><span>${label}</span></div>`;
    return `<div class="watch-tooltip"><span class="watch-tooltip-kicker">LOCAL WATCH HISTORY</span><strong><b>${formatCount(stats.total)}</b><span>${unit}</span></strong><div class="watch-tooltip-grid">${metric(stats.seriesEpisodes, 'SERIES EPISODES')}${metric(stats.ovaEpisodes, 'OVA / ONA EPISODES')}${metric(stats.specialEpisodes, 'SPECIAL EPISODES')}${metric(stats.films, 'FILMS')}${metric(stats.seriesParts, 'SEASONS')}${metric(stats.franchises, 'FRANCHISES')}</div><small>Counts actual watched units in this installation. It is separate from the anonymous completion signal used in shared lists.</small></div>`;
  }

  function derivedEpisodeStatus(group) {
    const stats = groupEpisodeStats(group);
    if (stats.total && stats.watched === stats.total) return 'Watched';
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
          cover: localArtworkFor(x),
          episodeTitles: ['Feature film'],
        },
      ],
    };
  }

  async function seriesMatchCandidates(x, query = x.lookupTitle || x.title) {
    const response = await fetch(
      `/api/series/candidates?kind=${encodeURIComponent(x.api)}&title=${encodeURIComponent(query)}`,
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
    if (!stepTitle || !entryTitle) return false;
    const seasonToken = (value) => value.match(/\b(?:season|s)\s*([0-9]+)\b/i)?.[1] || '';
    const partToken = (value) => value.match(/\bpart\s*([0-9]+)\b/i)?.[1] || '';
    const stepSeason = seasonToken(stepTitle);
    const entrySeason = seasonToken(entryTitle);
    const stepPart = partToken(stepTitle);
    const entryPart = partToken(entryTitle);
    const stepFinal = /\bfinal\s+season\b/i.test(stepTitle);
    const entryFinal = /\bfinal\s+season\b/i.test(entryTitle);
    if (stepSeason && entrySeason && stepSeason !== entrySeason) return false;
    // The provider calls the first season simply "Attack on Titan" and calls
    // Season 3 Part 1 simply "Attack on Titan Season 3". Those are still the
    // correct entries; only later seasons/parts must be explicit.
    if (stepSeason && !entrySeason && stepSeason !== '1') return false;
    if (stepPart && entryPart && stepPart !== entryPart) return false;
    if (stepPart === '2' && !entryPart) return false;
    if (stepFinal && !entryFinal) return false;
    if (
      (stepSeason === '1' && !entrySeason && !stepPart) ||
      (stepSeason &&
        entrySeason === stepSeason &&
        (!stepPart || stepPart === entryPart || (stepPart === '1' && !entryPart))) ||
      (stepFinal && entryFinal && (!stepPart || stepPart === entryPart || (stepPart === '1' && !entryPart)))
    )
      return true;
    if (stepFinal && stepPart === '2' && !entryPart) return false;
    if (stepTitle === entryTitle || entryTitle.includes(stepTitle)) return true;
    // Do not let a short franchise root (for example "Attack on Titan")
    // match every longer OVA/special title. That made a placement resolve to
    // whichever similarly-sized provider entry happened to appear first.
    if (stepTitle.includes(entryTitle) && entryTitle.split(' ').length >= 4) return true;
    const stepKey = franchiseTitleKey(step?.title);
    const entryKey = franchiseTitleKey(entry?.title);
    return Boolean(
      stepKey &&
      entryKey &&
      (stepKey === entryKey ||
        entryKey.includes(stepKey) ||
        (stepKey.includes(entryKey) && entryKey.split(' ').length >= 4)),
    );
  }

  function trackerEntryForStep(step, group) {
    const entries = group?.entries || [];
    const stepTitle = norm(step?.title);
    const exact = entries.find((entry) => {
      const names = [entry?.title, entry?.altTitle].filter(Boolean).map(norm);
      return names.includes(stepTitle);
    });
    // A root step such as "Attack on Titan" is contained in every sequel
    // title, so exact identity must win before the broader franchise matcher.
    const explicitRange = franchiseStepEpisodeNumbers(step);
    if (exact && (!explicitRange.length || Number(exact.episodes) === explicitRange.length)) return exact;
    const directMatches = entries.filter((entry) => trackerStepMatchesEntry(step, entry));
    if (directMatches.length === 1) return directMatches[0];
    if (directMatches.length > 1) {
      // Some provider records share a title (Attack on Titan Season 3 is the
      // classic example). The curated route's local range disambiguates them:
      // Episodes 1-12 belongs to Part 1, while Episodes 13-22 belongs to the
      // separate Part 2 provider entry.
      const range = franchiseStepEpisodeNumbers(step);
      const byLength = range.length
        ? directMatches.find((entry) => Number(entry.episodes) === range.length)
        : null;
      if (byLength) return byLength;
      return directMatches[0];
    }
    const text = norm(step?.title);
    if (!text) return null;
    const season = text.match(/\bseason\s*([0-9]+)\b/i)?.[1] || '';
    const part = text.match(/\bpart\s*([0-9]+)\b/i)?.[1] || '';
    const finalSeason = /\bfinal\s+season\b/i.test(text);
    const candidates = entries.filter((entry) => {
      const title = norm(entry.title);
      const entrySeason = title.match(/\bseason\s*([0-9]+)\b/i)?.[1] || '';
      const entryPart = title.match(/\bpart\s*([0-9]+)\b/i)?.[1] || '';
      const entryFinal = /\bfinal\s+season\b/i.test(title);
      if (season && (entrySeason ? entrySeason !== season : season !== '1')) return false;
      if (part === '2' && entryPart !== '2') return false;
      if (part === '1' && entryPart === '2') return false;
      if (finalSeason && !entryFinal) return false;
      return true;
    });
    return candidates.length === 1 ? candidates[0] : candidates[0] || null;
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
    const franchiseList = CAT.franchises.map(franchiseWithEditorDraft);
    const ownerName = norm(owner.title);
    const franchise =
      franchisesForItem(owner)[0]?.franchise ||
      franchiseList.find(
        (entry) =>
          norm(entry.name) === ownerName || (entry.aliases || []).some((alias) => norm(alias) === ownerName),
      );
    if (!franchise)
      return group.entries.map((entry, index) => ({ kind: 'entry', entry, label: labels[index] }));
    // Detail rows use unsplit curated instructions. The timeline may split a
    // season into nodes, but this view must keep title ranges as route rows.
    const route = franchiseRouteInstructions(franchise, 'recommended');
    const rows = [];
    const coveredEntries = new Set();
    const renderedEntries = new Set();
    route.forEach((step, stepIndex) => {
      const entry = trackerEntryForStep(step, group);
      const placement = Boolean(step.after || step.before) || /^(after|before)\b/i.test(String(step.n || ''));
      if (!entry && !isLiveActionFranchiseStep(step)) return;
      const entryIndex = entry ? group.entries.indexOf(entry) : -1;
      if (!entry) {
        rows.push({
          kind: 'placement',
          step,
          entry: null,
          franchise,
          orderIndex: 0,
          stepIndex,
          routeIndex: stepIndex,
          label: '',
        });
        return;
      }
      coveredEntries.add(entry.id);
      if (!placement && renderedEntries.has(entry.id)) return;
      const scopedEpisodes = placement ? franchiseStepEpisodeNumbers(step) : [];
      const displayStep = scopedEpisodes.length ? { ...step, episodes: scopedEpisodes } : step;
      rows.push({
        kind: placement ? 'placement' : 'entry',
        step: displayStep,
        entry,
        franchise,
        orderIndex: 0,
        stepIndex,
        routeIndex: stepIndex,
        label: labels[entryIndex],
      });
      if (!placement) renderedEntries.add(entry.id);
    });
    group.entries.forEach((entry, index) => {
      if (!coveredEntries.has(entry.id))
        rows.push({ kind: 'entry', entry, label: labels[index], routeIndex: Number.MAX_SAFE_INTEGER });
    });
    return rows.sort(
      (a, b) => (a.routeIndex ?? Number.MAX_SAFE_INTEGER) - (b.routeIndex ?? Number.MAX_SAFE_INTEGER),
    );
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
    const localCover = localArtworkForTitle(entry.title);
    // Keep the cover column in the season grid even when the local package has
    // no artwork for this title. Omitting that cell shifts the copy into the
    // narrow cover column and truncates every title in the modal.
    const coverCell = !isFilm
      ? localCover
        ? `<img src="${esc(localCover)}" alt="" loading="lazy">`
        : '<span class="season-cover-placeholder" aria-hidden="true"></span>'
      : '';
    return `<details class="season-row ${state} ${isFilm ? 'feature-film-row' : ''} ${placement ? 'franchise-placement' : ''}" ${index === firstIncomplete ? 'open' : ''}><summary><span class="season-code">${esc(placement ? entry.format || 'OVA' : row.label)}</span>${coverCell}<span class="season-copy">${placementMeta}<b>${esc(entry.title)}</b><small>${esc([entry.year || '', entry.format || '', episodeLabel].filter(Boolean).join(' // '))}</small>${note}${episodeProgressMeterHTML(ratio, 'season-meter')}</span><span class="season-count"><b>${formatCount(stats.watched)}/${formatCount(stats.total)}</b><small>${state}</small></span><span class="season-chevron">+</span></summary><div class="season-episodes ${isFilm ? 'feature-film-actions' : ''} ${placement ? 'placement-episodes' : ''}">${placement ? '' : `<div class="season-actions"><button type="button" data-episode-action="${isFilm ? 'watching' : 'continue'}" data-entry-id="${esc(entry.id)}">${isFilm ? 'MARK WATCHING' : 'NEXT EPISODE'}</button><button type="button" data-episode-action="all-watched" data-entry-id="${esc(entry.id)}">${isFilm ? 'MARK WATCHED' : 'MARK SEASON WATCHED'}</button><button type="button" data-episode-action="reset" data-entry-id="${esc(entry.id)}">RESET</button></div>`}${episodes ? `<div class="episode-grid">${episodes}</div>` : ''}</div></details>`;
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
    if (status === 'Watched') {
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

  let pendingButtonConfirmation = null;
  function cancelButtonConfirmation() {
    if (!pendingButtonConfirmation) return;
    const { button, label, text, timer } = pendingButtonConfirmation;
    clearTimeout(timer);
    pendingButtonConfirmation = null;
    if (!button.isConnected) return;
    button.classList.remove('button-confirm');
    button.textContent = text;
    if (label) button.setAttribute('aria-label', label);
    else button.removeAttribute('aria-label');
  }

  function confirmWithButton(button, { confirmText, confirmLabel = '' }) {
    const pending = pendingButtonConfirmation;
    if (pending?.button === button) {
      clearTimeout(pending.timer);
      pendingButtonConfirmation = null;
      button.classList.remove('button-confirm');
      return true;
    }
    cancelButtonConfirmation();
    const text = button.textContent;
    const label = button.getAttribute('aria-label') || '';
    button.classList.add('button-confirm');
    button.textContent = confirmText;
    button.setAttribute('aria-label', confirmLabel || confirmText);
    pendingButtonConfirmation = {
      button,
      text,
      label,
      timer: setTimeout(cancelButtonConfirmation, 5000),
    };
    return false;
  }

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
        openFranchiseGuide(button.dataset.openFranchiseId, button.dataset.openFranchiseStep || '');
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
          `<div class="episode-match-result"><button type="button" data-series-provider="${esc(candidate.provider)}" data-series-id="${esc(candidate.id)}"><span><b>${esc(candidate.title)}</b>${candidate.altTitle && candidate.altTitle !== candidate.title ? `<small>${esc(candidate.altTitle)}</small>` : ''}</span><em>${esc([candidate.year || '', candidate.format || '', candidate.status || ''].filter(Boolean).join(' // ') || candidate.provider.toUpperCase())}</em></button><a href="${esc(seriesCandidateSourceUrl(candidate))}" target="_blank" rel="noreferrer noopener">OPEN SOURCE ↗</a></div>`,
      )
      .join('')}</div></div>`;
  }

  function seriesCandidateSourceUrl(candidate) {
    if (candidate?.sourceUrl) return candidate.sourceUrl;
    if (candidate?.provider === 'anilist' && candidate?.id)
      return `https://anilist.co/anime/${encodeURIComponent(candidate.id)}`;
    if (candidate?.provider === 'tvmaze' && candidate?.id)
      return `https://www.tvmaze.com/shows/${encodeURIComponent(candidate.id)}`;
    return '#';
  }

  function manualSeriesSearchHTML(owner, message = '') {
    return `<div class="episode-manual-search"><b>SEARCH EPISODE DATA MANUALLY</b><span>${esc(message || 'The automatic match was not found. Search the provider by title instead.')}</span><div><input type="search" data-series-manual-query value="${esc(owner.lookupTitle || owner.title)}" aria-label="Search provider series title"><button type="button" data-series-manual-search>SEARCH</button></div><div data-series-manual-results></div></div>`;
  }

  function bindManualSeriesSearch(mount, owner, variant) {
    const search = $('[data-series-manual-search]', mount);
    const input = $('[data-series-manual-query]', mount);
    const results = $('[data-series-manual-results]', mount);
    if (!search || !input || !results) return;
    search.onclick = async () => {
      const query = input.value.trim();
      if (!query) return;
      search.disabled = true;
      results.innerHTML = '<span>SEARCHING PROVIDER…</span>';
      try {
        const matches = await seriesMatchCandidates(owner, query);
        results.innerHTML = matches.candidates?.length
          ? seriesMatchChoiceHTML(owner, matches.candidates)
          : '<span>No matching series found. Try an alternate title.</span>';
        $$('[data-series-provider][data-series-id]', results).forEach((button) =>
          button.addEventListener('click', () => {
            seriesGroups[owner.id] = {
              match: { provider: button.dataset.seriesProvider, id: button.dataset.seriesId },
            };
            save(STORE.series, seriesGroups);
            populateEpisodeMount(mount, owner, variant);
          }),
        );
      } catch (error) {
        results.innerHTML = `<span>${esc(error.message || 'Manual search failed.')}</span>`;
      } finally {
        search.disabled = false;
      }
    };
  }

  async function populateEpisodeMount(mount, owner, variant = 'detail', { chooseMatch = false } = {}) {
    mount.dataset.episodeOwner = owner.id;
    mount.dataset.episodeVariant = variant;
    mount.innerHTML = '<div class="episode-loading"><i></i><span>Loading connected seasons…</span></div>';
    try {
      // The route registry is a tracker input, not a late visual enhancement.
      // Await it so details can never lock in the provider's arbitrary order.
      await loadCatalogEntity('franchises');
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
      mount.innerHTML = `<div class="episode-load-error"><b>EPISODE DATA UNAVAILABLE</b><span>${esc(error.message)}</span><button type="button" data-series-retry>TRY AGAIN</button></div>${manualSeriesSearchHTML(owner)}`;
      $('[data-series-retry]', mount).onclick = () => populateEpisodeMount(mount, owner, variant);
      bindManualSeriesSearch(mount, owner, variant);
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
      .map(franchiseWithEditorDraft)
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

  function franchiseTitleKey(value) {
    return norm(value)
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(/\b(season|series|tv)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function franchiseStepItem(step) {
    if (isLiveActionFranchiseStep(step)) return null;
    if (step?.itemId) {
      const direct = itemById(step.itemId);
      if (direct) return direct;
    }
    const title = norm(step.title);
    if (!title) return null;
    const items = canonicalItems();
    const exact = items.find(
      (item) => norm(item.title) === title || (item.aliases || []).some((alias) => norm(alias) === title),
    );
    if (exact) return exact;
    const compact = franchiseTitleKey(step.title);
    if (!compact) return null;
    return (
      items.find((item) => {
        const names = [item.title, ...(Array.isArray(item.aliases) ? item.aliases : [])];
        return names.some((name) => {
          const key = franchiseTitleKey(name);
          return key === compact || key.includes(compact) || compact.includes(key);
        });
      }) || null
    );
  }

  function franchiseStatusLabel(status) {
    if (status === 'Completed' || status === 'Watched') return 'COMPLETED';
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
        const group = cachedSeriesGroup(item) || (isFeatureFilm(item) ? featureFilmGroup(item) : null);
        const derived = group ? derivedEpisodeStatus(group) : current.status;
        const active = ['Watched', 'Watching'].includes(derived) ? derived : current.status;
        const next =
          active === 'Not started' ? 'Watching' : active === 'Watching' ? 'Watched' : 'Not started';
        progress[item.id] = { ...current, status: next };
        if (next === 'Not started' && group) {
          for (const entry of group.entries)
            for (let number = 1; number <= Number(entry.episodes || 0); number++)
              setEpisodeState(entry, number, 'unwatched');
          save(STORE.episodes, episodeProgress);
        }
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
    const franchise = CAT.franchises.map(franchiseWithEditorDraft).find((item) => item.id === id);
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

  // Franchise guides used to render provider seasons, an editorial order and
  // placement notes as three unrelated lists.  Keep the source data flexible,
  // but turn it into one canonical set of route steps before rendering.
  function franchiseStepStableId(step, fallback = '') {
    const supplied = String(step?.id || '').trim();
    if (supplied) return supplied;
    return `${norm(step?.title)}:${norm(step?.episodeRange || step?.timeRange || step?.n || fallback)}`
      .replace(/[^a-z0-9:_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isFranchisePlacementOrder(order = {}) {
    return (
      /placement|extra/i.test(order.label || '') ||
      (order.steps || []).some((step) => /^(after|before)\b/i.test(String(step.after || step.n || '')))
    );
  }

  function franchiseOrderKind(order = {}) {
    const text = `${order.label || ''} ${order.mode || ''}`.toLowerCase();
    return /story|chronolog/.test(text) ? 'story' : 'recommended';
  }

  function franchiseStepAnchorMatches(step, anchor) {
    const compact = (value) =>
      norm(value)
        .replace(/\bseason\b/g, 's')
        .replace(/\s+/g, '');
    const target = compact(String(anchor || '').replace(/^(after|before)\s+/i, ''));
    return target && (compact(step.n) === target || compact(step.title).includes(target));
  }

  function franchiseStepEpisodeNumbers(step) {
    if (Array.isArray(step?.episodes))
      return step.episodes.map(Number).filter((number) => Number.isInteger(number) && number > 0);
    if (Number.isInteger(Number(step?.episode)) && Number(step.episode) > 0) return [Number(step.episode)];
    // Curated placement notes often carry the range (for example
    // "Episodes 1-2: Wall Sina, Goodbye.") even when the source pack has no
    // dedicated episodeRange field. Read that note, but deliberately do not
    // parse the main season title: "Season 2 episodes 26-37" uses global story
    // numbering while the provider entry uses local episodes 1-12.
    const text = String(step?.episodeRange || step?.episodes || step?.note || '');
    const match = text.match(/episodes?\s+(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?/i);
    if (!match) return [];
    const start = Number(match[1]);
    const end = Number(match[2] || start);
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
  }

  function franchiseStepSegments(step, franchise = null) {
    if (Array.isArray(step?.segments) && step.segments.length) {
      return step.segments.map((segment, index) => ({
        ...step,
        ...segment,
        id: segment.id || `${franchiseStepStableId(step, `segment-${index + 1}`)}:segment-${index + 1}`,
        segments: undefined,
      }));
    }
    const explicitEpisodes = franchiseStepEpisodeNumbers(step);
    const episodes = explicitEpisodes.length
      ? explicitEpisodes
      : franchiseStepProviderEpisodeNumbers(franchise, step);
    if (episodes.length <= 1) return [step];
    const baseId = franchiseStepStableId(step);
    return episodes.map((episode) => ({
      ...step,
      id: `${baseId}:episode-${episode}`,
      episode,
      episodeRange: `Episode ${episode}`,
      episodes: [episode],
      segments: undefined,
    }));
  }

  function franchiseStepProviderEpisodeNumbers(franchise, step) {
    if (!franchise || franchiseStepEpisodeNumbers(step).length) return [];
    const direct = step?.itemId ? itemById(step.itemId) : franchiseStepItem(step);
    const rootId = aliasMap.get(norm(franchise.name));
    const owner = direct || (rootId ? itemById(rootId) : null);
    const group = owner && cachedSeriesGroup(owner);
    const entry = trackerEntryForStep(step, group);
    const total = Number(entry?.episodes || 0);
    return total > 1 ? Array.from({ length: total }, (_, index) => index + 1) : [];
  }

  function franchiseRouteInstructions(franchise, kind = 'recommended') {
    const orders = franchise.orders || [];
    const primary =
      orders.find((order) => !isFranchisePlacementOrder(order) && franchiseOrderKind(order) === kind) ||
      orders.find((order) => !isFranchisePlacementOrder(order));
    if (!primary) return [];
    const placements = orders.filter(isFranchisePlacementOrder).flatMap((order) => order.steps || []);
    const emitted = new Set();
    const route = [];
    for (const raw of primary.steps || []) {
      route.push(raw);
      placements.forEach((placement, index) => {
        const relation = String(placement.after || placement.n || '');
        const isAfter = Boolean(placement.after) || /^after\b/i.test(relation);
        if (isAfter && franchiseStepAnchorMatches(raw, relation)) {
          route.push(placement);
          emitted.add(index);
        }
      });
      placements.forEach((placement, index) => {
        const relation = String(placement.before || placement.n || '');
        const isBefore = Boolean(placement.before) || /^before\b/i.test(relation);
        if (isBefore && franchiseStepAnchorMatches(raw, relation)) {
          route.splice(Math.max(0, route.length - 1), 0, placement);
          emitted.add(index);
        }
      });
    }
    placements.forEach((placement, index) => {
      if (!emitted.has(index)) route.push(placement);
    });
    return route;
  }

  function franchiseRouteSteps(franchise, kind = 'recommended') {
    return franchiseRouteInstructions(franchise, kind).flatMap((step) =>
      franchiseStepSegments(step, franchise),
    );
  }

  function canonicalFranchiseGuide(franchise) {
    const recommended = franchiseRouteSteps(franchise, 'recommended');
    const story = franchiseRouteSteps(franchise, 'story');
    const byId = new Map();
    const addRoute = (steps, routeName) => {
      steps.forEach((raw, index) => {
        const id = franchiseStepStableId(raw, `${routeName}-${index + 1}`);
        const existing = byId.get(id) || {
          ...raw,
          id,
          recommendedPosition: null,
          storyChronologicalPosition: null,
        };
        existing[routeName === 'story' ? 'storyChronologicalPosition' : 'recommendedPosition'] = index + 1;
        byId.set(id, existing);
      });
    };
    addRoute(recommended, 'recommended');
    addRoute(story, 'story');
    return [...byId.values()];
  }

  function resolvedFranchiseStep(step) {
    const item = franchiseStepItem(step);
    return item ? { ...step, itemId: item.id } : step;
  }

  function franchiseGuideSteps(franchise) {
    return canonicalFranchiseGuide(franchise).map(resolvedFranchiseStep);
  }

  function franchiseSeriesOwner(franchise, step = null) {
    const direct = step && (step.itemId ? itemById(step.itemId) : franchiseStepItem(step));
    if (direct) return direct;
    const rootId = aliasMap.get(norm(franchise.name));
    const root = rootId ? itemById(rootId) : null;
    if (root && canTrackEpisodes(root)) return root;
    return (
      franchiseGuideSteps(franchise)
        .map((entry) => (entry.itemId ? itemById(entry.itemId) : franchiseStepItem(entry)))
        .find((item) => item && canTrackEpisodes(item)) || null
    );
  }

  function franchiseStepEpisodeStatus(franchise, step, owner) {
    const group = owner && cachedSeriesGroup(owner);
    const entry = trackerEntryForStep(step, group);
    if (!entry) return null;
    const states = trackerStepEpisodes(step, entry).map((number) => episodeState(entry, number));
    if (!states.length) return null;
    if (states.every((value) => value === 'watched')) return 'Watched';
    if (states.some((value) => value === 'watching')) return 'Watching';
    if (states.some((value) => value === 'watched')) return 'On hold';
    return null;
  }

  function guideStepStatus(franchise, step) {
    if (isLiveActionFranchiseStep(step))
      return normalizeWatchStatus(franchiseProgress[`${franchise.id}:${step.id}`]);
    const item = franchiseSeriesOwner(franchise, step);
    const isEpisodeScoped =
      Number.isInteger(Number(step.episode)) ||
      Boolean(step.episodeRange) ||
      (Array.isArray(step.episodes) && step.episodes.length > 0);
    const scoped = normalizeWatchStatus(franchiseProgress[`${franchise.id}:${step.id}`]);
    if (isEpisodeScoped && ['On hold', 'Dropped', 'Skipped'].includes(scoped)) return scoped;
    const explicit = item ? normalizeWatchStatus(pFor(item.id).status) : 'Not started';
    const episodeStatus = franchiseStepEpisodeStatus(franchise, step, item);
    // A scoped route step is not allowed to inherit the parent title's status
    // when its provider entry is missing. That made every Attack on Titan
    // season appear watched just because the root title had progress.
    if (isEpisodeScoped) return episodeStatus || 'Not started';
    if (['On hold', 'Dropped', 'Skipped'].includes(explicit)) return explicit;
    return episodeStatus || explicit;
  }

  function franchiseGuideProgress(franchise, steps = franchiseGuideSteps(franchise)) {
    const applicable = steps.filter((step) => step.recommendedPosition || step.storyChronologicalPosition);
    const essential = applicable.filter((step) => String(step.flag || '').toUpperCase() === 'ESSENTIAL');
    const summary = (rows) => ({
      handled: rows.filter((step) => isHandledWatchStatus(guideStepStatus(franchise, step))).length,
      total: rows.length,
    });
    return { essential: summary(essential), all: summary(applicable) };
  }

  function franchiseProgressMetricHTML(label, value) {
    const percent = value.total ? Math.round((value.handled / value.total) * 100) : 0;
    const remaining = Math.max(0, value.total - value.handled);
    return `<div class="franchise-progress-metric"><div class="franchise-progress-copy"><span>${esc(label)}</span><b>${formatCount(value.handled)} completed</b></div><strong>${formatCount(remaining)} remaining</strong><i><em data-progress="${percent}"></em></i><small>${formatCount(percent)}% complete</small></div>`;
  }

  function franchiseRouteOverviewHTML(franchise, steps, activeRoute = 'recommended') {
    const ordered = orderedFranchiseRouteSteps(steps, activeRoute);
    const groups = [];
    ordered.forEach((step) => {
      const last = groups[groups.length - 1];
      if (last && last.title === step.title && last.itemId === step.itemId) last.steps.push(step);
      else groups.push({ title: step.title, itemId: step.itemId, steps: [step] });
    });
    return `<nav class="franchise-route-overview" aria-label="Route overview">${groups
      .map((group, index) => {
        const first = group.steps[0];
        const handled = group.steps.filter((step) =>
          isHandledWatchStatus(guideStepStatus(franchise, step)),
        ).length;
        const label =
          group.steps.length > 1 ? `${group.title} · ${group.steps.length} episodes` : group.title;
        return `<button type="button" class="franchise-route-overview-node ${handled === group.steps.length ? 'is-complete' : ''}" data-franchise-route-target="${esc(first.id)}"><span>${String(index + 1).padStart(2, '0')}</span><b>${esc(label)}</b><small>${formatCount(handled)}/${formatCount(group.steps.length)}</small></button>`;
      })
      .join('<i class="franchise-route-overview-link" aria-hidden="true"></i>')}</nav>`;
  }

  function franchiseStatusSelectHTML(franchise, step) {
    const status = guideStepStatus(franchise, step);
    const source = isLiveActionFranchiseStep(step) ? 'external' : 'title';
    const owner = franchiseSeriesOwner(franchise, step);
    const stepLabel = `${step.title}${step.episode ? ` episode ${step.episode}` : ''}${step.timeRange ? ` ${step.timeRange}` : ''}`;
    const data = `data-franchise-status-source="${source}" data-franchise-id="${esc(franchise.id)}" data-franchise-step-id="${esc(step.id)}" data-franchise-item-id="${esc(owner?.id || '')}"`;
    const icons = {
      'Not started': '<circle cx="12" cy="12" r="7" stroke-dasharray="2.5 3.5"></circle>',
      Watching: '<path d="M9 7.5 17 12l-8 4.5z"></path>',
      'On hold': '<path d="M9 7v10M15 7v10"></path>',
      Dropped: '<path d="m8 8 8 8m0-8-8 8"></path>',
      Skipped: '<path d="m7 7 5 5-5 5m6-10 5 5-5 5"></path>',
      Watched: '<path d="m5.5 12.5 4 4 9-9"></path>',
    };
    const icon = `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter">${icons[status] || icons['Not started']}</g></svg>`;
    return `<div class="franchise-status-control"><button type="button" class="franchise-status-trigger status-${watchStatusSlug(status)}" ${data} data-franchise-status-picker aria-expanded="false" aria-label="Change watch status for ${esc(stepLabel)}: ${esc(watchStatusDisplay(status))}" data-tooltip="${esc(watchStatusDisplay(status))}">${icon}<span class="sr-only">${esc(watchStatusDisplay(status))}</span></button></div>`;
  }

  function franchiseRouteStepHTML(franchise, step, activeRoute) {
    const activePosition =
      activeRoute === 'story' ? step.storyChronologicalPosition : step.recommendedPosition;
    const item = step.itemId ? itemById(step.itemId) : franchiseStepItem(step);
    const status = guideStepStatus(franchise, step);
    const positions = [
      step.recommendedPosition && step.storyChronologicalPosition !== step.recommendedPosition
        ? `<small>REC ${step.recommendedPosition}</small>`
        : '',
      step.storyChronologicalPosition && step.storyChronologicalPosition !== step.recommendedPosition
        ? `<small>STORY ${step.storyChronologicalPosition}</small>`
        : '',
    ].join('');
    const range = step.episode ? `Episode ${step.episode}` : step.episodeRange || step.timeRange || '';
    const note = [step.transition && `THEN ${step.transition}`, step.note, step.resumeNote]
      .filter(Boolean)
      .join(' // ');
    const routeNumber = step.episode ? `E${String(step.episode).padStart(2, '0')}` : activePosition || '—';
    return `<article class="franchise-route-step status-${watchStatusSlug(status)}" data-franchise-step-id="${esc(step.id)}" ${activePosition ? '' : 'hidden'}><span class="franchise-route-number">${esc(routeNumber)}</span><div class="franchise-route-copy"><div class="franchise-route-positions">${positions}</div>${item ? `<button type="button" class="franchise-route-title" data-franchise-detail-id="${esc(item.id)}">${esc(step.title)}</button>` : `<b>${esc(step.title)}</b>`}${range ? `<small class="franchise-time-range">${esc(step.episode ? `WATCH EPISODE ${step.episode}` : step.episodeRange ? `WATCH ${step.episodeRange}` : `WATCH ${step.timeRange}`)}</small>` : ''}${note ? `<small class="franchise-resume-note">${esc(note)}</small>` : ''}</div><em class="flag ${esc(step.flag || 'OPTIONAL')}">${esc(step.flag || 'OPTIONAL')}</em>${isLiveActionFranchiseStep(step) ? '<span class="franchise-live-action">LIVE ACTION</span>' : ''}${franchiseStatusSelectHTML(franchise, step)}</article>`;
  }

  function franchiseRouteEpisodeHTML(franchise, step, activeRoute) {
    const activePosition =
      activeRoute === 'story' ? step.storyChronologicalPosition : step.recommendedPosition;
    if (!activePosition) return '';
    const item = step.itemId ? itemById(step.itemId) : franchiseStepItem(step);
    const status = guideStepStatus(franchise, step);
    const episodeLabel = `E${String(step.episode).padStart(2, '0')}`;
    const owner = franchiseSeriesOwner(franchise, step);
    const entry = owner && trackerEntryForStep(step, cachedSeriesGroup(owner));
    const episodeName = String(entry?.episodeTitles?.[Number(step.episode) - 1] || '').trim();
    const label = episodeName || `Episode ${String(step.episode)}`;
    return `<article class="franchise-route-episode status-${watchStatusSlug(status)}" data-franchise-step-id="${esc(step.id)}">${item ? `<button type="button" class="franchise-route-episode-title" data-franchise-detail-id="${esc(item.id)}" aria-label="Open ${esc(step.title)} ${episodeLabel}: ${esc(label)}"><span class="franchise-route-episode-code">${episodeLabel}</span><span class="franchise-route-episode-name">${esc(label)}</span></button>` : `<span class="franchise-route-episode-title"><span class="franchise-route-episode-code">${episodeLabel}</span><span class="franchise-route-episode-name">${esc(label)}</span></span>`}${franchiseStatusSelectHTML(franchise, step)}</article>`;
  }

  function franchiseRouteBlockHTML(franchise, steps, activeRoute) {
    if (!steps.length) return '';
    const chunks = [];
    let current = [];
    const flush = () => {
      if (current.length) chunks.push(current);
      current = [];
    };
    steps.forEach((step) => {
      const sameEpisodePath =
        step.episode &&
        current.length &&
        current.every((entry) => entry.episode && entry.title === step.title && entry.itemId === step.itemId);
      if (sameEpisodePath || (!current.length && step.episode)) current.push(step);
      else {
        flush();
        current.push(step);
      }
    });
    flush();
    return chunks
      .map((chunk, index) => franchiseRouteEntryHTML(franchise, chunk, activeRoute, index + 1))
      .join('');
  }

  function franchiseRouteEntryHTML(franchise, steps, activeRoute, routeNumber) {
    const first = steps[0];
    const item = first.itemId ? itemById(first.itemId) : franchiseStepItem(first);
    const handled = steps.filter((step) => isHandledWatchStatus(guideStepStatus(franchise, step))).length;
    const format = String(
      item?.format ||
        item?.type ||
        meta[item?.id]?.data?.format ||
        first.format ||
        first.type ||
        first.kind ||
        '',
    ).toUpperCase();
    const formatLabel = /MOVIE|FILM|FEATURE/.test(format)
      ? 'MOVIE'
      : /OVA|SPECIAL/.test(format)
        ? 'OVA'
        : 'TV';
    const year = item?.year || first.year || '';
    const owner = franchiseSeriesOwner(franchise, first);
    const group = owner ? cachedSeriesGroup(owner) : null;
    const hasEpisodeData = Boolean(steps.some((step) => trackerEntryForStep(step, group)));
    const needsEpisodeData = steps.some((step) => step.episode || step.episodeRange) && !hasEpisodeData;
    const description = first.description || first.synopsis || first.note || first.resumeNote || '';
    const dataNote = needsEpisodeData
      ? '<small class="franchise-route-data-inline">EPISODE DATA NOT LOADED // OPEN TITLE DETAILS TO LOAD IT</small>'
      : '';
    const range =
      steps.length > 1
        ? `${formatCount(steps.length)} episodes`
        : first.timeRange || first.episodeRange || (formatLabel === 'MOVIE' ? 'Feature film' : '1 episode');
    const detail =
      steps.length > 1
        ? `<div class="franchise-route-entry-detail">${needsEpisodeData ? `<div class="franchise-route-data-warning"><b>EPISODE DATA NOT LOADED</b><span>Open the title details to load or manually match the episode source.</span>${item ? `<button type="button" data-franchise-detail-id="${esc(item.id)}">OPEN TITLE DETAILS</button>` : ''}</div>` : ''}<div class="franchise-route-episode-grid">${steps.map((step) => franchiseRouteEpisodeHTML(franchise, step, activeRoute)).join('')}</div></div>`
        : '';
    const localCover = localArtworkFor(item);
    const cover = localCover
      ? `<img src="${esc(localCover)}" alt="" loading="lazy">`
      : '<span class="franchise-route-cover-placeholder" aria-hidden="true"></span>';
    const title = item
      ? `<button type="button" class="franchise-route-entry-title" data-franchise-detail-id="${esc(item.id)}">${esc(first.title)}</button>`
      : `<b class="franchise-route-entry-title">${esc(first.title)}</b>`;
    const summaryStatus =
      steps.length === 1
        ? franchiseStatusSelectHTML(franchise, first)
        : '<span class="franchise-route-entry-status-spacer" aria-hidden="true"></span>';
    const expandable = steps.length > 1;
    const countLabel =
      formatLabel === 'MOVIE'
        ? '1 Movie'
        : `${formatCount(steps.length)} episode${steps.length === 1 ? '' : 's'}`;
    return `<details class="franchise-route-entry ${expandable ? '' : 'is-single'}" data-franchise-step-id="${esc(first.id)}"><summary><span class="franchise-route-entry-year">${esc(year)}</span><span class="franchise-route-entry-marker">${String(routeNumber).padStart(2, '0')}</span><span class="franchise-route-entry-cover">${cover}</span><span class="franchise-route-entry-copy">${title}<span class="franchise-route-entry-meta"><b>${esc(formatLabel)}</b><small>${esc(range)}</small></span>${description ? `<span class="franchise-route-entry-description">${esc(description)}</span>` : ''}${dataNote}</span><span class="franchise-route-entry-count">${countLabel}</span>${summaryStatus}${expandable ? '<span class="franchise-route-entry-chevron" aria-hidden="true"></span>' : ''}</summary>${detail}</details>`;
  }

  function orderedFranchiseRouteSteps(steps, route) {
    const position = route === 'story' ? 'storyChronologicalPosition' : 'recommendedPosition';
    return steps.filter((step) => step[position]).sort((a, b) => a[position] - b[position]);
  }

  function selectedFranchiseRoute(franchiseId) {
    return state.franchiseRoutes?.[franchiseId] === 'story'
      ? 'story'
      : state.franchiseRoutes?.[franchiseId] === 'recommended'
        ? 'recommended'
        : state.franchiseRoute;
  }

  function rememberFranchiseRoute(franchiseId, route) {
    if (!franchiseId || (route !== 'story' && route !== 'recommended')) return;
    state.franchiseRoutes = { ...(state.franchiseRoutes || {}), [franchiseId]: route };
    state.franchiseRoute = route;
    saveUIState();
  }

  function franchiseRouteCommonPairs(recommended, story) {
    const rows = Array.from({ length: recommended.length + 1 }, () => Array(story.length + 1).fill(0));
    for (let i = recommended.length - 1; i >= 0; i--) {
      for (let j = story.length - 1; j >= 0; j--) {
        rows[i][j] =
          recommended[i].id === story[j].id
            ? rows[i + 1][j + 1] + 1
            : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < recommended.length && j < story.length) {
      if (recommended[i].id === story[j].id) {
        pairs.push([i++, j++]);
      } else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  function franchiseFlowHTML(franchise, steps) {
    const activeRoute = selectedFranchiseRoute(franchise.id);
    const recommended = orderedFranchiseRouteSteps(steps, 'recommended');
    const story = orderedFranchiseRouteSteps(steps, 'story');
    const hasExplicitStoryRoute = (franchise.orders || []).some(
      (order) => !isFranchisePlacementOrder(order) && franchiseOrderKind(order) === 'story',
    );
    if (!hasExplicitStoryRoute) return franchiseRouteBlockHTML(franchise, recommended, 'recommended');
    const pairs = franchiseRouteCommonPairs(recommended, story);
    if (
      recommended.length === story.length &&
      pairs.length === recommended.length &&
      pairs.every(([recommendedIndex, storyIndex]) => recommendedIndex === storyIndex)
    ) {
      return franchiseRouteBlockHTML(franchise, recommended, activeRoute);
    }
    const blocks = [];
    let recommendedCursor = 0;
    let storyCursor = 0;
    const branch = (recommendedSteps, storySteps) => {
      if (!recommendedSteps.length && !storySteps.length) return;
      if (
        recommendedSteps.length === storySteps.length &&
        recommendedSteps.every((step, index) => step.id === storySteps[index]?.id)
      ) {
        blocks.push(franchiseRouteBlockHTML(franchise, recommendedSteps, activeRoute));
        return;
      }
      blocks.push(
        `<section class="franchise-flow-fork"><header><span>ROUTE DECISION</span><b>CHOOSE A VIEWING PATH</b></header><div class="franchise-flow-branches"><div class="franchise-flow-branch ${activeRoute === 'recommended' ? 'is-active' : ''}"><button type="button" data-franchise-flow-route="recommended"><span>↙</span> RECOMMENDED</button><div>${franchiseRouteBlockHTML(franchise, recommendedSteps, 'recommended') || '<p>Continue on the shared route.</p>'}</div></div><div class="franchise-flow-branch ${activeRoute === 'story' ? 'is-active' : ''}"><button type="button" data-franchise-flow-route="story"><span>↘</span> STORY CHRONOLOGICAL</button><div>${franchiseRouteBlockHTML(franchise, storySteps, 'story') || '<p>Continue on the shared route.</p>'}</div></div></div></section>`,
      );
    };
    for (const [recommendedIndex, storyIndex] of [...pairs, [recommended.length, story.length]]) {
      branch(recommended.slice(recommendedCursor, recommendedIndex), story.slice(storyCursor, storyIndex));
      if (recommendedIndex < recommended.length && storyIndex < story.length)
        blocks.push(franchiseRouteStepHTML(franchise, recommended[recommendedIndex], state.franchiseRoute));
      recommendedCursor = recommendedIndex + 1;
      storyCursor = storyIndex + 1;
    }
    return blocks.join('') || '<div class="episode-empty">No curated route is available yet.</div>';
  }

  function setFranchiseStepStatus(control) {
    const openRouteSteps = $('#franchiseStack')
      ? $$(
          'details.franchise-route-entry[open], details.franchise-route-group[open]',
          $('#franchiseStack'),
        ).map((entry) => entry.dataset.franchiseStepId)
      : [];
    const franchise = CAT.franchises
      .map(franchiseWithEditorDraft)
      .find((entry) => entry.id === control.dataset.franchiseId);
    if (!franchise) return;
    const step = franchiseGuideSteps(franchise).find((entry) => entry.id === control.dataset.franchiseStepId);
    if (!step) return;
    const status = normalizeWatchStatus(control.dataset.franchiseStatusValue);
    const scopedPrefix = `${franchise.id}:${step.id}`;
    Object.keys(franchiseProgress).forEach((key) => {
      if (key === scopedPrefix || key.startsWith(`${scopedPrefix}:`)) delete franchiseProgress[key];
    });
    if (control.dataset.franchiseStatusSource === 'external') {
      if (status !== 'Not started') franchiseProgress[scopedPrefix] = status;
      save(STORE.franchiseProgress, franchiseProgress);
    } else {
      const item = itemById(control.dataset.franchiseItemId);
      if (!item) return;
      const group = cachedSeriesGroup(item) || (isFeatureFilm(item) ? featureFilmGroup(item) : null);
      const entry = trackerEntryForStep(step, group);
      const isEpisodeScoped =
        Number.isInteger(Number(step.episode)) ||
        Boolean(step.episodeRange) ||
        (Array.isArray(step.episodes) && step.episodes.length > 0);
      if (isEpisodeScoped) {
        const scopedKey = `${franchise.id}:${step.id}`;
        if (['On hold', 'Dropped', 'Skipped'].includes(status)) franchiseProgress[scopedKey] = status;
        else delete franchiseProgress[scopedKey];
        if (entry && ['Not started', 'Watching', 'Watched'].includes(status)) {
          const episodes = trackerStepEpisodes(step, entry);
          if (status === 'Not started')
            episodes.forEach((number) => setEpisodeState(entry, number, 'unwatched'));
          else if (status === 'Watched')
            episodes.forEach((number) => setEpisodeState(entry, number, 'watched'));
          else if (episodes.length) {
            episodes.forEach((number) => {
              if (episodeState(entry, number) === 'watching') setEpisodeState(entry, number, 'unwatched');
            });
            const next = episodes.find((number) => episodeState(entry, number) === 'unwatched');
            if (next) setEpisodeState(entry, next, 'watching');
          }
          save(STORE.episodes, episodeProgress);
        }
        save(STORE.franchiseProgress, franchiseProgress);
      } else {
        progress[item.id] = { ...pFor(item.id), status };
        if (entry && ['Not started', 'Watching', 'Watched'].includes(status)) {
          const episodes = trackerStepEpisodes(step, entry);
          if (status === 'Not started')
            episodes.forEach((number) => setEpisodeState(entry, number, 'unwatched'));
          else if (status === 'Watched')
            episodes.forEach((number) => setEpisodeState(entry, number, 'watched'));
          else if (episodes.length) {
            episodes.forEach((number) => {
              if (episodeState(entry, number) === 'watching') setEpisodeState(entry, number, 'unwatched');
            });
            const next = episodes.find((number) => episodeState(entry, number) === 'unwatched');
            if (next) setEpisodeState(entry, next, 'watching');
          }
          save(STORE.episodes, episodeProgress);
          progress[item.id] = {
            ...pFor(item.id),
            status: status === 'Watched' ? derivedEpisodeStatus(group) : status,
          };
        }
        save(STORE.progress, progress);
      }
    }
    renderAll();
    openRouteSteps.filter(Boolean).forEach((stepId) => {
      const entry = $(`[data-franchise-step-id="${CSS.escape(stepId)}"]`, $('#franchiseStack'));
      if (entry?.matches('details')) entry.open = true;
    });
    toast(`${step.title}: ${status.toLowerCase()}`);
  }

  function franchiseWithEditorDraft(franchise) {
    const draft = editorDrafts[`f:${franchise?.id}`]?.values?.franchise;
    return draft && typeof draft === 'object' ? { ...franchise, ...draft } : franchise;
  }

  function renderUnifiedFranchises({ preserveExpanded = true } = {}) {
    const expanded = preserveExpanded
      ? $$('details.franchise[open]', $('#franchiseStack')).map((details) => details.dataset.franchiseId)
      : [];
    const q = $('#franchiseSearch').value.trim().toLowerCase();
    const guides = CAT.franchises
      .map(franchiseWithEditorDraft)
      .filter(
        (franchise) =>
          franchiseIncludesAnimation(franchise) &&
          (!q ||
            `${franchise.name} ${franchise.summary} ${JSON.stringify(franchise.orders)}`
              .toLowerCase()
              .includes(q)),
      );
    $('#franchiseCount').textContent = `${formatCount(guides.length)} GUIDES`;
    $('#franchiseStack').innerHTML = guides.length
      ? guides
          .map((franchise, index) => {
            const isExpanded = expanded.includes(franchise.id);
            const body = isExpanded
              ? (() => {
                  const steps = franchiseGuideSteps(franchise);
                  const metrics = franchiseGuideProgress(franchise, steps);
                  return `<div class="franchise-body"><div class="franchise-route-heading"><div><span class="franchise-route-kicker">ROUTE STATUS // ${esc(franchise.id || 'CURATED')}</span><strong>WATCH PATH</strong></div><span class="franchise-route-mode">RECOMMENDED ROUTE</span></div><p class="franchise-summary">${esc(franchise.summary)}</p><div class="franchise-progress-grid">${franchiseProgressMetricHTML('ESSENTIAL ROUTE', metrics.essential)}${franchiseProgressMetricHTML('ALL STEPS', metrics.all)}</div><div class="franchise-route-timeline franchise-flow">${franchiseFlowHTML(franchise, steps)}</div></div>`;
                })()
              : '<div class="franchise-body franchise-lazy-body" data-franchise-lazy="1"></div>';
            return `<details class="franchise unified-franchise" data-franchise-id="${esc(franchise.id)}"><summary><span class="franchise-no">${String(index + 1).padStart(2, '0')}<small>GUIDE</small></span><span class="franchise-heading"><span class="franchise-kicker">WATCH ORDER // CURATED PATH</span><h3>${esc(franchise.name)}</h3><span class="franchise-summary-line">${esc(franchise.summary || 'Interactive viewing route')}</span></span><span class="franchise-summary-signal"><small>ROUTE</small><b>READY</b></span><span class="franchise-chevron" aria-hidden="true">+</span></summary>${body}</details>`;
          })
          .join('')
      : '<div class="empty-state">No franchise guides match that search.</div>';
    restoreExpandedFranchises(expanded);
    const stack = $('#franchiseStack');
    $$('[data-progress]', stack).forEach((bar) => {
      bar.style.width = `${Math.max(0, Math.min(100, Number(bar.dataset.progress) || 0))}%`;
    });
    stack.onclick = (event) => {
      const control = event.target.closest('button');
      if (!control || !stack.contains(control)) return;
      if (control.matches('[data-franchise-flow-route]')) {
        event.preventDefault();
        event.stopPropagation();
        const guide = control.closest('details.franchise[data-franchise-id]');
        rememberFranchiseRoute(
          guide?.dataset.franchiseId || '',
          control.dataset.franchiseFlowRoute === 'story' ? 'story' : 'recommended',
        );
        renderUnifiedFranchises();
        return;
      }
      if (control.matches('[data-franchise-detail-id]')) {
        event.preventDefault();
        event.stopPropagation();
        openDetail(control.dataset.franchiseDetailId);
        return;
      }
      if (control.matches('[data-franchise-route-target]')) {
        event.preventDefault();
        event.stopPropagation();
        const target = $(
          `[data-franchise-step-id="${CSS.escape(control.dataset.franchiseRouteTarget)}"]`,
          stack,
        );
        const group = target?.closest('.franchise-route-group');
        if (group) group.open = true;
        (group || target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (group || target)?.classList.add('is-route-focus');
        setTimeout(() => (group || target)?.classList.remove('is-route-focus'), 1400);
        return;
      }
      if (control.matches('[data-franchise-status-picker]')) {
        event.preventDefault();
        event.stopPropagation();
        const current = WATCH_STATUSES.find((value) =>
          control.classList.contains(`status-${watchStatusSlug(value)}`),
        );
        const next =
          WATCH_STATUSES[(Math.max(0, WATCH_STATUSES.indexOf(current)) + 1) % WATCH_STATUSES.length];
        control.dataset.franchiseStatusValue = next;
        setFranchiseStepStatus(control);
        return;
      }
      if (control.matches('[data-franchise-status-value]')) {
        event.preventDefault();
        event.stopPropagation();
        setFranchiseStepStatus(control);
      }
    };
    $$('details.franchise', $('#franchiseStack')).forEach((details) =>
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.franchiseItemsLoaded) return;
        if (details.querySelector('[data-franchise-lazy]')) {
          renderUnifiedFranchises({ preserveExpanded: true });
          return;
        }
        const franchise = CAT.franchises.find((entry) => entry.id === details.dataset.franchiseId);
        if (!franchise) return;
        details.dataset.franchiseItemsLoaded = '1';
        if (franchiseItemsLoaded.has(franchise.id) || franchiseItemsLoading.has(franchise.id)) return;
        franchiseItemsLoading.add(franchise.id);
        void loadFranchiseItems(franchise)
          .then(async (loaded) => {
            const owner = franchiseSeriesOwner(franchise);
            if (owner && canTrackEpisodes(owner) && !cachedSeriesGroup(owner)) {
              try {
                await loadSeriesGroup(owner);
              } catch {}
            }
            if (loaded || owner) franchiseItemsLoaded.add(franchise.id);
            if ((loaded || owner) && details.open) renderUnifiedFranchises();
          })
          .finally(() => franchiseItemsLoading.delete(franchise.id));
      }),
    );
  }

  function renderFranchises(options = {}) {
    renderUnifiedFranchises(options);
  }

  function franchiseBannerHTML(item) {
    const links = franchisesForItem(item);
    if (!links.length) return '';
    return `<div class="detail-franchise-links" aria-label="Franchise guides">${links
      .map(({ franchise, positions }) => {
        const first = positions[0];
        const step = first.step;
        const routePosition = [
          first.orderIndex === 0 && `RECOMMENDED STEP ${first.stepIndex + 1}`,
          first.orderIndex === 1 && `STORY STEP ${first.stepIndex + 1}`,
        ]
          .filter(Boolean)
          .join(' // ');
        return `<button class="detail-franchise-banner" type="button" data-open-franchise-id="${esc(franchise.id)}" data-open-franchise-step="${esc(step.id || '')}" aria-label="Open ${esc(franchise.name)} franchise guide"><span class="detail-franchise-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 6.5h14M5 12h10M5 17.5h14M17 9l3 3-3 3" /></svg></span><span><small>PART OF A FRANCHISE // ${esc(routePosition || 'CURATED ROUTE')}</small><b>${esc(franchise.name)}</b></span><strong>OPEN WATCH ROUTE <i>→</i></strong></button>`;
      })
      .join('')}</div>`;
  }

  function openFranchiseGuide(id, stepId = '') {
    const franchise = CAT.franchises.map(franchiseWithEditorDraft).find((entry) => entry.id === id);
    if (!franchise) return;
    switchTab('franchises');
    $('#franchiseSearch').value = franchise.name;
    saveUIState();
    renderUnifiedFranchises();
    const guide = $(`details.franchise[data-franchise-id="${CSS.escape(id)}"]`, $('#franchiseStack'));
    if (!guide) return;
    guide.open = true;
    state.franchiseFocusStep = stepId;
    syncNavigationUrl();
    const target = stepId && $(`[data-franchise-step-id="${CSS.escape(stepId)}"]`, guide);
    (target || guide).scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (target) {
      target.classList.add('is-route-focus');
      setTimeout(() => target.classList.remove('is-route-focus'), 1800);
    }
  }

  // Server availability and UserList sharing
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
      state.shareLinksEnabled = Boolean(j.sharing?.enabled);
      state.shareServiceUrl = j.sharing?.serviceUrl || '';
      state.turnstileSiteKey = j.sharing?.turnstileSiteKey || '';
      state.updateToken = j.updateToken || '';
      state.catalogWriteEnabled = Boolean(j.catalogWriteEnabled);
      state.catalogToken = j.catalogToken || '';
      try {
        const artworkResponse = await fetch('/api/covers/artwork-index', { cache: 'no-store' });
        const artwork = await artworkResponse.json();
        if (artworkResponse.ok && artwork.ok && artwork.items && typeof artwork.items === 'object')
          installedArtwork = artwork.items;
      } catch {
        // Artwork remains optional when the local server is older than this client.
      }
      const installedCoverPackHash = j.coverPack?.installed?.sha256 || '';
      if (installedCoverPackHash && installedCoverPackHash !== state.installedCoverPackHash) {
        // A new local package must win over cached provider artwork immediately.
        meta = {};
        save(STORE.meta, meta);
      }
      state.installedCoverPackHash = installedCoverPackHash;
      saveUIState();
      $('#securityState').classList.toggle('ok', state.signerCompatible);
      $('#securityState').classList.toggle('bad', !state.signerCompatible);
      $('#securityState').innerHTML = state.signerCompatible
        ? `<b>PORTABLE USERLIST // ${esc(state.signerFormat)}</b><span>Ed25519 signing is ready · key ${esc(state.keyId)}</span>`
        : '<b>SERVER RESTART REQUIRED</b><span>The page is newer than the running server. Restart npm start, then reload.</span>';
      updateStats();
      // Local cover mappings are available immediately, independent of remote
      // provider metadata. Repaint the visible cards before metadata begins.
      refreshArtwork();
      queueMetadata(activeVisibleTitles(), { priority: true });
      pumpMetadata();
      hydrateMissingCustomMetadata();
      checkCoverPack();
      renderOfficialEditorReview();
    } catch {
      state.server = false;
      state.signerCompatible = false;
      state.catalogWriteEnabled = false;
      state.catalogToken = '';
      renderOfficialEditorReview();
      $('#securityState').classList.add('bad');
      $('#securityState').innerHTML =
        '<b>USERLIST SIGNING OFFLINE</b><span>Start the included server to create or verify signed UserList codes.</span>';
    }
  }
  function formatCoverPackBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  function renderCoverPackMode() {
    $$('[data-cover-mode]').forEach((button) => {
      const active = button.dataset.coverMode === state.coverArtworkMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
  }
  function renderCatalogUpdateMode() {
    $$('[data-catalog-update-mode]').forEach((button) => {
      const active = button.dataset.catalogUpdateMode === state.catalogUpdateMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
  }
  function setCatalogUpdateMode(mode) {
    if (!['auto', 'manual'].includes(mode)) return;
    state.catalogUpdateMode = mode;
    renderCatalogUpdateMode();
    saveUIState();
    if (mode === 'auto') {
      void syncCatalogFromCoverStorage({ manual: true });
      toast('Library updates set to automatic');
    } else toast('Library updates will only run when you check');
  }
  function setCoverPackMode(mode) {
    if (!['never', 'own', 'download'].includes(mode)) return;
    state.coverArtworkMode = mode;
    renderCoverPackMode();
    if (mode === 'download') {
      state.dismissedCoverPackHash = '';
      checkCoverPack();
      toast('Official cover-pack updates will be offered for approval');
    } else {
      availableCoverPack = null;
      if ($('#coverPackDialog').open) $('#coverPackDialog').close();
      toast(
        mode === 'own'
          ? 'Using locally installed cover artwork only'
          : 'Cover-pack checks and downloads are disabled',
      );
    }
    saveUIState();
  }
  function showCoverPackDialog() {
    if (
      state.coverArtworkMode !== 'download' ||
      !availableCoverPack ||
      state.dismissedCoverPackHash === availableCoverPack.sha256 ||
      $('#ratingFormatDialog').open ||
      $('#detailDialog').open
    )
      return;
    const dialog = $('#coverPackDialog');
    const packageId = String(availableCoverPack.version || '').replace(/^manager-/, '');
    $('#coverPackVersion').textContent = packageId ? `#${packageId.slice(0, 8)}` : 'new';
    const reviewedOnly = availableCoverPack.packageMode === 'REVIEWED_ONLY';
    const newCoverCountKnown = Number.isSafeInteger(availableCoverPack.newCoverCount);
    $('#coverPackCount').textContent = formatCount(
      reviewedOnly && newCoverCountKnown
        ? availableCoverPack.newCoverCount
        : availableCoverPack.coverCount || 0,
    );
    $('#coverPackCountLabel').textContent =
      reviewedOnly && newCoverCountKnown ? 'NEW COVERS' : 'COVERS IN PACKAGE';
    $('#coverPackSize').textContent = formatCoverPackBytes(availableCoverPack.bytes);
    $('#coverPackDialogTitle').textContent = reviewedOnly
      ? newCoverCountKnown
        ? `${formatCount(availableCoverPack.newCoverCount)} NEW COVERS ARE READY`
        : 'A REVIEWED COVER UPDATE IS READY'
      : 'A COVER UPDATE IS READY';
    $('#coverPackStatus').textContent = reviewedOnly
      ? newCoverCountKnown
        ? `This package adds ${formatCount(availableCoverPack.newCoverCount)} cover records that are not already installed. It replaces your previous cover package only after download, checksum and file checks pass.`
        : 'This package does not include a title list, so its exact number of new covers will be calculated during installation. It replaces your previous cover package only after download, checksum and file checks pass.'
      : 'The archive is verified before installation. Your current cover package is replaced only after every file check passes.';
    if (!dialog.open) dialog.showModal();
  }
  async function checkCoverPack() {
    if (!state.server || state.coverArtworkMode !== 'download') return;
    try {
      const response = await fetch('/api/covers/status', { cache: 'no-store' });
      const status = await response.json();
      if (!response.ok || !status.ok || !status.updateAvailable || !status.available) return;
      availableCoverPack = status.available;
      setTimeout(showCoverPackDialog, 420);
    } catch {
      // Cover checks are advisory and must never block the library.
    }
  }
  async function installCoverPack() {
    const button = $('#installCoverPackBtn');
    const status = $('#coverPackStatus');
    const progress = $('#coverPackProgress');
    const phase = $('#coverPackPhase');
    const percent = $('#coverPackPercent');
    const bar = $('#coverPackProgressBar');
    const updateProgress = (detail = {}) => {
      const value = Math.max(0, Math.min(100, Number(detail.percent) || 0));
      progress.hidden = false;
      phase.textContent = String(detail.phase || 'WORKING').replaceAll('_', ' ');
      percent.textContent = `${value}%`;
      bar.style.width = `${value}%`;
      if (detail.message) status.textContent = detail.message;
    };
    button.disabled = true;
    button.textContent = 'DOWNLOADING & VERIFYING…';
    updateProgress({ phase: 'STARTING', percent: 1, message: 'Starting the verified cover update…' });
    try {
      const response = await fetch('/api/covers/install', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'cover-pack-install-failed');
      const jobId = result.job?.id;
      if (!jobId) throw new Error('cover-pack-install-job-missing');
      const poll = async () => {
        const jobResponse = await fetch('/api/covers/install-status', { cache: 'no-store' });
        const jobResult = await jobResponse.json();
        const job = jobResult.job;
        if (!jobResponse.ok || !job || job.id !== jobId)
          throw new Error('cover-pack-install-status-unavailable');
        updateProgress(job.detail);
        if (job.status === 'RUNNING') return setTimeout(() => void poll(), 450);
        if (job.status !== 'COMPLETED') throw new Error(job.detail?.message || 'cover-pack-install-failed');
        // Existing metadata is deliberately invalidated: otherwise a month-old
        // provider image in localStorage can hide a just-installed local cover.
        meta = {};
        save(STORE.meta, meta);
        updateProgress({
          phase: 'COMPLETE',
          percent: 100,
          message: Number.isSafeInteger(job.detail?.result?.available?.newCoverCount)
            ? `Installed. ${formatCount(job.detail.result.available.newCoverCount)} new covers added — refreshing…`
            : 'Installed. Refreshing your covers…',
        });
        setTimeout(() => location.reload(), 450);
      };
      await poll();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'INSTALL NEW COVERS';
      updateProgress({
        phase: 'INSTALLATION STOPPED',
        percent: 0,
        message: `Installation failed: ${error.message}`,
      });
    }
  }
  async function checkForUpdates({ autoInstall = false } = {}) {
    try {
      const response = await fetch('/api/version', { cache: 'no-store' });
      if (!response.ok) return false;
      const release = await response.json();
      if (!release.ok || !release.updateAvailable || !release.latest || !release.releaseUrl) return false;
      if (load(STORE.dismissedUpdate, '') === release.latest) return false;
      const releaseUrl = new URL(release.releaseUrl);
      if (
        releaseUrl.protocol !== 'https:' ||
        releaseUrl.hostname !== 'github.com' ||
        !releaseUrl.pathname.startsWith('/Firehawk52/ultimate-animation-index/releases/tag/')
      )
        return false;
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
      if (autoInstall && state.updateToken) {
        await installAvailableUpdate();
        return true;
      }
      return false;
    } catch {
      // Update checks are advisory and must never interrupt the local catalog.
      return false;
    }
  }
  async function syncCatalogFromCoverStorage({ manual = false } = {}) {
    if (!manual && state.catalogUpdateMode !== 'auto') return false;
    if (
      !state.server ||
      !state.catalogWriteEnabled ||
      !state.catalogToken ||
      (!manual && document.querySelector('dialog[open]'))
    )
      return false;
    try {
      const response = await fetch('/api/catalog/sync', {
        method: 'POST',
        headers: { 'X-UAI-Catalog-Token': state.catalogToken },
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        if (manual) toast('Library check is temporarily unavailable — your local library was not changed');
        return false;
      }
      if (!result.changed) {
        if (manual)
          toast(
            result.conflicts
              ? `Library is up to date · ${result.conflicts} local change${result.conflicts === 1 ? '' : 's'} kept`
              : 'Library is already up to date',
          );
        return false;
      }
      toast(
        result.conflicts
          ? `Library updated · ${result.conflicts} local change${result.conflicts === 1 ? '' : 's'} kept`
          : 'Library updated',
      );
      setTimeout(() => location.reload(), manual ? 700 : 900);
      return true;
    } catch {
      return false;
    }
  }
  async function hourlyLibrarySync() {
    const updating = await checkForUpdates({ autoInstall: true });
    if (updating) return;
    await syncCatalogFromCoverStorage();
    checkCoverPack();
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
      adds = customTitles.filter((x) => x.addedByMe).length,
      completed = shareableCompletedTitleIds().length;
    $('#userListSummary').innerHTML =
      `<div><b>${rec}</b><span>RECOMMENDED</span></div><div><b>${no}</b><span>NOT RECOMMENDED</span></div><div><b>${completed}</b><span>FULLY WATCHED</span></div><div><b>${adds}</b><span>ADDED TITLES</span></div>`;
    renderBackupSummary();
    renderSources();
  }

  function shareableCompletedTitleIds() {
    return canonicalItems()
      .filter((item) => {
        if (isFeatureFilm(item)) return pFor(item.id).status === 'Watched';
        const group = cachedSeriesGroup(item);
        if (!group) return false;
        const stats = groupEpisodeStats(group);
        return stats.total > 0 && stats.watched === stats.total;
      })
      .map((item) => item.id);
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
      editorDrafts,
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

  async function importUserBackup(button) {
    const result = $('#backupResult');
    result.className = 'import-result';
    result.textContent = '';
    if (!selectedBackup) {
      result.classList.add('bad');
      result.textContent = 'Choose and validate a backup first.';
      return;
    }
    const mode = $('#backupImportMode').value;
    if (mode === 'replace' && !confirmWithButton(button, { confirmText: 'CONFIRM REPLACE DATA' })) return;
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

  let editorSelectedId = '';
  let editorSelectedFranchiseId = '';
  let editorMission = '';
  let editorPane = 'identity';
  let editorSummaryTranslations = {};
  let pendingOfficialEditorReview = '';
  let officialEditorReviewApproved = false;
  const EDITOR_PREFIX = 'UAIE.';

  const EDITOR_MISSION_COPY = {
    'new-title': {
      kicker: 'TITLE CREATION',
      help: 'Build a local title. Start with its identity, then add the source, artwork and episode data it needs.',
    },
    'edit-title': {
      kicker: 'TITLE CORRECTION',
      help: 'Find the catalog title first. Its editable fields will open here without changing your official catalog.',
    },
    'new-franchise': {
      kicker: 'ROUTE CREATION',
      help: 'Name the guide, explain its route, then add connected titles and precise episode placements.',
    },
    'edit-franchise': {
      kicker: 'ROUTE CORRECTION',
      help: 'Find the existing franchise guide. Edit its route while keeping every local change review-ready.',
    },
  };

  function setEditorMission(mission = '') {
    editorMission = mission;
    $$('[data-editor-mission]').forEach((button) =>
      button.classList.toggle('is-active', button.dataset.editorMission === mission),
    );
    const copy = EDITOR_MISSION_COPY[mission];
    const isTitleSearch = mission === 'edit-title';
    const isFranchiseSearch = mission === 'edit-franchise';
    const searchDock = $('#editorSearchDock');
    searchDock.hidden = !(isTitleSearch || isFranchiseSearch);
    $('#editorTitleSearchGroup').hidden = !isTitleSearch;
    $('#editorFranchiseSearchGroup').hidden = !isFranchiseSearch;
    $('#editorTitleResults').hidden = !isTitleSearch;
    $('#editorFranchiseResults').hidden = !isFranchiseSearch;
    $('#editorSearchTitle').textContent = isFranchiseSearch
      ? 'SEARCH FRANCHISE GUIDES'
      : 'SEARCH THE CATALOG';
    $('#editorSearchIndex').textContent = isFranchiseSearch ? '04' : '02';
    if (copy) {
      $('#editorSidebarKicker').textContent = copy.kicker;
      $('#editorSidebarHelp').textContent = copy.help;
    } else {
      $('#editorSidebarKicker').textContent = 'WORKSPACE';
      $('#editorSidebarHelp').textContent =
        'Choose an assignment above, then find the record you want to work on.';
    }
  }

  function setEditorPane(pane) {
    editorPane = pane;
    const franchiseOnly = Boolean(editorSelectedFranchiseId);
    $$('[data-editor-pane-group]').forEach((element) => {
      element.hidden = element.dataset.editorPaneGroup !== pane;
    });
    $$('[data-editor-pane]', $('#editorWorkflowNav')).forEach((button) => {
      const allowed = !franchiseOnly || button.dataset.editorPane === 'franchise';
      button.hidden = !allowed;
      button.classList.toggle('active', allowed && button.dataset.editorPane === pane);
    });
  }

  function focusEditorSearch(id) {
    const input = $(id);
    if (!input) return;
    input.closest('.field-label')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => input.focus(), 180);
  }

  function startEditorMission(mission) {
    setEditorMission(mission);
    if (mission === 'new-title') return openEditor();
    if (mission === 'new-franchise') return openNewFranchiseEditor();
    if (mission === 'edit-title') {
      editorSelectedId = '';
      editorSelectedFranchiseId = '';
      $('#editorEmpty').hidden = false;
      $('#editorForm').hidden = true;
      return focusEditorSearch('#editorTitleSearch');
    }
    if (mission === 'edit-franchise') {
      editorSelectedId = '';
      editorSelectedFranchiseId = '';
      $('#editorEmpty').hidden = false;
      $('#editorForm').hidden = true;
      if (!CAT.franchises.length)
        void loadCatalogEntity('franchises').then(() =>
          renderEditorFranchiseSearch($('#editorFranchiseSearch').value),
        );
      return focusEditorSearch('#editorFranchiseSearch');
    }
  }

  function openEditorConsole() {
    editorSelectedId = '';
    editorSelectedFranchiseId = '';
    setEditorMission('');
    switchTab('editor');
    $('.editor-workspace').classList.remove('is-franchise-workspace');
    $('#editorEmpty').hidden = false;
    $('#editorForm').hidden = true;
    renderEditor();
  }

  // ISO 639-1 is the shared language database for local summary translations.
  // Search accepts a user's local language name or a code, but only neutral
  // English labels and stable codes are rendered or saved.
  const SUMMARY_LANGUAGE_CODES =
    `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`.split(
      ' ',
    );
  let editorSummaryLanguageDraftId = 0;

  function normalizeSummaryLocale(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 16);
  }

  function summaryLanguageName(locale) {
    const normalized = normalizeSummaryLocale(locale);
    if (!normalized) return 'Language';
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized) || normalized.toUpperCase();
    } catch {
      return normalized.toUpperCase();
    }
  }

  function isKnownSummaryLanguage(locale) {
    return SUMMARY_LANGUAGE_CODES.includes(normalizeSummaryLocale(locale));
  }

  function summaryLanguageMatches(query) {
    const needle = norm(query);
    if (!needle) return [];
    return SUMMARY_LANGUAGE_CODES.map((locale) => {
      let localName = locale;
      let englishName = locale;
      try {
        localName =
          new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(locale) || locale;
        englishName = new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) || locale;
      } catch {}
      return { locale, localName, englishName };
    })
      .filter(({ locale, localName, englishName }) =>
        norm(`${locale} ${localName} ${englishName}`).includes(needle),
      )
      .slice(0, 8);
  }

  function normalizeSummaryTranslations(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(
      Object.entries(source)
        .map(([locale, summary]) => [normalizeSummaryLocale(locale), String(summary || '').trim()])
        .filter(([locale, summary]) => isKnownSummaryLanguage(locale) && summary),
    );
  }

  function titleSummaryData(item, metadata = {}) {
    const primaryLanguage = 'en';
    const primaryText = String(
      item?.description || metadata.description || item?.sourceSynopsis || '',
    ).trim();
    const translations = {
      ...normalizeSummaryTranslations(metadata.summaryTranslations),
      ...normalizeSummaryTranslations(item?.summaryTranslations),
    };
    delete translations[primaryLanguage];
    const selected =
      normalizeSummaryLocale(state.summaryLanguage) || normalizeSummaryLocale(translationSettings.locale);
    const activeLanguage = translations[selected] ? selected : primaryLanguage;
    const text = activeLanguage === primaryLanguage ? primaryText : translations[activeLanguage];
    const languages = [
      ...(primaryText ? [{ locale: primaryLanguage, text: primaryText }] : []),
      ...Object.entries(translations).map(([locale, summary]) => ({ locale, text: summary })),
    ];
    return { primaryLanguage, activeLanguage, text, languages };
  }

  function detailSummaryHTML(summary) {
    if (!summary.text)
      return '<p class="metadata-wait">A summary will appear when metadata is available.</p>';
    const languageChips =
      summary.languages.length > 1
        ? `<div class="summary-language-chips" role="group" aria-label="Summary language">${summary.languages
            .map(
              ({ locale }) =>
                `<button type="button" class="${locale === summary.activeLanguage ? 'active' : ''}" data-summary-language="${esc(locale)}" aria-pressed="${locale === summary.activeLanguage}">${esc(summaryLanguageName(locale))}</button>`,
            )
            .join('')}</div>`
        : '';
    return `<section class="detail-summary"><header><h4>Summary</h4>${languageChips}</header><p id="detailSummaryText">${esc(summary.text)}</p></section>`;
  }

  function renderEditorSummaryTranslations() {
    const mount = $('#editorSummaryTranslationBuilder');
    if (!mount) return;
    const primaryLocale = 'en';
    const activeLocales = Object.keys(editorSummaryTranslations);
    mount.innerHTML = activeLocales.length
      ? activeLocales
          .map((locale) => {
            const known = isKnownSummaryLanguage(locale);
            const label = known ? summaryLanguageName(locale) : 'CHOOSE A LANGUAGE';
            return `<article class="editor-summary-translation"><div class="editor-summary-translation-head"><b>${esc(label)}</b><button type="button" data-editor-summary-remove-language="${esc(locale)}">REMOVE</button></div><label class="field-label editor-language-finder">LANGUAGE<input data-editor-summary-language="${esc(locale)}" value="${known ? esc(locale) : ''}" maxlength="80" placeholder="Type a language name or code"><span data-editor-language-status="${esc(locale)}">${known ? `${esc(summaryLanguageName(locale))} // ${esc(locale.toUpperCase())}` : 'Start typing to search every supported language.'}</span><div class="editor-language-matches" data-editor-language-matches="${esc(locale)}"></div></label><label class="field-label">SUMMARY<textarea data-editor-summary-text="${esc(locale)}" maxlength="12000" placeholder="Write the ${esc(label.toLowerCase())} summary…">${esc(editorSummaryTranslations[locale])}</textarea></label></article>`;
          })
          .join('')
      : '<div class="editor-summary-empty">No additional summaries yet. Add a language when a translated summary is available.</div>';
    $$('[data-editor-summary-language]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        const previous = input.dataset.editorSummaryLanguage;
        const matches = summaryLanguageMatches(input.value).filter(
          ({ locale }) =>
            locale !== primaryLocale && (locale === previous || !editorSummaryTranslations[locale]),
        );
        const target = $(`[data-editor-language-matches="${CSS.escape(previous)}"]`, mount);
        if (!target) return;
        target.innerHTML = matches
          .map(
            ({ locale, localName, englishName }) =>
              `<button type="button" data-editor-summary-language-match="${esc(locale)}" data-editor-summary-language-from="${esc(previous)}"><b>${esc(englishName)}</b><span>${esc(locale.toUpperCase())}</span></button>`,
          )
          .join('');
        $$('[data-editor-summary-language-match]', target).forEach((button) =>
          button.addEventListener('click', () => {
            const from = button.dataset.editorSummaryLanguageFrom;
            const to = button.dataset.editorSummaryLanguageMatch;
            const summary = editorSummaryTranslations[from] || '';
            delete editorSummaryTranslations[from];
            editorSummaryTranslations[to] = summary;
            renderEditorSummaryTranslations();
          }),
        );
      }),
    );
    $$('[data-editor-summary-text]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        editorSummaryTranslations[input.dataset.editorSummaryText] = input.value;
      }),
    );
    $$('[data-editor-summary-remove-language]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        delete editorSummaryTranslations[button.dataset.editorSummaryRemoveLanguage];
        renderEditorSummaryTranslations();
      }),
    );
  }

  function addEditorSummaryTranslation() {
    const key = `__summary_language_${++editorSummaryLanguageDraftId}`;
    editorSummaryTranslations[key] = '';
    renderEditorSummaryTranslations();
    $(`[data-editor-summary-language="${CSS.escape(key)}"]`)?.focus();
  }

  function editorValuesFor(item) {
    const draft = editorDrafts[item?.id]?.values || {};
    const metadata = meta[item?.id]?.data || {};
    const linkedFranchise =
      item &&
      CAT.franchises.find((franchise) =>
        franchise.orders?.some((order) =>
          order.steps?.some((step) => franchiseTitleKey(step.title) === franchiseTitleKey(item.title)),
        ),
      );
    return {
      title: item?.title || '',
      year: Number(item?.year) || 0,
      type: item?.type || 'Series',
      origin: item?.origin || '',
      aliases: Array.isArray(item?.aliases) ? item.aliases : [],
      genres: item?.genres || '',
      description: item?.description || metadata.description || '',
      summaryTranslations: normalizeSummaryTranslations({
        ...normalizeSummaryTranslations(metadata.summaryTranslations),
        ...normalizeSummaryTranslations(item?.summaryTranslations),
      }),
      scores: item?.scores || {},
      content: item?.content || {},
      awards: item?.awards || item?.award || [],
      lookupTitle: item?.lookupTitle || item?.title || '',
      sourceUrl: item?.sourceUrl || metadata.siteUrl || '',
      coverUrl: item?.coverUrl || '',
      coverAsset: null,
      watch_note: item?.watch_note || '',
      caveat: item?.caveat || '',
      episodes: item?.editorEpisodes || [],
      franchise: item?.editorFranchise || (linkedFranchise ? structuredClone(linkedFranchise) : null),
      ...draft,
    };
  }

  function editorSnapshot(item) {
    const values = editorValuesFor(item);
    return structuredClone(values);
  }

  function renderEditorDraftList() {
    const mounts = ['#editorDraftList', '#editorPackageDraftList']
      .map((selector) => $(selector))
      .filter(Boolean);
    if (!mounts.length) return;
    const rows = Object.entries(editorDrafts);
    const draftCount = $('#editorPackageDraftCount');
    const copyPackage = $('#editorCopyExport');
    if (draftCount)
      draftCount.textContent = `${formatCount(rows.length)} ${rows.length === 1 ? 'DRAFT' : 'DRAFTS'} READY`;
    if (copyPackage) copyPackage.disabled = !$('#editorExportCode').value;
    const markup = rows.length
      ? rows
          .map(
            ([id, draft]) =>
              `<article class="editor-draft-entry"><button type="button" data-editor-draft-id="${esc(id)}"><b>${esc(draft.values?.title || draft.values?.franchise?.name || id)}</b><small>${esc((draft.updatedAt || '').slice(0, 10))} // ${id.startsWith('f:') ? 'FRANCHISE ROUTE' : draft.isNew ? 'NEW TITLE' : 'LOCAL OVERRIDE'}</small></button><button type="button" class="editor-draft-delete" data-editor-draft-delete="${esc(id)}" aria-label="Delete draft for ${esc(draft.values?.title || draft.values?.franchise?.name || id)}">REMOVE</button></article>`,
          )
          .join('')
      : '<span class="editor-no-drafts">No local drafts yet.</span>';
    mounts.forEach((mount) => {
      mount.innerHTML = markup;
      $$('[data-editor-draft-id]', mount).forEach((button) =>
        button.addEventListener('click', () =>
          button.dataset.editorDraftId.startsWith('f:')
            ? openFranchiseEditor(button.dataset.editorDraftId.slice(2))
            : openEditor(button.dataset.editorDraftId),
        ),
      );
      $$('[data-editor-draft-delete]', mount).forEach((button) =>
        button.addEventListener('click', () => {
          if (!confirmWithButton(button, { confirmText: 'CONFIRM REMOVE' })) return;
          deleteEditorDraft(button.dataset.editorDraftDelete);
        }),
      );
    });
  }

  function deleteEditorDraft(id) {
    const draft = editorDrafts[id];
    if (!draft) return;
    const title = draft.values?.title || draft.values?.franchise?.name || id;
    const newTitleNotice = draft.isNew ? ' This also removes the local title created by this draft.' : '';
    delete editorDrafts[id];
    if (draft.isNew) {
      customTitles = customTitles.filter((item) => item.id !== id);
      save(STORE.custom, customTitles);
    }
    save(STORE.editorDrafts, editorDrafts);
    $('#editorExportCode').value = '';
    $('#editorPackageStatus').textContent = 'Draft removed. Generate a new package when you are ready.';
    if (editorSelectedFranchiseId && `f:${editorSelectedFranchiseId}` === id) openEditorConsole();
    else if (editorSelectedId === id) openEditor(id);
    renderEditorDraftList();
    renderAll();
    toast('Local draft deleted');
  }

  function renderEditorFranchiseSearch(query = '') {
    const mount = $('#editorFranchiseResults');
    if (!mount) return;
    const needle = norm(query);
    if (!needle) {
      mount.innerHTML =
        '<span class="editor-search-hint">Type a franchise name to find its route guide.</span>';
      return;
    }
    const guides = CAT.franchises
      .filter((franchise) => !needle || norm(`${franchise.name} ${franchise.summary}`).includes(needle))
      .slice(0, 20);
    mount.innerHTML = guides.length
      ? guides
          .map(
            (franchise) =>
              `<button type="button" data-editor-open-franchise="${esc(franchise.id)}"><b>${esc(franchise.name)}</b><small>${formatCount(franchise.orders?.reduce((total, order) => total + (order.steps || []).length, 0) || 0)} route steps</small></button>`,
          )
          .join('')
      : '<span class="editor-no-drafts">No franchise guides found.</span>';
    $$('[data-editor-open-franchise]', mount).forEach((button) =>
      button.addEventListener('click', () => openFranchiseEditor(button.dataset.editorOpenFranchise)),
    );
  }

  function editorTitleResults(query = '') {
    const needle = norm(query);
    return canonicalItems()
      .filter((item) => !needle || norm(`${item.title} ${(item.aliases || []).join(' ')}`).includes(needle))
      .slice(0, 30);
  }

  function renderEditorSearch(query = '') {
    const mount = $('#editorTitleResults');
    if (!mount) return;
    if (!norm(query)) {
      mount.innerHTML =
        '<span class="editor-search-hint">Type a title or alias to search the local catalog.</span>';
      return;
    }
    mount.innerHTML = editorTitleResults(query)
      .map((item) => {
        const cover = localArtworkFor(item);
        const initials = item.title
          .split(/\s+/)
          .slice(0, 2)
          .map((word) => word[0])
          .join('');
        return `<button type="button" data-editor-open-id="${esc(item.id)}"><span class="editor-result-cover">${cover ? `<img src="${esc(cover)}" alt="">` : `<i>${esc(initials)}</i>`}</span><span class="editor-result-copy"><b>${esc(item.title)}</b><small>${esc([item.year || '', item.type || ''].filter(Boolean).join(' // '))}</small><em>${item.custom ? 'LOCAL TITLE' : 'CATALOG TITLE'} // OPEN EDITOR</em></span><span class="editor-result-index">${formatRank(item.rank) || 'LOCAL'}</span></button>`;
      })
      .join('');
    $$('[data-editor-open-id]', mount).forEach((button) =>
      button.addEventListener('click', () => openEditor(button.dataset.editorOpenId)),
    );
  }

  function editorNumericValue(id) {
    const raw = $(`#${id}`)?.value;
    if (raw === '' || raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }

  function syncEditorStructuredMetadata() {
    const scores = $('#editorScores').value.trim() ? JSON.parse($('#editorScores').value) : {};
    const content = $('#editorContent').value.trim() ? JSON.parse($('#editorContent').value) : {};
    const scoreFields = [
      ['overall', 'editorScoreOverall'],
      ['production', 'editorScoreProduction'],
      ['story', 'editorScoreStory'],
      ['emotional', 'editorScoreEmotional'],
    ];
    const contentFields = [
      ['sex', 'editorContentSex'],
      ['nudity', 'editorContentNudity'],
      ['violence', 'editorContentViolence'],
      ['gore', 'editorContentGore'],
      ['disturbing', 'editorContentDisturbing'],
    ];
    scoreFields.forEach(([key, id]) => {
      const value = editorNumericValue(id);
      if (value === undefined) delete scores[key];
      else scores[key] = value;
    });
    contentFields.forEach(([key, id]) => {
      const value = editorNumericValue(id);
      if (value === undefined) delete content[key];
      else content[key] = value;
    });
    $('#editorScores').value = Object.keys(scores).length ? JSON.stringify(scores) : '';
    $('#editorContent').value = Object.keys(content).length ? JSON.stringify(content) : '';
  }

  function editorAwardsValue() {
    const raw = $('#editorAwards')?.value.trim();
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('Awards must be a list.');
    return value.map((award) => ({
      ...award,
      name: String(award?.name || award?.program || ''),
      year: Number(award?.year) || '',
      result: String(award?.result || 'Winner'),
    }));
  }

  function writeEditorAwards(value) {
    $('#editorAwards').value = value.length ? JSON.stringify(value) : '';
    renderEditorAwardBuilder();
  }

  function renderEditorAwardBuilder() {
    const mount = $('#editorAwardBuilder');
    if (!mount) return;
    let awards;
    try {
      awards = editorAwardsValue();
    } catch (error) {
      mount.innerHTML = `<div class="editor-builder-error">${esc(error.message)}</div>`;
      return;
    }
    mount.innerHTML = awards.length
      ? awards
          .map(
            (award, index) =>
              `<div class="editor-award-row"><label class="field-label">AWARD<input data-editor-award-field="name" data-editor-award-index="${index}" value="${esc(award.name)}" placeholder="Award or programme"></label><label class="field-label">YEAR<input data-editor-award-field="year" data-editor-award-index="${index}" type="number" min="1800" max="2200" value="${esc(award.year)}"></label><label class="field-label">RESULT<select data-editor-award-field="result" data-editor-award-index="${index}">${['Winner', 'Nominee', 'Shortlist', 'Official selection'].map((result) => `<option ${award.result === result ? 'selected' : ''}>${result}</option>`).join('')}</select></label><button class="text-button danger" type="button" data-editor-award-remove="${index}">REMOVE</button></div>`,
          )
          .join('')
      : '<div class="editor-award-empty">No awards added. Add only awards you can verify.</div>';
    $$('[data-editor-award-field]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        const value = editorAwardsValue();
        value[Number(input.dataset.editorAwardIndex)][input.dataset.editorAwardField] = input.value;
        $('#editorAwards').value = JSON.stringify(value);
      }),
    );
    $$('[data-editor-award-remove]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const value = editorAwardsValue();
        value.splice(Number(button.dataset.editorAwardRemove), 1);
        writeEditorAwards(value);
      }),
    );
  }

  function fillEditor(item) {
    const values = editorValuesFor(item);
    const franchiseOnly = Boolean(editorSelectedFranchiseId);
    $('#editorEmpty').hidden = true;
    $('#editorForm').hidden = false;
    $('.editor-workspace').classList.toggle('is-franchise-workspace', franchiseOnly);
    const titleOnlyIds = [
      'editorTitle',
      'editorYear',
      'editorType',
      'editorOrigin',
      'editorAliases',
      'editorGenres',
      'editorDescription',
      'editorSummaryPanel',
      'editorScores',
      'editorContent',
      'editorAwards',
      'editorLookupTitle',
      'editorSourceUrl',
      'editorCoverUrl',
      'editorWatchNote',
      'editorCaveat',
      'editorEpisodes',
      'editorEpisodeBuilder',
    ];
    titleOnlyIds.forEach((id) => {
      const element = $(`#${id}`);
      const container = element?.closest('.field-label') || element;
      if (container) container.hidden = franchiseOnly;
    });
    $('.editor-metadata-panel').hidden = franchiseOnly;
    $('.editor-awards-panel').hidden = franchiseOnly;
    $$('[data-editor-title-section]').forEach((element) => (element.hidden = franchiseOnly));
    $('#editorTitle').required = !franchiseOnly;
    $('#editorRecordKind').textContent = franchiseOnly
      ? editorDrafts[`f:${editorSelectedFranchiseId}`]
        ? 'LOCAL FRANCHISE DRAFT'
        : 'FRANCHISE ROUTE'
      : item.id && editorDrafts[item.id]?.isNew
        ? 'NEW LOCAL TITLE'
        : item.id
          ? 'LOCAL OVERRIDE'
          : 'NEW LOCAL TITLE';
    $('#editorRecordTitle').textContent = franchiseOnly
      ? values.franchise?.name || 'NEW FRANCHISE ROUTE'
      : values.title || 'NEW TITLE';
    $('#editorDraftState').textContent = editorDrafts[
      franchiseOnly ? `f:${editorSelectedFranchiseId}` : item.id
    ]
      ? 'DRAFT SAVED'
      : franchiseOnly
        ? 'ROUTE READY'
        : 'CATALOG VALUES';
    $('#editorTitle').value = values.title;
    $('#editorYear').value = values.year || '';
    $('#editorType').value = values.type;
    $('#editorOrigin').value = values.origin;
    $('#editorAliases').value = values.aliases.join(', ');
    $('#editorGenres').value = values.genres;
    $('#editorDescription').value = values.description;
    editorSummaryTranslations = normalizeSummaryTranslations(values.summaryTranslations);
    renderEditorSummaryTranslations();
    $('#editorScores').value = Object.keys(values.scores || {}).length
      ? JSON.stringify(values.scores, null, 2)
      : '';
    $('#editorContent').value = Object.keys(values.content || {}).length
      ? JSON.stringify(values.content, null, 2)
      : '';
    $('#editorAwards').value =
      Array.isArray(values.awards) && values.awards.length ? JSON.stringify(values.awards, null, 2) : '';
    $('#editorScoreOverall').value = values.scores?.overall ?? '';
    $('#editorScoreProduction').value = values.scores?.production ?? '';
    $('#editorScoreStory').value = values.scores?.story ?? '';
    $('#editorScoreEmotional').value = values.scores?.emotional ?? '';
    $('#editorContentSex').value = values.content?.sex ?? '';
    $('#editorContentNudity').value = values.content?.nudity ?? '';
    $('#editorContentViolence').value = values.content?.violence ?? '';
    $('#editorContentGore').value = values.content?.gore ?? '';
    $('#editorContentDisturbing').value = values.content?.disturbing ?? '';
    $('#editorLookupTitle').value = values.lookupTitle;
    $('#editorSourceUrl').value = values.sourceUrl;
    $('#editorCoverUrl').value = values.coverUrl || '';
    renderEditorCoverPreview(values.coverUrl, values.coverAsset);
    $('#editorCoverFile').value = '';
    if (values.coverAsset) $('#editorCoverFile').dataset.asset = JSON.stringify(values.coverAsset);
    else delete $('#editorCoverFile').dataset.asset;
    $('#editorCoverFile').onchange = () => {
      const file = $('#editorCoverFile').files?.[0];
      if (!file) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 600 * 1024) {
        $('#editorCoverFile').value = '';
        toast('Choose a PNG, JPG or WEBP image up to 600 KB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        $('#editorCoverFile').dataset.asset = JSON.stringify({
          name: file.name,
          type: file.type,
          data: reader.result,
        });
        $('#editorCoverUrl').value = '';
        renderEditorCoverPreview('', JSON.parse($('#editorCoverFile').dataset.asset));
      };
      reader.readAsDataURL(file);
    };
    $('#editorCoverRemove').onclick = () => {
      $('#editorCoverUrl').value = '';
      $('#editorCoverFile').value = '';
      delete $('#editorCoverFile').dataset.asset;
      renderEditorCoverPreview('', null);
    };
    $('#editorWatchNote').value = values.watch_note;
    $('#editorCaveat').value = values.caveat;
    $('#editorEpisodes').value = values.episodes?.length ? JSON.stringify(values.episodes, null, 2) : '';
    $('#editorFranchise').value = values.franchise ? JSON.stringify(values.franchise, null, 2) : '';
    $('#editorFranchiseName').value = values.franchise?.name || '';
    $('#editorFranchiseSummary').value = values.franchise?.summary || '';
    renderEditorEpisodeBuilder();
    renderEditorFranchiseBuilder();
    renderEditorAwardBuilder();
    setEditorPane(franchiseOnly ? 'franchise' : editorPane === 'franchise' ? 'identity' : editorPane);
  }

  function renderEditorCoverPreview(url = '', asset = null) {
    const mount = $('#editorCoverPreview');
    if (!mount) return;
    const source = asset?.data || String(url || '').trim();
    mount.innerHTML = source
      ? `<img src="${esc(source)}" alt="Cover submission preview"><span>${esc(asset?.name || 'HTTPS cover source')}</span>`
      : 'No cover correction attached.';
  }

  function editorFranchiseValue() {
    const raw = $('#editorFranchise')?.value.trim();
    if (!raw) return { name: '', summary: '', orders: [] };
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Franchise must be an object.');
      return {
        ...value,
        name: String(value.name || ''),
        summary: String(value.summary || ''),
        orders: Array.isArray(value.orders)
          ? value.orders.map((order, orderIndex) => ({
              ...order,
              label: String(order.label || `Route ${orderIndex + 1}`),
              note: String(order.note || ''),
              steps: Array.isArray(order.steps)
                ? order.steps.map((step, stepIndex) => ({
                    ...step,
                    n: String(step.n || String(stepIndex + 1).padStart(2, '0')),
                    title: String(step.title || ''),
                    itemId: String(step.itemId || ''),
                    flag: String(step.flag || 'ESSENTIAL'),
                    note: String(step.note || ''),
                    kind: String(step.kind || 'animation'),
                    episodeRange: String(step.episodeRange || ''),
                    timeRange: String(step.timeRange || ''),
                    after: String(step.after || ''),
                    before: String(step.before || ''),
                    resumeNote: String(step.resumeNote || ''),
                  }))
                : [],
            }))
          : [],
      };
    } catch (error) {
      throw new Error(`Invalid franchise JSON: ${error.message}`);
    }
  }

  function writeEditorFranchise(value) {
    $('#editorFranchise').value = JSON.stringify(value, null, 2);
  }

  function editorCatalogConnection(title) {
    const needle = norm(title);
    if (!needle) return null;
    const matches = canonicalItems().filter(
      (item) => norm(item.title) === needle || (item.aliases || []).some((alias) => norm(alias) === needle),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function renderEditorFranchiseBuilder() {
    const mount = $('#editorFranchiseBuilder');
    if (!mount) return;
    let franchise;
    try {
      franchise = editorFranchiseValue();
    } catch (error) {
      mount.hidden = false;
      mount.innerHTML = `<div class="editor-builder-error">${esc(error.message)} Fix the JSON above before using the route builder.</div>`;
      return;
    }
    const hasRoute = franchise.orders.length > 0;
    mount.hidden = false;
    if (!hasRoute) {
      mount.innerHTML =
        '<div class="editor-builder-empty"><span class="kicker">ROUTE BUILDER</span><p>This title has no franchise route yet.</p><button type="button" class="slash-button small" data-editor-create-route>CREATE FIRST ROUTE</button></div>';
      $('[data-editor-create-route]', mount).addEventListener('click', () => {
        const value = editorFranchiseValue();
        value.orders.push({ label: 'Recommended route', note: '', steps: [] });
        writeEditorFranchise(value);
        renderEditorFranchiseBuilder();
      });
      return;
    }
    mount.innerHTML = `<div class="editor-builder-head"><div><span class="kicker">ROUTE BUILDER</span><h4>${esc(franchise.name || 'UNTITLED FRANCHISE')}</h4><p>Build the path in the order a viewer should follow it. Open a step only when it needs a precise placement or viewing instruction.</p></div><button type="button" class="slash-button small" data-editor-add-order>ADD ROUTE</button></div><div class="editor-route-tabs">${franchise.orders.map((order, index) => `<button type="button" class="${index === 0 ? 'active' : ''}" data-editor-route-index="${index}">${String(index + 1).padStart(2, '0')} ${esc(order.label)}</button>`).join('')}</div><div class="editor-route-panels">${franchise.orders
      .map(
        (order, orderIndex) =>
          `<section class="editor-route-panel" data-editor-route-panel="${orderIndex}" ${orderIndex ? 'hidden' : ''}><div class="editor-route-meta"><label class="field-label">ROUTE LABEL<input data-editor-order-field="label" data-editor-order-index="${orderIndex}" value="${esc(order.label)}"></label><label class="field-label">EDITORIAL NOTE<input data-editor-order-field="note" data-editor-order-index="${orderIndex}" value="${esc(order.note)}"></label></div><div class="editor-step-list">${order.steps
            .map(
              (step, stepIndex) =>
                `<article class="editor-step-row" data-editor-step-index="${stepIndex}"><span class="editor-step-number">${String(stepIndex + 1).padStart(2, '0')}</span><div class="editor-step-content"><div class="editor-step-fields"><label class="field-label">TITLE OR STEP NAME<input data-editor-step-field="title" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.title)}" placeholder="Choose a catalog title or name a live-action step"></label><label class="field-label">STEP TYPE<select data-editor-step-field="kind" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}">${[
                  ['animation', 'Animation title'],
                  ['live-action', 'Live-action supporting step'],
                ]
                  .map(
                    ([value, label]) =>
                      `<option value="${value}" ${step.kind === value ? 'selected' : ''}>${label}</option>`,
                  )
                  .join(
                    '',
                  )}</select></label><label class="field-label">ROUTE ROLE<select data-editor-step-field="flag" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}">${['ESSENTIAL', 'OPTIONAL', 'SKIP'].map((flag) => `<option ${step.flag === flag ? 'selected' : ''}>${flag}</option>`).join('')}</select></label></div><details class="editor-step-detail"><summary>PLACEMENT, RANGE &amp; CONNECTION <span>${esc(step.episodeRange || step.timeRange || step.after || step.before ? 'CONFIGURED' : 'OPTIONAL')}</span></summary><div class="editor-step-detail-grid"><label class="field-label">CATALOG CONNECTION<input data-editor-step-field="itemId" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.itemId)}" placeholder="Stable ID when known"></label><label class="field-label">EPISODE RANGE<input data-editor-step-field="episodeRange" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.episodeRange)}" placeholder="Episodes 1–2"></label><label class="field-label">TIME RANGE<input data-editor-step-field="timeRange" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.timeRange)}" placeholder="00:00–18:30"></label><label class="field-label">PLACE AFTER<input data-editor-step-field="after" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.after)}" placeholder="S01"></label><label class="field-label">PLACE BEFORE<input data-editor-step-field="before" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.before)}" placeholder="FINAL"></label><label class="field-label">RESUME NOTE<input data-editor-step-field="resumeNote" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.resumeNote)}" placeholder="Continue with episode 13"></label><label class="field-label editor-step-note">VIEWING NOTE<input data-editor-step-field="note" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" value="${esc(step.note)}" placeholder="Why this step belongs here"></label></div></details></div><div class="editor-step-actions"><button type="button" title="Move step up" data-editor-step-move="up" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" ${stepIndex === 0 ? 'disabled' : ''}>↑</button><button type="button" title="Move step down" data-editor-step-move="down" data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}" ${stepIndex === order.steps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" title="Remove step" data-editor-step-remove data-editor-order-index="${orderIndex}" data-editor-step-index="${stepIndex}">×</button></div></article>`,
            )
            .join(
              '',
            )}</div><button type="button" class="slash-button small" data-editor-add-step data-editor-order-index="${orderIndex}">ADD STEP</button></section>`,
      )
      .join('')}</div>`;
    $$('[data-editor-route-index]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const index = Number(button.dataset.editorRouteIndex);
        $$('[data-editor-route-index]', mount).forEach((entry) =>
          entry.classList.toggle('active', entry === button),
        );
        $$('[data-editor-route-panel]', mount).forEach(
          (panel) => (panel.hidden = Number(panel.dataset.editorRoutePanel) !== index),
        );
      }),
    );
    $$('[data-editor-order-field]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        const value = editorFranchiseValue();
        value.orders[Number(input.dataset.editorOrderIndex)][input.dataset.editorOrderField] = input.value;
        writeEditorFranchise(value);
      }),
    );
    $$('[data-editor-step-field]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        const value = editorFranchiseValue();
        const step =
          value.orders[Number(input.dataset.editorOrderIndex)].steps[Number(input.dataset.editorStepIndex)];
        step[input.dataset.editorStepField] = input.value;
        if (input.dataset.editorStepField === 'title' && step.kind !== 'live-action') {
          const match = editorCatalogConnection(input.value);
          if (match) step.itemId = match.id;
        }
        writeEditorFranchise(value);
      }),
    );
    $$('[data-editor-step-move]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const value = editorFranchiseValue();
        const order = value.orders[Number(button.dataset.editorOrderIndex)];
        const index = Number(button.dataset.editorStepIndex);
        const next = button.dataset.editorStepMove === 'up' ? index - 1 : index + 1;
        [order.steps[index], order.steps[next]] = [order.steps[next], order.steps[index]];
        writeEditorFranchise(value);
        renderEditorFranchiseBuilder();
      }),
    );
    $$('[data-editor-step-remove]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const value = editorFranchiseValue();
        value.orders[Number(button.dataset.editorOrderIndex)].steps.splice(
          Number(button.dataset.editorStepIndex),
          1,
        );
        writeEditorFranchise(value);
        renderEditorFranchiseBuilder();
      }),
    );
    $$('[data-editor-add-step]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const value = editorFranchiseValue();
        value.orders[Number(button.dataset.editorOrderIndex)].steps.push({
          n: String(value.orders[Number(button.dataset.editorOrderIndex)].steps.length + 1).padStart(2, '0'),
          title: '',
          itemId: '',
          flag: 'ESSENTIAL',
          kind: 'animation',
          episodeRange: '',
          timeRange: '',
          after: '',
          before: '',
          resumeNote: '',
          note: '',
        });
        writeEditorFranchise(value);
        renderEditorFranchiseBuilder();
      }),
    );
    $('[data-editor-add-order]', mount).addEventListener('click', () => {
      const value = editorFranchiseValue();
      value.orders.push({ label: `Route ${value.orders.length + 1}`, note: '', steps: [] });
      writeEditorFranchise(value);
      renderEditorFranchiseBuilder();
    });
  }

  function editorEpisodeValue() {
    const raw = $('#editorEpisodes')?.value.trim();
    if (!raw) return [];
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('Episode data must be a list.');
    return value.map((season, index) => ({
      ...season,
      seasonNumber: Number(season.seasonNumber || index + 1),
      label: String(season.label || `Season ${index + 1}`),
      episodes: Array.isArray(season.episodes)
        ? season.episodes.map((episode, episodeIndex) => ({
            ...episode,
            number: Number(episode.number || episodeIndex + 1),
            title: String(episode.title || ''),
          }))
        : [],
    }));
  }

  function renderEditorEpisodeBuilder() {
    const mount = $('#editorEpisodeBuilder');
    if (!mount) return;
    let seasons;
    try {
      seasons = editorEpisodeValue();
    } catch (error) {
      mount.innerHTML = `<div class="editor-builder-error">${esc(error.message)} The episode list needs attention.</div>`;
      return;
    }
    const write = (next) => {
      $('#editorEpisodes').value = JSON.stringify(next, null, 2);
      renderEditorEpisodeBuilder();
    };
    mount.innerHTML = `<div class="editor-builder-head"><div><span class="kicker">EPISODE WORKSPACE</span><h4>${seasons.length ? `${seasons.length} season${seasons.length === 1 ? '' : 's'} mapped` : 'No episode data yet'}</h4><p>Add seasons and episode names without touching provider JSON.</p></div><button type="button" class="slash-button small" data-editor-add-season>ADD SEASON</button></div>${seasons.length ? `<div class="editor-season-list">${seasons.map((season, seasonIndex) => `<section class="editor-season-block"><div class="editor-season-head"><label class="field-label">SEASON LABEL<input data-editor-season-label="${seasonIndex}" value="${esc(season.label)}"></label><span class="editor-season-count">${season.episodes.length} episode${season.episodes.length === 1 ? '' : 's'}</span><button type="button" class="text-button danger" data-editor-remove-season="${seasonIndex}">REMOVE SEASON</button></div><div class="editor-episode-list">${season.episodes.map((episode, episodeIndex) => `<div class="editor-episode-row"><span class="editor-episode-number">E${String(episode.number).padStart(2, '0')}</span><input data-editor-episode-title="${seasonIndex}:${episodeIndex}" value="${esc(episode.title)}" placeholder="Episode name"><button type="button" class="text-button danger" data-editor-remove-episode="${seasonIndex}:${episodeIndex}" aria-label="Remove episode">REMOVE</button></div>`).join('')}</div><button type="button" class="slash-button small" data-editor-add-episode="${seasonIndex}">ADD EPISODE</button></section>`).join('')}</div>` : '<div class="editor-builder-empty"><p>Start by adding a season. Episode names can be entered one at a time.</p></div>'}`;
    $('[data-editor-add-season]', mount).addEventListener('click', () =>
      write([
        ...seasons,
        { seasonNumber: seasons.length + 1, label: `Season ${seasons.length + 1}`, episodes: [] },
      ]),
    );
    $$('[data-editor-season-label]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        const next = editorEpisodeValue();
        next[Number(input.dataset.editorSeasonLabel)].label = input.value;
        $('#editorEpisodes').value = JSON.stringify(next, null, 2);
      }),
    );
    $$('[data-editor-add-episode]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const next = editorEpisodeValue();
        const index = Number(button.dataset.editorAddEpisode);
        next[index].episodes.push({ number: next[index].episodes.length + 1, title: '' });
        write(next);
      }),
    );
    $$('[data-editor-episode-title]', mount).forEach((input) =>
      input.addEventListener('input', () => {
        const [seasonIndex, episodeIndex] = input.dataset.editorEpisodeTitle.split(':').map(Number);
        const next = editorEpisodeValue();
        next[seasonIndex].episodes[episodeIndex].title = input.value;
        $('#editorEpisodes').value = JSON.stringify(next, null, 2);
      }),
    );
    $$('[data-editor-remove-season]', mount).forEach((button) =>
      button.addEventListener('click', () =>
        write(seasons.filter((_, index) => index !== Number(button.dataset.editorRemoveSeason))),
      ),
    );
    $$('[data-editor-remove-episode]', mount).forEach((button) =>
      button.addEventListener('click', () => {
        const [seasonIndex, episodeIndex] = button.dataset.editorRemoveEpisode.split(':').map(Number);
        const next = editorEpisodeValue();
        next[seasonIndex].episodes.splice(episodeIndex, 1);
        write(next);
      }),
    );
  }

  async function saveEditorDraft(event) {
    event.preventDefault();
    const result = $('#editorResult');
    try {
      if (!editorSelectedFranchiseId) syncEditorStructuredMetadata();
      const franchiseOnly = Boolean(editorSelectedFranchiseId);
      const title = franchiseOnly ? $('#editorFranchiseName').value.trim() : $('#editorTitle').value.trim();
      if (!title) throw new Error(franchiseOnly ? 'Franchise name is required.' : 'Title is required.');
      const existing = !franchiseOnly && editorSelectedId ? itemById(editorSelectedId) : null;
      const id = franchiseOnly
        ? `f:${editorSelectedFranchiseId}`
        : editorSelectedId ||
          (await fallbackId(title, Number($('#editorYear').value) || 0, $('#editorType').value));
      const episodes = $('#editorEpisodes').value.trim() ? JSON.parse($('#editorEpisodes').value) : [];
      let franchise = $('#editorFranchise').value.trim() ? JSON.parse($('#editorFranchise').value) : null;
      if (!franchise && ($('#editorFranchiseName').value.trim() || $('#editorFranchiseSummary').value.trim()))
        franchise = {
          name: $('#editorFranchiseName').value.trim(),
          summary: $('#editorFranchiseSummary').value.trim(),
          orders: [],
        };
      if (franchise) {
        franchise.name = $('#editorFranchiseName').value.trim() || franchise.name || '';
        franchise.summary = $('#editorFranchiseSummary').value.trim() || franchise.summary || '';
      }
      const scores = $('#editorScores').value.trim() ? JSON.parse($('#editorScores').value) : {};
      const content = $('#editorContent').value.trim() ? JSON.parse($('#editorContent').value) : {};
      const awards = $('#editorAwards').value.trim() ? JSON.parse($('#editorAwards').value) : [];
      const values = {
        title,
        year: Number($('#editorYear').value) || 0,
        type: $('#editorType').value,
        origin: $('#editorOrigin').value.trim(),
        aliases: $('#editorAliases')
          .value.split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        genres: $('#editorGenres').value.trim(),
        description: $('#editorDescription').value.trim(),
        summaryTranslations: normalizeSummaryTranslations(editorSummaryTranslations),
        scores,
        content,
        awards,
        lookupTitle: $('#editorLookupTitle').value.trim() || title,
        sourceUrl: $('#editorSourceUrl').value.trim(),
        coverUrl: $('#editorCoverUrl').value.trim(),
        coverAsset: (() => {
          try {
            return $('#editorCoverFile').dataset.asset
              ? JSON.parse($('#editorCoverFile').dataset.asset)
              : null;
          } catch {
            return null;
          }
        })(),
        watch_note: $('#editorWatchNote').value.trim(),
        caveat: $('#editorCaveat').value.trim(),
        editorEpisodes: episodes,
        editorFranchise: franchise,
      };
      const base = existing ? editorSnapshot(existing) : null;
      editorDrafts[id] = {
        id,
        base,
        values,
        baseHash: catalogBootstrap?.sourceHash || '',
        isNew: !existing,
        updatedAt: new Date().toISOString(),
      };
      if (franchise?.id) {
        editorDrafts[`f:${franchise.id}`] = {
          id: `f:${franchise.id}`,
          base: null,
          values: { franchise },
          baseHash: catalogBootstrap?.sourceHash || '',
          isNew: false,
          updatedAt: new Date().toISOString(),
        };
      }
      save(STORE.editorDrafts, editorDrafts);
      if (!existing && !franchiseOnly) {
        const created = customFromPayload({ ...values, id, api: 'none', content: {} }, true);
        customTitles = [
          ...customTitles.filter((item) => item.id !== id),
          { ...created, ...values, custom: true },
        ];
        save(STORE.custom, customTitles);
      }
      if (franchiseOnly) editorSelectedId = '';
      else editorSelectedId = id;
      result.className = 'import-result good';
      result.textContent = 'Saved locally. The editor preview and catalog now use this override.';
      $('#editorExportCode').value = '';
      $('#editorPackageStatus').textContent =
        'Saved on this device. Create a share package only when you want to send these changes elsewhere.';
      renderEditorDraftList();
      renderAll();
    } catch (error) {
      result.className = 'import-result bad';
      result.textContent = error.message || 'Could not save editor draft.';
    }
  }

  function encodeEditorPackage(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    return EDITOR_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function exportEditorPackage() {
    const entries = Object.values(editorDrafts);
    if (!entries.length) return toast('Save an editor draft first');
    const payload = {
      format: 'ultimate-animation-index-editor',
      schema: 1,
      createdAt: new Date().toISOString(),
      baseHash: catalogBootstrap?.sourceHash || '',
      entries,
    };
    $('#editorExportCode').value = encodeEditorPackage(payload);
    $('#editorPublishShare').disabled = true;
    $('#editorCopyShare').disabled = true;
    $('#editorShareLink').hidden = true;
    $('#editorPackageStatus').textContent =
      `${formatCount(entries.length)} ${entries.length === 1 ? 'draft is' : 'drafts are'} prepared. Complete the verification to create a review link.`;
    renderShareVerification('editor-review');
  }

  function openEditorPackage() {
    const panel = $('#editorPackagePanel');
    if (!panel) return;
    panel.classList.add('is-highlighted');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => panel.classList.remove('is-highlighted'), 1400);
  }

  function importEditorPackage(sharedCode = '') {
    const result = $('#editorPackageResult');
    try {
      const code = sharedCode.trim();
      if (!code) throw new Error('Import an Editor review link through Share Inbox first.');
      const payload = decodeEditorPackage(code);
      for (const entry of payload.entries) {
        if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(entry.id))
          throw new Error('Editor package contains an invalid title ID.');
        if (!entry.values || typeof entry.values !== 'object' || Array.isArray(entry.values))
          throw new Error('Editor package contains invalid title data.');
        if (JSON.stringify(entry).length > 1_000_000) throw new Error('Editor package entry is too large.');
        editorDrafts[entry.id] = { ...entry, id: entry.id };
      }
      save(STORE.editorDrafts, editorDrafts);
      pendingOfficialEditorReview = code;
      officialEditorReviewApproved = false;
      renderEditorDraftList();
      renderOfficialEditorReview();
      $('#editorPackageStatus').textContent =
        `${payload.entries.length} imported draft(s) are ready for review.`;
      result.className = 'import-result good';
      result.textContent = `${payload.entries.length} editor draft(s) imported locally. Review the official changes before approving them.`;
    } catch (error) {
      result.className = 'import-result bad';
      result.textContent = error.message || 'Editor package rejected.';
    }
  }

  function officialEditorReviewError(code) {
    return (
      {
        'catalog-write-forbidden':
          'Applying catalog changes is only available from the computer running the local server.',
        'invalid-editor-review': 'This editor review is invalid or contains an unsupported local asset.',
        'editor-review-base-conflict':
          'The catalog has changed since this review was created. Ask for a new review link.',
        'official-push-requires-main': 'Official approval requires the main branch.',
      }[code] || 'The official catalog update could not be completed.'
    );
  }

  function renderOfficialEditorReview() {
    const panel = $('#editorOfficialReview');
    const preview = $('#editorPreviewOfficial');
    const apply = $('#editorApplyOfficial');
    const result = $('#editorOfficialReviewResult');
    if (!panel || !preview || !apply || !result) return;
    const available = Boolean(pendingOfficialEditorReview && state.catalogWriteEnabled && state.catalogToken);
    panel.hidden = !available;
    preview.disabled = !available;
    apply.disabled = !available || !officialEditorReviewApproved;
    if (!available) {
      result.className = 'import-result';
      result.textContent = '';
    }
  }

  async function previewOfficialEditorReview() {
    const button = $('#editorPreviewOfficial');
    const apply = $('#editorApplyOfficial');
    const result = $('#editorOfficialReviewResult');
    if (!pendingOfficialEditorReview || !state.catalogToken) return;
    button.disabled = true;
    button.textContent = 'VALIDATING…';
    apply.disabled = true;
    officialEditorReviewApproved = false;
    result.className = 'import-result';
    result.textContent = 'Checking the review against the current catalog…';
    try {
      const response = await fetch('/api/editor-reviews/official/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-UAI-Catalog-Token': state.catalogToken,
        },
        body: JSON.stringify({ package: pendingOfficialEditorReview }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'invalid-editor-review');
      if (data.review.conflict) throw new Error('editor-review-base-conflict');
      const summary = data.review.summary || {};
      const entries = data.review.entries || [];
      result.className = 'import-result good';
      result.innerHTML = `<b>READY TO APPLY LOCALLY</b><span>${formatCount(summary.updatedTitles || 0)} title update${summary.updatedTitles === 1 ? '' : 's'} · ${formatCount(summary.newTitles || 0)} new title${summary.newTitles === 1 ? '' : 's'} · ${formatCount(summary.updatedFranchises || 0)} route update${summary.updatedFranchises === 1 ? '' : 's'} · ${formatCount(summary.newFranchises || 0)} new route${summary.newFranchises === 1 ? '' : 's'}</span><small>${entries
        .map((entry) => esc(entry.title))
        .slice(0, 6)
        .join(' · ')}${entries.length > 6 ? ` · +${entries.length - 6}` : ''}</small>`;
      officialEditorReviewApproved = true;
      apply.disabled = false;
    } catch (error) {
      result.className = 'import-result bad';
      result.textContent = officialEditorReviewError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'REVIEW OFFICIAL CHANGES';
    }
  }

  async function applyOfficialEditorReview() {
    const button = $('#editorApplyOfficial');
    const result = $('#editorOfficialReviewResult');
    if (!officialEditorReviewApproved || !pendingOfficialEditorReview || !state.catalogToken) return;
    if (!confirmWithButton(button, { confirmText: 'CONFIRM LOCAL APPLY' })) return;
    button.disabled = true;
    button.textContent = 'APPLYING…';
    result.className = 'import-result';
    result.textContent = 'Writing the local catalog source and rebuilding SQLite…';
    try {
      const response = await fetch('/api/editor-reviews/official/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-UAI-Catalog-Token': state.catalogToken,
        },
        body: JSON.stringify({ package: pendingOfficialEditorReview }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'editor-review-apply-failed');
      const approvedEntries = decodeEditorPackage(pendingOfficialEditorReview).entries;
      const changedIds = new Set(approvedEntries.map((entry) => entry.id));
      changedIds.forEach((id) => delete editorDrafts[id]);
      const approvedNewTitleIds = new Set(
        approvedEntries.filter((entry) => entry.isNew && !entry.id.startsWith('f:')).map((entry) => entry.id),
      );
      if (approvedNewTitleIds.size) {
        customTitles = customTitles.filter((item) => !approvedNewTitleIds.has(item.id));
        save(STORE.custom, customTitles);
      }
      save(STORE.editorDrafts, editorDrafts);
      pendingOfficialEditorReview = '';
      officialEditorReviewApproved = false;
      result.className = 'import-result good';
      const importedCoverAssets = Number(data.result?.coverAssets || 0);
      result.textContent = importedCoverAssets
        ? `Applied locally. ${formatCount(importedCoverAssets)} cover image${importedCoverAssets === 1 ? '' : 's'} saved for the next cover-package build. Reloading…`
        : 'Applied to this installation. The catalog source and SQLite index are updated locally. Reloading…';
      renderEditorDraftList();
      renderOfficialEditorReview();
      setTimeout(() => location.reload(), 850);
    } catch (error) {
      result.className = 'import-result bad';
      result.textContent = officialEditorReviewError(error.message);
      renderOfficialEditorReview();
    } finally {
      button.disabled = false;
      button.textContent = 'APPLY LOCALLY';
    }
  }

  function openEditor(id = '') {
    if (!editorMission || editorMission.includes('franchise'))
      setEditorMission(id ? 'edit-title' : 'new-title');
    editorSelectedId = id;
    editorSelectedFranchiseId = '';
    switchTab('editor');
    const item = id ? itemById(id) : null;
    if (item) fillEditor(item);
    else {
      editorSelectedId = '';
      fillEditor({
        id: '',
        title: '',
        year: 0,
        type: 'Series',
        origin: '',
        aliases: [],
        genres: '',
        lookupTitle: '',
        sourceUrl: '',
        watch_note: '',
        caveat: '',
        editorEpisodes: [],
        editorFranchise: null,
      });
    }
    if (catalogBootstrap && !CAT.franchises.length)
      void loadCatalogEntity('franchises').then(() => {
        const current = editorSelectedId ? itemById(editorSelectedId) : null;
        if (current) fillEditor(current);
        else renderEditor();
      });
    // Selecting a record ends the discovery step. Keep the full workspace free
    // for the chosen title rather than leaving a narrow search column beside it.
    if (id) $('#editorSearchDock').hidden = true;
  }

  function openFranchiseEditor(id) {
    const franchise = CAT.franchises.map(franchiseWithEditorDraft).find((entry) => entry.id === id);
    if (!franchise) return;
    editorSelectedFranchiseId = id;
    editorSelectedId = '';
    setEditorMission('edit-franchise');
    switchTab('editor');
    fillEditor({
      id: '',
      title: franchise.name,
      year: 0,
      type: 'Series',
      origin: '',
      aliases: [],
      genres: '',
      lookupTitle: franchise.name,
      sourceUrl: '',
      watch_note: '',
      caveat: '',
      editorEpisodes: [],
      editorFranchise: structuredClone(franchise),
    });
    // The guide has been selected, so its editor owns the entire canvas.
    $('#editorSearchDock').hidden = true;
  }

  function openNewFranchiseEditor() {
    const localId = `local-${Date.now().toString(36)}`;
    editorSelectedFranchiseId = localId;
    editorSelectedId = '';
    switchTab('editor');
    fillEditor({
      id: '',
      title: '',
      year: 0,
      type: 'Series',
      origin: '',
      aliases: [],
      genres: '',
      lookupTitle: '',
      sourceUrl: '',
      watch_note: '',
      caveat: '',
      editorEpisodes: [],
      editorFranchise: {
        id: localId,
        name: '',
        summary: '',
        orders: [{ label: 'Recommended route', note: '', steps: [] }],
      },
    });
    setTimeout(() => $('#editorFranchiseName')?.focus(), 100);
  }

  function renderEditor() {
    renderEditorDraftList();
    renderEditorSearch($('#editorTitleSearch')?.value || '');
    renderEditorFranchiseSearch($('#editorFranchiseSearch')?.value || '');
    if (editorSelectedId) {
      const item = itemById(editorSelectedId);
      if (item) fillEditor(item);
    } else if (editorSelectedFranchiseId) {
      const franchise = CAT.franchises
        .map(franchiseWithEditorDraft)
        .find((entry) => entry.id === editorSelectedFranchiseId);
      if (franchise)
        fillEditor({
          id: '',
          title: franchise.name,
          year: 0,
          type: 'Series',
          origin: '',
          aliases: [],
          genres: [],
          lookupTitle: franchise.name,
          sourceUrl: '',
          watch_note: '',
          caveat: '',
          editorEpisodes: [],
          editorFranchise: structuredClone(franchise),
        });
    }
  }

  function renderSources() {
    const arr = Object.entries(sources).sort((a, b) =>
      (b[1].importedAt || '').localeCompare(a[1].importedAt || ''),
    );
    $('#sourceList').innerHTML = arr.length
      ? arr
          .map(([sid, s]) => {
            const rec = Object.values(s.opinions || {}).filter((v) => v === 'recommend').length,
              no = Object.values(s.opinions || {}).filter((v) => v === 'avoid').length,
              completed = new Set(Array.isArray(s.completed) ? s.completed : []);
            const titles = [...new Set([...Object.keys(s.opinions || {}), ...completed])]
              .map((id) => {
                const verdict = s.opinions?.[id] || '';
                const labels = [
                  verdict === 'recommend' ? 'RECOMMEND' : verdict === 'avoid' ? "DON'T RECOMMEND" : '',
                  completed.has(id) ? 'WATCHED' : '',
                ].filter(Boolean);
                const rowClass = verdict === 'recommend' ? 'rec' : verdict === 'avoid' ? 'no' : 'completed';
                return `<li class="${rowClass}"><b>${labels.join(' · ')}</b><span>${esc(itemById(id)?.title || id)}</span></li>`;
              })
              .join('');
            return `<details class="source-item"><summary><div><b>${esc(s.label)}</b><span>${formatCount(rec)} recommended · ${formatCount(no)} not recommended · ${formatCount(completed.size)} fully watched · ${formatCount((s.titleIds || []).length)} added title${(s.titleIds || []).length === 1 ? '' : 's'}</span></div><span>IMPORTED ${esc((s.importedAt || '').slice(0, 10))}</span></summary><ul class="share-review-titles">${titles}</ul><div class="source-item-actions">${s.package ? `<button data-apply-source="${esc(sid)}" type="button">ADD TO CATALOG</button>` : '<small>Re-import this shared link to add it to the catalog.</small>'}<button data-remove-source="${esc(sid)}" type="button">REMOVE</button></div></details>`;
          })
          .join('')
      : '<div class="empty-state source-list-empty">No imported UserLists yet.</div>';
    $$('[data-remove-source]', $('#sourceList')).forEach((b) =>
      b.addEventListener('click', () => removeSource(b.dataset.removeSource)),
    );
    $$('[data-apply-source]', $('#sourceList')).forEach((b) =>
      b.addEventListener('click', () => applySourceToCatalog(b.dataset.applySource)),
    );
  }
  async function applySourceToCatalog(sid) {
    const source = sources[sid];
    if (!source?.package || !state.catalogToken) return toast('This list cannot be applied to the catalog.');
    const button = $(`[data-apply-source="${CSS.escape(sid)}"]`);
    if (!confirmWithButton(button, { confirmText: 'CONFIRM CATALOG APPLY' })) return;
    const response = await fetch('/api/community-reviews/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-UAI-Catalog-Token': state.catalogToken },
      body: JSON.stringify({ package: source.package }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) return toast('The catalog update could not be applied.');
    removeSource(sid);
    toast('Community signal added to this catalog. Reloading…');
    setTimeout(() => location.reload(), 850);
  }
  function removeSource(sid) {
    if (!sources[sid]) return;
    delete sources[sid];
    save(STORE.sources, sources);
    // Remove imported-only custom titles that no remaining source uses and that you did not add yourself / opine on.
    const used = new Set(
      Object.values(sources).flatMap((s) => [
        ...Object.keys(s.opinions || {}),
        ...(s.completed || []),
        ...(s.titleIds || []),
      ]),
    );
    customTitles = customTitles.filter(
      (x) => x.addedByMe || myOpinions[x.id] || favorites[x.id] || used.has(x.id),
    );
    save(STORE.custom, customTitles);
    populateFilters();
    renderAll();
    toast('Imported source removed');
  }

  let turnstileLoad = null;
  const shareTokens = { 'recommendation-list': '', 'editor-review': '' };
  let pendingShareImport = null;

  function shareError(code) {
    return (
      {
        'rate-limited': 'Too many requests. Wait a minute, then try again.',
        'turnstile-failed': 'The verification did not complete. Try the verification again.',
        'invalid-share-package': 'This package cannot be shared.',
        'not-found': 'This share link is missing or has expired.',
      }[code] || 'The share service could not complete that request.'
    );
  }

  function shareConfigReady() {
    if (state.shareLinksEnabled && state.shareServiceUrl && state.turnstileSiteKey) return true;
    toast('Share links are not configured on this installation yet.');
    return false;
  }

  function ensureTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoad) return turnstileLoad;
    turnstileLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => reject(new Error('turnstile-load-failed'));
      document.head.append(script);
    });
    return turnstileLoad;
  }

  async function renderShareVerification(kind) {
    const target = kind === 'editor-review' ? $('#editorTurnstile') : $('#listTurnstile');
    if (!target || !shareConfigReady()) return false;
    target.hidden = false;
    target.replaceChildren();
    shareTokens[kind] = '';
    try {
      const turnstile = await ensureTurnstile();
      turnstile.render(target, {
        sitekey: state.turnstileSiteKey,
        theme: 'dark',
        callback: (token) => {
          shareTokens[kind] = token;
          const button = kind === 'editor-review' ? $('#editorPublishShare') : $('#publishListShare');
          if (button) button.disabled = false;
        },
        'expired-callback': () => {
          shareTokens[kind] = '';
          const button = kind === 'editor-review' ? $('#editorPublishShare') : $('#publishListShare');
          if (button) button.disabled = true;
        },
      });
      return true;
    } catch {
      toast('Could not load share verification. Check the local share configuration.');
      return false;
    }
  }

  async function publishShareLink(kind, code) {
    if (!shareConfigReady() || !code || !shareTokens[kind]) {
      toast('Complete the verification before creating a link.');
      return;
    }
    const button = kind === 'editor-review' ? $('#editorPublishShare') : $('#publishListShare');
    const output = kind === 'editor-review' ? $('#editorShareLink') : $('#listShareLink');
    button.disabled = true;
    button.textContent = 'CREATING LINK…';
    try {
      const response = await fetch(`${state.shareServiceUrl}/v1/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, package: code, turnstileToken: shareTokens[kind] }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.url) throw new Error(data.error || 'share-failed');
      output.value = data.url;
      output.hidden = false;
      const copy = kind === 'editor-review' ? $('#editorCopyShare') : $('#copyListShare');
      copy.disabled = false;
      const status = kind === 'editor-review' ? $('#editorPackageStatus') : $('#importResult');
      status.className = 'import-result good';
      status.textContent = `Share link created. ${formatTimeUntil(data.expiresAt)}.`;
    } catch (error) {
      toast(shareError(error.message));
      await renderShareVerification(kind);
    } finally {
      button.textContent = kind === 'editor-review' ? 'CREATE REVIEW LINK' : 'CREATE LIST LINK';
      button.disabled = !shareTokens[kind];
    }
  }

  async function copyShareLink(input, label) {
    if (!input?.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      toast(`${label} link copied`);
    } catch {
      input.select();
      document.execCommand('copy');
      toast(`${label} link copied`);
    }
  }

  function decodeEditorPackage(code) {
    if (!code.startsWith(EDITOR_PREFIX)) throw new Error('Invalid editor package.');
    const binary = atob(code.slice(EDITOR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/') + '==');
    const payload = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    if (
      payload.format !== 'ultimate-animation-index-editor' ||
      payload.schema !== 1 ||
      !Array.isArray(payload.entries)
    )
      throw new Error('Unsupported editor package.');
    if (payload.entries.length > 500) throw new Error('Editor package contains too many drafts.');
    return payload;
  }

  async function previewShareLink() {
    const input = $('#shareLinkInput');
    const preview = $('#shareImportPreview');
    const apply = $('#applyShareLink');
    const applyCommunity = $('#applyShareCommunity');
    pendingShareImport = null;
    preview.hidden = false;
    preview.className = 'share-import-preview loading';
    preview.textContent = 'Checking share link…';
    apply.disabled = true;
    applyCommunity.hidden = true;
    $('#shareSourceNameGroup').hidden = true;
    try {
      const link = new URL(input.value.trim());
      if (link.origin !== state.shareServiceUrl || !/^\/v1\/shares\/[A-Za-z0-9_-]{12}$/.test(link.pathname))
        throw new Error('invalid-link');
      const response = await fetch(link.href, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'not-found');
      let summary = '';
      let reviewHtml = '';
      if (data.kind === 'recommendation-list') {
        const verify = await fetch('/api/userlist/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: data.package }),
        });
        const verified = await verify.json();
        if (!verify.ok || !verified.ok) throw new Error(verified.error || 'invalid-list');
        const recommendations = verified.payload.opinions.filter(
          (entry) => entry.verdict === 'recommend',
        ).length;
        const notRecommended = verified.payload.opinions.filter((entry) => entry.verdict === 'avoid').length;
        const completed = new Set(verified.payload.completed || []);
        const titleNames = verified.payload.titles
          .map((entry) => entry.title)
          .filter(Boolean)
          .slice(0, 4);
        summary = `${formatCount(recommendations)} recommended · ${formatCount(notRecommended)} not recommended · ${formatCount(completed.size)} fully watched · ${formatCount(verified.payload.titles.length)} added title${verified.payload.titles.length === 1 ? '' : 's'}${titleNames.length ? ` · includes ${titleNames.join(', ')}` : ''}`;
        const sharedTitleIds = [
          ...new Set([...verified.payload.opinions.map((entry) => entry.id), ...completed]),
        ];
        const reviewRows = sharedTitleIds
          .slice(0, 24)
          .map((id) => {
            const opinion = verified.payload.opinions.find((entry) => entry.id === id);
            const title = verified.catalogTitles?.[id];
            const labels = [
              opinion?.verdict === 'recommend'
                ? 'RECOMMEND'
                : opinion?.verdict === 'avoid'
                  ? "DON'T RECOMMEND"
                  : '',
              completed.has(id) ? 'WATCHED' : '',
            ].filter(Boolean);
            const rowClass =
              opinion?.verdict === 'recommend' ? 'rec' : opinion?.verdict === 'avoid' ? 'no' : 'completed';
            return `<li class="${rowClass}"><b>${labels.join(' · ')}</b><span>${esc(title?.title || id)}${title?.year ? ` (${title.year})` : ''}${title ? '' : ' · NOT IN CATALOG'}</span></li>`;
          })
          .join('');
        reviewHtml = `<ul class="share-review-titles">${reviewRows}</ul>${sharedTitleIds.length > 24 ? `<small>+${formatCount(sharedTitleIds.length - 24)} more titles in this review.</small>` : ''}`;
        $('#shareSourceNameGroup').hidden = false;
      } else if (data.kind === 'editor-review') {
        const payload = decodeEditorPackage(data.package);
        summary = `${formatCount(payload.entries.length)} editor draft${payload.entries.length === 1 ? '' : 's'} ready for review`;
      } else throw new Error('invalid-link');
      pendingShareImport = data;
      preview.className = 'share-import-preview good';
      preview.innerHTML = `<b>${data.kind === 'editor-review' ? 'EDITOR REVIEW READY TO ADD' : 'RECOMMENDATION LIST READY TO REVIEW'}</b><span>${esc(summary)}</span>${reviewHtml}<small>${data.kind === 'editor-review' ? 'After import, open Editor to review the local drafts.' : 'Add to My Library keeps this list personal. Add to Catalog writes the validated community signal to catalog-source.json and rebuilds SQLite locally.'} · ${esc(formatTimeUntil(data.expiresAt))}</small>`;
      apply.disabled = false;
      applyCommunity.hidden = data.kind !== 'recommendation-list' || !state.catalogWriteEnabled;
    } catch (error) {
      preview.className = 'share-import-preview bad';
      preview.textContent =
        error.message === 'invalid-link'
          ? 'Paste a valid Ultimate Animation Index share link.'
          : shareError(error.message);
    }
  }

  async function applyShareLink() {
    if (!pendingShareImport) return;
    if (pendingShareImport.kind === 'recommendation-list') {
      const label = $('#shareSourceName').value.trim();
      if (!label) return toast('Give this shared list a local source name first.');
      await importUserList(pendingShareImport.package, label);
      return;
    }
    importEditorPackage(pendingShareImport.package);
    switchTab('editor');
    openEditorPackage();
  }

  async function applyShareCommunitySignal() {
    if (pendingShareImport?.kind !== 'recommendation-list' || !state.catalogToken) return;
    const button = $('#applyShareCommunity');
    if (!confirmWithButton(button, { confirmText: 'CONFIRM LOCAL APPLY' })) return;
    button.disabled = true;
    button.textContent = 'APPLYING…';
    try {
      const response = await fetch('/api/community-reviews/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-UAI-Catalog-Token': state.catalogToken },
        body: JSON.stringify({ package: pendingShareImport.package }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'community-review-apply-failed');
      $('#shareImportPreview').className = 'share-import-preview good';
      $('#shareImportPreview').textContent =
        `Community signal applied locally to ${formatCount(data.result.titles)} title${data.result.titles === 1 ? '' : 's'}. Reloading…`;
      pendingShareImport = null;
      $('#applyShareLink').disabled = true;
      button.hidden = true;
      setTimeout(() => location.reload(), 850);
    } catch (error) {
      toast(
        error.message === 'community-review-already-applied'
          ? 'This community review has already been applied.'
          : 'The community signal could not be applied.',
      );
      button.disabled = false;
      button.textContent = 'ADD TO CATALOG';
    }
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
    const completedEntries = shareableCompletedTitleIds();
    const needed = new Set([
      ...customTitles.filter((x) => x.addedByMe).map((x) => x.id),
      ...opinionEntries.map((o) => o.id).filter((id) => !masterById.has(id)),
      ...completedEntries.filter((id) => !masterById.has(id)),
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
          completed: completedEntries,
          titles: titleEntries,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'sign-failed');
      $('#exportCode').value = j.code;
      $('#publishListShare').disabled = true;
      $('#copyListShare').disabled = true;
      $('#listShareLink').hidden = true;
      $('#importResult').className = 'import-result';
      $('#importResult').textContent =
        `List prepared with ${formatCount(completedEntries.length)} fully watched title${completedEntries.length === 1 ? '' : 's'}. Complete the verification to create a temporary share link.`;
      await renderShareVerification('recommendation-list');
    } catch (e) {
      toast(`Could not sign: ${e.message}`);
    } finally {
      $('#generateCodeBtn').disabled = false;
      $('#generateCodeBtn').textContent = 'PREPARE LIST';
    }
  }
  async function importUserList(sharedCode = '', sourceLabel = '') {
    const label = sourceLabel.trim(),
      code = sharedCode.trim(),
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
    if (!code) return;
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
      const record = {
        label,
        importedAt: new Date().toISOString(),
        opinions: {},
        completed: [],
        titleIds: [],
        package: code,
      };
      for (const o of payload.opinions) {
        const mapped = incomingMap.get(o.id) || idMap.get(o.id)?.id || o.id;
        if (!idMap.has(mapped) && !masterById.has(mapped)) throw new Error('unknown-title-reference');
        record.opinions[mapped] = o.verdict;
      }
      record.completed = [...new Set(payload.completed || [])].map((id) => {
        const mapped = incomingMap.get(id) || idMap.get(id)?.id || id;
        if (!idMap.has(mapped) && !masterById.has(mapped)) throw new Error('unknown-title-reference');
        return mapped;
      });
      record.titleIds = payload.titles
        .map((t) => incomingMap.get(t.id) || t.id)
        .filter((id) => !masterById.has(id));
      nextSources[sid] = record;
      customTitles = nextCustom;
      sources = nextSources;
      save(STORE.custom, customTitles);
      save(STORE.sources, sources);
      populateFilters();
      renderAll();
      hydrateMissingCustomMetadata();
      out.classList.add('good');
      const recommended = payload.opinions.filter((entry) => entry.verdict === 'recommend').length;
      const notRecommended = payload.opinions.filter((entry) => entry.verdict === 'avoid').length;
      const completed = record.completed.length;
      out.innerHTML = `<b>IMPORTED: ${esc(label)}</b><span>${formatCount(recommended)} recommended · ${formatCount(notRecommended)} not recommended · ${formatCount(completed)} fully watched · ${formatCount(newCount)} new title${newCount === 1 ? '' : 's'} added · ${formatCount(mergedCount)} existing title${mergedCount === 1 ? '' : 's'} matched without duplicates.</span><small>Completed titles appear as anonymous community activity only. Your watch data and personal ratings were not changed.</small>`;
      pendingShareImport = null;
      $('#applyShareLink').disabled = true;
      $('#shareSourceNameGroup').hidden = true;
      $('#shareLinkInput').value = '';
      $('#shareImportPreview').hidden = false;
      $('#shareImportPreview').className = 'share-import-preview good';
      $('#shareImportPreview').innerHTML =
        `<b>LIST ADDED TO MY LIBRARY</b><span>${formatCount(recommended)} recommended · ${formatCount(notRecommended)} not recommended · ${formatCount(completed)} fully watched · source: ${esc(label)}</span><small>You can remove this source below at any time. Your own preferences remain separate.</small>`;
      toast(`UserList imported: ${label}`);
    } catch (e) {
      out.classList.add('bad');
      out.textContent = `Rejected. Nothing was imported. ${humanImportError(e.message)}`;
    } finally {
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
    return `<details class="custom-editor optional-editor"><summary class="optional-editor-summary"><div><span>CUSTOM DATA</span><h4>Edit custom metadata</h4></div><b>LOCAL TITLE</b><i class="optional-editor-chevron" aria-hidden="true"></i></summary><div class="optional-editor-body"><p>These fields are included when this title is exported in a signed UserList. Provider-based content ratings are estimates and should be reviewed.</p><button id="refreshCustomMetadata" class="slash-button small" type="button">${x.contentEstimated ? 'REFRESH ESTIMATED METADATA' : 'FIND MISSING METADATA'}</button><div class="custom-editor-grid"><label class="field-label">TITLE<input id="customTitle" type="text" maxlength="180" value="${esc(x.title)}"></label><div class="field-row"><label class="field-label">YEAR<input id="customYear" type="number" min="0" max="2200" value="${Number(x.year) || ''}" placeholder="Unknown"></label><label class="field-label">FORMAT<select id="customType">${formats.map((type) => `<option ${x.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}</select></label></div><label class="field-label">ORIGIN<input id="customOrigin" type="text" maxlength="80" value="${esc(x.origin || '')}" placeholder="Japan / US / China / …"></label><label class="field-label">GENRES / TAGS<textarea id="customGenres" maxlength="500" placeholder="Fantasy, Adventure, Drama">${esc(x.genres || '')}</textarea></label>${contentControls}</div></div></details>`;
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
    return '';
  }

  function customPromotionHTML(x) {
    return '';
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
  function catalogSnapshotForBrowser(item) {
    return {
      scores: Object.fromEntries(
        CATALOG_SCORE_FIELDS.map(([, key]) => [key, Number(item.scores?.[key]) || 0]),
      ),
      content: normalizedContent(item.content),
    };
  }

  function saveCatalogDraft(entry) {
    catalogDrafts[entry.id] = entry;
    save(STORE.catalogCorrections, catalogDrafts);
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
      },
    };
    saveCatalogDraft(entry);
    return entry;
  }

  function correctionCode(entries = Object.values(catalogDrafts)) {
    throw new Error('Legacy catalog correction packages have been removed. Use Editor review instead.');
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

  function syncFilePicker(input) {
    const picker = input?.closest?.('[data-file-picker]');
    if (!picker) return;
    const name = picker.querySelector('[data-file-picker-name]');
    const file = input.files?.[0];
    if (name) name.textContent = file?.name || input.dataset.fileEmptyLabel || 'NO FILE SELECTED';
    picker.classList.toggle('has-file', Boolean(file));
  }

  function initializeFilePickers() {
    $$('[data-file-picker] input[type="file"]').forEach((input) => {
      syncFilePicker(input);
      input.addEventListener('change', () => syncFilePicker(input));
    });
  }

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
        '<b>NO PACKAGE SELECTED</b><span>Select a version 1 release-update JSON file to begin.</span>';
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
    syncFilePicker($('#releaseUpdateFile'));
    selectedReleaseUpdatePackage = null;
    reviewedReleaseUpdates = null;
    $('#clearReleaseUpdates').disabled = true;
    $('#previewReleaseUpdates').disabled = true;
    $('#releaseUpdateFileSummary').innerHTML =
      '<b>NO PACKAGE SELECTED</b><span>Select a version 1 release-update JSON file to begin.</span>';
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
      if (Array.isArray(source.completed)) source.completed = source.completed.filter((id) => id !== x.id);
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
      // A local editor summary intentionally takes precedence over provider text.
      // Provider metadata remains the fallback for catalog records without a local summary.
      m = {
        ...rawMeta,
        description: x.description || rawMeta.description || x.sourceSynopsis || '',
        summaryLanguage: x.summaryLanguage || rawMeta.summaryLanguage || 'en',
        summaryTranslations: {
          ...normalizeSummaryTranslations(rawMeta.summaryTranslations),
          ...normalizeSummaryTranslations(x.summaryTranslations),
        },
      },
      p = pFor(id),
      verdict = ownVerdict(id),
      ops = sourceOpinions(id),
      backdrop = localBackdropFor(x),
      bg = backdrop || localArtworkFor(x);
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
    const summary = titleSummaryData(x, m);
    const officialSignal = x.communitySignal || {};
    const importedRecommendations =
      ops.filter((opinion) => opinion.verdict === 'recommend').length +
      (Number(officialSignal.recommend) || 0);
    const importedNotRecommendations =
      ops.filter((opinion) => opinion.verdict === 'avoid').length + (Number(officialSignal.avoid) || 0);
    const completionOrigins = sourceCompletionOrigins(id);
    const importedCompleted = completionOrigins.length + (Number(officialSignal.completed) || 0);
    const localCommunitySources = new Set([...ops.map((opinion) => opinion.sid), ...completionOrigins]).size;
    const catalogCommunitySources = Math.max(
      Number(officialSignal.lists) || 0,
      Number(officialSignal.completed) || 0,
    );
    const communityLists = localCommunitySources + catalogCommunitySources;
    const importedOpinionSummary =
      importedRecommendations || importedNotRecommendations || importedCompleted
        ? `<section class="imported-opinion-summary" aria-label="Community recommendation summary"><span>COMMUNITY SIGNAL</span><b><i class="rec">${formatCount(importedRecommendations)}</i> RECOMMEND · <i class="no">${formatCount(importedNotRecommendations)}</i> DON'T RECOMMEND · <i class="watched">${formatCount(importedCompleted)}</i> COMPLETED</b><small>From ${formatCount(communityLists)} community ${communityLists === 1 ? 'list' : 'lists'}. These never replace your own recommendation or watch history.</small></section>`
        : '';
    $('#dialogBody').innerHTML =
      `<div class="detail-hero ${backdrop ? 'has-backdrop' : 'has-cover'}">${bg ? `<img class="detail-bg" src="${esc(bg)}" alt="" decoding="async" fetchpriority="high">` : ''}<div class="detail-heading"><div class="kicker">${x.rank ? `MASTER RANK #${formatRank(x.rank)}` : 'CUSTOM ADDITION'} // ${esc(quality)}</div><h2>${esc(x.title)}</h2></div></div><div class="detail-content"><div class="detail-facts">${facts.map((fact) => `<span class="fact">${esc(fact.value)}</span>`).join('')}</div>${aliases.length ? `<p class="detail-aliases"><b>Also known as:</b> ${aliases.map(esc).join(', ')}</p>` : ''}<div class="detail-grid"><div>${detailSummaryHTML(summary)}${x.watch_note ? `<div class="callout"><h4>Watch note</h4><p>${esc(x.watch_note)}</p></div>` : ''}${x.caveat ? `<div class="callout"><h4>Worth knowing</h4><p>${esc(x.caveat)}</p></div>` : ''}${m.siteUrl ? `<a class="external-link" href="${esc(m.siteUrl)}" target="_blank" rel="noopener">OPEN SOURCE ↗</a>` : ''}${awardSectionHTML(x)}${kidSafeDetail ? '' : `<h4>Content</h4>${contentGuide(x, false)}`}<button id="openFullEditor" class="slash-button wide detail-editor-link" type="button">OPEN FULL EDITOR</button>${hasWatchTracker(x) ? `<div id="episodeTrackerMount" class="episode-tracker-mount" data-episode-owner="${esc(x.id)}" data-episode-variant="detail"></div>` : ''}${importedOpinionSummary}</div><aside aria-label="Personal title settings"><div class="user-edit"><button id="modalFavorite" class="favorite-detail ${isFavorite(id) ? 'active' : ''}" type="button">${isFavorite(id) ? '♥ FAVORITE' : '♡ ADD TO FAVORITES'}</button><div class="user-edit-label" id="recommendationLabel">MY RECOMMENDATION</div><div class="verdict-row" role="group" aria-labelledby="recommendationLabel"><button class="verdict-btn rec ${verdict === 'recommend' ? 'active' : ''}" data-v="recommend" type="button">RECOMMEND</button><button class="verdict-btn no ${verdict === 'avoid' ? 'active' : ''}" data-v="avoid" type="button">DON'T RECOMMEND</button><button class="verdict-btn neutral ${!verdict ? 'active' : ''}" data-v="" type="button">NEUTRAL</button></div><label for="modalStatus">WATCH STATUS</label><select id="modalStatus">${['Not started', 'Watching', 'Completed', 'On hold', 'Dropped'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><div class="rating-format-head"><span>MY RATING</span></div><div id="modalRatingEditor">${ratingEditorHTML(p.rating)}</div><small class="rating-scale-help" id="ratingScaleHelp">${esc(ratingScaleHelp())}</small><label for="modalNote">PRIVATE NOTE</label><textarea id="modalNote" maxlength="2000">${esc(p.note || '')}</textarea><button class="slash-button hot wide" id="saveDetail" type="button">SAVE LOCAL DATA</button></div></aside></div></div>`;
    $('#modalStatus').innerHTML = WATCH_STATUSES.map(
      (status) =>
        `<option value="${esc(status)}" ${p.status === status ? 'selected' : ''}>${esc(watchStatusDisplay(status))}</option>`,
    ).join('');
    const profile = curatedProfileHTML(x);
    if (profile) $('.detail-grid > div', $('#dialogBody'))?.insertAdjacentHTML('beforeend', profile);
    $('#dialogBody').dataset.itemId = id;
    $('#detailDialog').classList.toggle('for-kids-detail', kidSafeDetail);
    $$('[data-summary-language]', $('#dialogBody')).forEach((button) =>
      button.addEventListener('click', () => {
        state.summaryLanguage = normalizeSummaryLocale(button.dataset.summaryLanguage);
        saveUIState();
        const selected = titleSummaryData(x, m);
        $('#detailSummaryText').textContent = selected.text;
        $$('[data-summary-language]', $('#dialogBody')).forEach((chip) => {
          const active = chip.dataset.summaryLanguage === selected.activeLanguage;
          chip.classList.toggle('active', active);
          chip.setAttribute('aria-pressed', String(active));
        });
      }),
    );
    const insertFranchiseBanner = () => {
      if ($('#dialogBody').dataset.itemId !== id || $('.detail-franchise-links', $('#dialogBody'))) return;
      const franchiseBanner = franchiseBannerHTML(x);
      if (!franchiseBanner) return;
      $('.detail-facts', $('#dialogBody')).insertAdjacentHTML('afterend', franchiseBanner);
      $$('[data-open-franchise-id]', $('#dialogBody')).forEach((button) =>
        button.addEventListener('click', () => {
          $('#detailDialog').close();
          openFranchiseGuide(button.dataset.openFranchiseId, button.dataset.openFranchiseStep || '');
        }),
      );
    };
    insertFranchiseBanner();
    $('#openFullEditor').onclick = () => {
      $('#detailDialog').close();
      openEditor(id);
    };
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
    if (!x.custom && $('#catalogEditorResult')) {
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
    if (x.custom && $('#refreshCustomMetadata')) {
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
      const stagePromotion = $('#stageCustomPromotion');
      if (stagePromotion)
        stagePromotion.onclick = () => {
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
    };
    if (!$('#detailDialog').open) $('#detailDialog').showModal();
    const episodeMount = $('#episodeTrackerMount');
    // Showing a detail dialog must never wait for episode/franchise rendering
    // or metadata work. Defer those potentially expensive operations until the
    // browser has painted the open dialog once.
    setTimeout(() => {
      if (!$('#detailDialog').open || $('#dialogBody').dataset.itemId !== id) return;
      syncNavigationUrl();
      if (episodeMount) episodeMount.closest('.detail-grid')?.after(episodeMount);
      const franchiseReady = catalogBootstrap ? loadCatalogEntity('franchises') : Promise.resolve();
      void franchiseReady.then(() => {
        if (!$('#detailDialog').open || $('#dialogBody').dataset.itemId !== id) return;
        insertFranchiseBanner();
        // Franchise data must be present before the first tracker render. This
        // prevents details from permanently falling back to provider order and
        // keeps split placements (such as Lost Girls 1-2 / 3) intact.
        if (episodeMount) populateEpisodeMount(episodeMount, x, 'detail');
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
        url = localArtworkFor(x);
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
    const h = $('#heroFeature');
    const artwork = localBackdropFor(x) || localArtworkFor(x);
    h.innerHTML = `${artwork ? `<img class="hero-bg" src="${esc(artwork)}" alt="">` : ''}<div class="feature-rank">#001</div><div class="feature-lines"><span></span><span></span><span></span></div><div class="feature-title">${esc(x.title)}</div><div class="feature-sub">NO. 1 IN THE CURRENT RANKING.</div>`;
    h.classList.toggle('with-image', Boolean(artwork));
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
    if (name === 'editor') renderEditor();
    syncNavigationUrl({ history });
    // The hash is the shareable navigation state; this local value is the
    // durable fallback when a refresh or host strips the hash.
    saveUIState();
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
    renderEditor();
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
    const detailHtml = (target.dataset.tooltipHtml || '').trim();
    globalTooltip.classList.toggle('tooltip--detail', Boolean(detailHtml));
    if (detailHtml) globalTooltip.innerHTML = detailHtml;
    else globalTooltip.textContent = message;
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
    globalTooltip.classList.remove('tooltip--detail');
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
    const x = masterItems.find((x) => pFor(x.id).status !== 'Watched');
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
  // Every filter control writes the local UI snapshot as a safety net. Individual
  // handlers still own their data refresh, but no valid filter can be lost simply
  // because a new view forgot to add a persistence call.
  [...new Set([...UI_VALUE_FIELDS, ...UI_CHECKBOX_FIELDS])].forEach((id) =>
    $('#' + id)?.addEventListener('change', saveUIState),
  );
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
    'awardFilter',
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
  $$('[data-cover-mode]').forEach((button) =>
    button.addEventListener('click', () => setCoverPackMode(button.dataset.coverMode)),
  );
  $$('[data-catalog-update-mode]').forEach((button) =>
    button.addEventListener('click', () => setCatalogUpdateMode(button.dataset.catalogUpdateMode)),
  );
  $('#checkLibraryUpdates').addEventListener('click', () => {
    void syncCatalogFromCoverStorage({ manual: true });
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
    'adultAwardFilter',
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
    saveUIState();
    refreshCatalogDestination('master', renderMaster);
  });
  $('#westernLoadMoreBtn').addEventListener('click', () => {
    state.westernVisible += PAGE_SIZE;
    saveUIState();
    refreshCatalogDestination('regions', renderWestern);
  });
  $('#kidsLoadMoreBtn').addEventListener('click', () => {
    state.kidsVisible += PAGE_SIZE;
    saveUIState();
    refreshCatalogDestination('kids', renderKids);
  });
  $('#viewToggle').addEventListener('click', () => {
    state.compact = !state.compact;
    save(STORE.compact, state.compact);
    saveUIState();
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
    openEditorConsole();
  });
  $$('[data-editor-mission]').forEach((button) =>
    button.addEventListener('click', () => startEditorMission(button.dataset.editorMission)),
  );
  $('#editorNewBtn')?.addEventListener('click', () => startEditorMission('new-title'));
  $$('[data-editor-pane]', $('#editorWorkflowNav')).forEach((button) =>
    button.addEventListener('click', () => setEditorPane(button.dataset.editorPane)),
  );
  $('#editorTitleSearch').addEventListener('input', () => renderEditorSearch($('#editorTitleSearch').value));
  $('#editorFranchiseSearch').addEventListener('input', () =>
    renderEditorFranchiseSearch($('#editorFranchiseSearch').value),
  );
  $('#editorForm').addEventListener('submit', saveEditorDraft);
  $('#editorFranchise').addEventListener('input', () => renderEditorFranchiseBuilder());
  $('#editorEpisodes').addEventListener('input', () => renderEditorEpisodeBuilder());
  $('#editorAddSummaryLanguage').addEventListener('click', addEditorSummaryTranslation);
  $('#editorAddAward').addEventListener('click', () => {
    const awards = editorAwardsValue();
    awards.push({ name: '', year: new Date().getFullYear(), result: 'Winner' });
    writeEditorAwards(awards);
  });
  $('#editorExportBtn').addEventListener('click', openEditorPackage);
  $$('[data-editor-export-package]').forEach((button) =>
    button.addEventListener('click', exportEditorPackage),
  );
  $('#editorPublishShare').addEventListener('click', () =>
    publishShareLink('editor-review', $('#editorExportCode').value),
  );
  $('#editorCopyShare').addEventListener('click', () =>
    copyShareLink($('#editorShareLink'), 'Editor review'),
  );
  $('#editorPreviewOfficial').addEventListener('click', previewOfficialEditorReview);
  $('#editorApplyOfficial').addEventListener('click', applyOfficialEditorReview);
  $('#collectionSearch').addEventListener('input', () => {
    saveUIState();
    renderCollections();
  });
  $('#franchiseSearch').addEventListener('input', () => {
    scheduleSearch(renderFranchises, () => {});
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
  $('#publishListShare').addEventListener('click', () =>
    publishShareLink('recommendation-list', $('#exportCode').value),
  );
  $('#copyListShare').addEventListener('click', () =>
    copyShareLink($('#listShareLink'), 'Recommendation list'),
  );
  $('#previewShareLink').addEventListener('click', previewShareLink);
  $('#applyShareLink').addEventListener('click', applyShareLink);
  $('#applyShareCommunity').addEventListener('click', applyShareCommunitySignal);
  $('#shareImportBtn').addEventListener('click', () => {
    switchTab('userlist');
    $('#shareImportPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#shareLinkInput').focus();
  });
  initializeFilePickers();
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
  $('#addTitleForm')?.addEventListener('submit', addTitle);
  $('#addTitleType')?.addEventListener('change', (event) => {
    if (event.target.value === 'Adult / Hentai') $('#addTitleAdult').checked = true;
  });
  $('#dialogClose')?.addEventListener('click', () => $('#detailDialog').close());
  $('#collectionClose').addEventListener('click', () => $('#collectionDialog').close());
  document.addEventListener('click', (event) => {
    if (!pendingButtonConfirmation || !(event.target instanceof Element)) return;
    if (event.target.closest('button') !== pendingButtonConfirmation.button) cancelButtonConfirmation();
  });
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
  $('#coverPackLater').addEventListener('click', () => {
    state.dismissedCoverPackHash = availableCoverPack?.sha256 || '';
    saveUIState();
    $('#coverPackDialog').close();
  });
  $('#coverPackOptOut').addEventListener('click', () => {
    state.coverArtworkMode = 'never';
    state.dismissedCoverPackHash = availableCoverPack?.sha256 || '';
    renderCoverPackMode();
    availableCoverPack = null;
    saveUIState();
    if ($('#coverPackDialog').open) $('#coverPackDialog').close();
    toast('Cover-pack checks disabled');
  });
  $('#installCoverPackBtn').addEventListener('click', installCoverPack);
  $('#coverPackDialog').addEventListener('click', (event) => {
    if (event.target === $('#coverPackDialog')) $('#coverPackDialog').close();
  });

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
      'editor',
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
  const tabs = [
    'master',
    'regions',
    'collections',
    'franchises',
    'adult',
    'kids',
    'favorites',
    'editor',
    'userlist',
  ];
  const hash = location.hash.replace('#', '');
  const rememberedTab = typeof savedUI.activeTab === 'string' ? savedUI.activeTab : '';
  const initialTab = tabs.includes(hash) ? hash : tabs.includes(rememberedTab) ? rememberedTab : 'master';
  state.tab = initialTab;
  // Initialise the controls for the destination being opened before any slow
  // health or update check runs. Otherwise a user can select a Region while
  // the page is visible and have that selection overwritten by late state
  // restoration.
  ensureDestinationFilters(initialTab);
  // Some destination controls are created lazily. Restore the local snapshot
  // again once those controls exist, then let an explicitly shared URL win.
  restoreUIState();
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
  if (initialTab === 'editor') renderEditor();
  if (initialTab === 'userlist') renderUserSummary();
  renderInterfaceLanguages();
  checkOfficialTranslationUpdate();
  renderReleaseUpdateHistory();
  updateHero();
  await checkServer();
  void hourlyLibrarySync();
  // Catalog and app updates run for every installation. Cover-package checks
  // remain opt-in inside hourlyLibrarySync via checkCoverPack().
  setInterval(
    () => {
      void hourlyLibrarySync();
    },
    1000 * 60 * 60,
  );
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
