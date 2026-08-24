import { combineUserData, createUserBackup, summarizeUserData, validateUserBackup } from './user-backup.js';
import {
  normalizeRatingFormat,
  personalRatingTier,
  personalTierOptions,
  qualityRatingLabel,
} from './rating-format.js';

(async () => {
  'use strict';
  const APP_VERSION = '2.3.2';
  const catalogResponse = await fetch('catalog.json');
  if (!catalogResponse.ok) throw new Error(`Could not load catalog (${catalogResponse.status})`);
  const CAT = await catalogResponse.json();
  const PAGE_SIZE = 60;
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
    series: 'uai:series-groups:v5',
    catalogCorrections: 'uai:catalog-corrections:v1',
    dismissedUpdate: 'uai:dismissed-update:v1',
    ratingFormatOnboardingSeen: 'uai:rating-format-onboarding:v2',
  };
  const $ = (s, r = document) => r.querySelector(s),
    $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v = '') =>
    String(v).replace(
      /[&<>'"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[c],
    );
  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v ?? d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const savedUI = load(STORE.ui, {});
  const ADULT_CATALOG_TAG = 'Adult Catalog';
  const adultModes = ['all', 'ecchi', 'erotic', 'hentai', 'gore', 'violence', 'disturbing'];
  const collectionSortModes = ['rating', 'release', 'name'];
  const collectionSortOrders = ['asc', 'desc'];
  const masterSortOrders = ['asc', 'desc'];
  const titleSortModes = ['rank', 'overall', 'production', 'story', 'emotional', 'year', 'title', 'myrating'];
  const state = {
    visible: PAGE_SIZE,
    compact: load(STORE.compact, false),
    tab: 'master',
    adult: adultModes.includes(savedUI.adult) ? savedUI.adult : 'all',
    collectionSort: collectionSortModes.includes(savedUI.collectionSort) ? savedUI.collectionSort : 'rating',
    collectionSortOrder: collectionSortOrders.includes(savedUI.collectionSortOrder)
      ? savedUI.collectionSortOrder
      : 'desc',
    masterSortOrder: masterSortOrders.includes(savedUI.masterSortOrder) ? savedUI.masterSortOrder : 'desc',
    adultSortOrder: masterSortOrders.includes(savedUI.adultSortOrder) ? savedUI.adultSortOrder : 'desc',
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
  };
  let progress = load(STORE.progress, {}),
    myOpinions = load(STORE.opinions, {}),
    customTitles = load(STORE.custom, []),
    sources = load(STORE.sources, {}),
    meta = load(STORE.meta, {}),
    favorites = load(STORE.favorites, {}),
    episodeProgress = load(STORE.episodes, {}),
    seriesGroups = load(STORE.series, {}),
    catalogDrafts = load(STORE.catalogCorrections, {});
  const META_TTL = 1000 * 60 * 60 * 24 * 30;
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
  const masterItems = CAT.items || [];
  const masterById = new Map(masterItems.map((x) => [x.id, x]));
  const aliasMap = new Map();

  // Catalog identity and local state helpers
  function norm(s = '') {
    return String(s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\b(the|a|an)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  masterItems.forEach((x) => {
    aliasMap.set(norm(x.title), x.id);
    (x.aliases || []).forEach((a) => aliasMap.set(norm(a), x.id));
  });
  function itemWithCatalogDraft(item) {
    const draft = catalogDrafts[item?.id];
    if (!item || draft?.operation !== 'update') return item;
    return {
      ...item,
      scores: { ...draft.values.scores },
      content: { ...draft.values.content, tags: [...draft.values.content.tags] },
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
    renderFavorites();
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
      : (x.genres || '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
  }

  // Master-list filtering and sorting
  function populateFilters() {
    const items = canonicalItems();
    fill(
      $('#tierFilter'),
      [...new Set(items.map((x) => x.tier).filter(Boolean))].sort(
        (a, b) =>
          ['S+', 'S', 'A+', 'A', 'B+', 'B', 'CUSTOM'].indexOf(a) -
          ['S+', 'S', 'A+', 'A', 'B+', 'B', 'CUSTOM'].indexOf(b),
      ),
      (tier) => qualityRatingLabel(tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }),
    );
    renderStarTierFilter();
    fill($('#typeFilter'), [...new Set(items.map(displayType).filter(Boolean))].sort());
    fill(
      $('#genreFilter'),
      [
        ...new Set(items.flatMap((x) => (x.genres || '').split(',').map((g) => g.trim())).filter(Boolean)),
      ].sort(),
    );
    populateAdultFilters();
  }
  function populateAdultFilters() {
    const items = adultFilterItems();
    fill(
      $('#adultTierFilter'),
      [...new Set(items.map((x) => x.tier).filter(Boolean))].sort(
        (a, b) =>
          ['S+', 'S', 'A+', 'A', 'B+', 'B', 'CUSTOM'].indexOf(a) -
          ['S+', 'S', 'A+', 'A', 'B+', 'B', 'CUSTOM'].indexOf(b),
      ),
      (tier) => qualityRatingLabel(tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }),
    );
    renderStarTierFilter('adultTierFilter', 'adultStarTierFilter');
    fill($('#adultTypeFilter'), [...new Set(items.map(displayType).filter(Boolean))].sort());
    fill($('#adultGenreFilter'), [...new Set(items.flatMap(liveGenres).filter(Boolean))].sort());
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
  const UI_CHECKBOX_FIELDS = ['hideCompleted', 'customOnly'];

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
    renderSortOrderButton($('#adultSortOrder'), state.adultSortOrder);
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
      adultSortOrder: state.adultSortOrder,
      ratingFormat: state.ratingFormat,
    };
    for (const id of UI_VALUE_FIELDS) next[id] = $('#' + id).value;
    for (const id of UI_CHECKBOX_FIELDS) next[id] = $('#' + id).checked;
    save(STORE.ui, next);
  }

  function filteredMaster() {
    const all = canonicalItems(),
      q = $('#searchInput').value.trim().toLowerCase(),
      tier = $('#tierFilter').value,
      type = $('#typeFilter').value,
      genre = $('#genreFilter').value,
      status = $('#statusFilter').value;
    let out = all.filter((x) => {
      const p = pFor(x.id),
        m = meta[x.id]?.data || {};
      const hay =
        `${x.title} ${(x.aliases || []).join(' ')} ${x.genres || ''} ${x.editorial_note || x.why || ''} ${m.studio || ''}`.toLowerCase();
      if (q && !hay.includes(q)) return false;
      if (tier && x.tier !== tier) return false;
      if (type && displayType(x) !== type) return false;
      if (
        genre &&
        !(x.genres || '')
          .split(',')
          .map((v) => v.trim())
          .includes(genre)
      )
        return false;
      if (status && p.status !== status) return false;
      if ($('#hideCompleted').checked && p.status === 'Completed') return false;
      if ($('#customOnly').checked && !x.custom) return false;
      return true;
    });
    return sortTitleItems(out, $('#sortSelect').value, state.masterSortOrder);
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
      out.sort((a, b) => compareKnownNumbers(a, b, (item) => pFor(item.id).rating || 0) || rank(a) - rank(b));
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
    const rank = x.rank ? `#${String(x.rank).padStart(3, '0')}` : 'ADD';
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
      <div class="cover">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="${esc(x.title)} cover">` : `<div class="cover-placeholder">${esc(initials(x.title))}</div>`}<span class="rank">${rank}</span><span class="tier">${tierBadge}</span><button class="favorite-toggle ${fav ? 'active' : ''}" data-fav-id="${esc(x.id)}" type="button" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" data-tooltip="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '♥' : '♡'}</button>${statusMarkHTML(p.status)}${verdictBadge}</div>
      <div class="card-body"><div class="card-meta">${esc(displayType(x).toUpperCase())} // ${esc(liveYear(x))} // ${esc((m.studio || x.origin || '').toUpperCase())}</div><h3>${esc(x.title)}</h3>
      <div class="tag-row">${tags.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>${sourceBadgesHTML(x.id)}${content}
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
    $('#resultCount').textContent = all.length;
    const shown = all.slice(0, state.visible);
    const root = $('#cards');
    root.classList.toggle('compact', state.compact);
    root.innerHTML = shown.length
      ? shown.map((x) => cardHTML(x)).join('')
      : '<div class="empty-state">Nothing matches those filters.</div>';
    $('#loadMoreBtn').parentElement.classList.toggle('hidden', state.visible >= all.length);
    bindCards(root);
    updateStats();
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
    $('#statStrip').innerHTML =
      `<div class="stat"><b>${items.length}</b><span>TITLES</span></div><div class="stat"><b>${films}</b><span>FILMS / FILM SERIES</span></div><div class="stat"><b>${CAT.collections.length}</b><span>COLLECTIONS</span></div><div class="stat"><b>${CAT.franchises.length}</b><span>FRANCHISE GUIDES</span></div><div class="stat"><b>${covers}<strong class="stat-operator">/</strong>${coverTotal}</b><span>${state.serverCoverRunning ? 'ARTWORK CACHING' : 'ARTWORK CACHED'}</span></div><div class="stat"><b>${favCount}</b><span>FAVORITES</span></div><div class="stat"><b>${completed}${watching ? `<strong class="stat-operator">+</strong>${watching}` : ''}</b><span>${watching ? 'COMPLETED + WATCHING' : 'COMPLETED'}</span></div>`;
    renderUserSummary();
  }

  // Favorites and adult-content views
  function renderFavorites() {
    const input = $('#favoriteSearch');
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    const arr = canonicalItems()
      .filter((x) => isFavorite(x.id))
      .filter((x) => {
        if (!q) return true;
        const m = meta[x.id]?.data || {};
        return `${x.title} ${(x.aliases || []).join(' ')} ${x.genres || ''} ${m.studio || ''}`
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999) || a.title.localeCompare(b.title));
    $('#favoriteCount').textContent = `${arr.length} FAVORITE${arr.length === 1 ? '' : 'S'}`;
    const root = $('#favoriteCards');
    root.innerHTML = arr.length
      ? arr.map((x) => cardHTML(x)).join('')
      : q
        ? '<div class="empty-state">No favorites match that search.</div>'
        : '<div class="empty-state">No favorites yet. Use the heart on any title to add it here.</div>';
    bindCards(root);
    queueMetadata(arr, { priority: true });
  }

  function matchesAdult(x, mode = 'all') {
    const c = x.content || {},
      tags = (c.tags || []).map((t) => t.toLowerCase()),
      g = (x.genres || '').toLowerCase(),
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
    const q = $('#adultSearch').value.trim().toLowerCase(),
      tier = $('#adultTierFilter').value,
      type = $('#adultTypeFilter').value,
      genre = $('#adultGenreFilter').value,
      status = $('#adultStatusFilter').value;
    const filtered = adultFilterItems().filter((x) => {
      if (!q) return true;
      const m = meta[x.id]?.data || {};
      const hay =
        `${x.title} ${(x.aliases || []).join(' ')} ${x.genres || ''} ${x.editorial_note || x.why || ''} ${m.studio || ''}`.toLowerCase();
      return hay.includes(q);
    });
    const narrowed = filtered.filter((x) => {
      if (tier && x.tier !== tier) return false;
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
      b.textContent = `${labels[mode]} · ${adultFilterItems(mode).length}`;
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
    $('#collectionCount').textContent = `${all.length} COLLECTIONS`;
    $('#collectionGrid').innerHTML = all.length
      ? all
          .map(
            (c) =>
              `<button class="collection-card" data-cid="${esc(c.id)}" type="button"><span class="collection-kind">${esc(c.kind.toUpperCase())}</span><h3>${esc(c.name)}</h3><p>${esc(c.description)}</p><span class="collection-mode">${esc(c.mode.toUpperCase())}</span><span class="collection-count">${c.items.length}</span></button>`,
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
    const arr = c.items.map(itemById).filter(Boolean);
    const rank = (item) => item.rank ?? 999999;
    const direction = state.collectionSortOrder === 'asc' ? 1 : -1;
    const compareKnownNumbers = (a, b, value) => {
      const aKnown = Boolean(value(a));
      const bKnown = Boolean(value(b));
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return (value(a) - value(b)) * direction;
    };
    if (state.collectionSort === 'release')
      arr.sort((a, b) => compareKnownNumbers(a, b, (item) => item.year || 0) || rank(a) - rank(b));
    else if (state.collectionSort === 'name')
      arr.sort((a, b) => a.title.localeCompare(b.title) * direction || rank(a) - rank(b));
    else
      arr.sort((a, b) => {
        const aRanked = Number.isFinite(a.rank);
        const bRanked = Number.isFinite(b.rank);
        if (aRanked !== bRanked) return aRanked ? -1 : 1;
        return (rank(b) - rank(a)) * direction || a.title.localeCompare(b.title);
      });
    const descending = state.collectionSortOrder === 'desc';
    const orderIcon = sortOrderIconHTML(descending);
    $('#collectionBody').innerHTML =
      `<div class="collection-detail"><div class="meta">${esc(c.kind.toUpperCase())} // ${esc(c.mode.toUpperCase())} // ${arr.length} TITLES</div><h2>${esc(c.name)}</h2><p>${esc(c.description)}</p><div class="collection-title-tools"><label><span>SORT BY</span><select id="collectionTitleSort" aria-label="Sort collection titles by"><option value="rating" ${state.collectionSort === 'rating' ? 'selected' : ''}>RATING</option><option value="release" ${state.collectionSort === 'release' ? 'selected' : ''}>RELEASE DATE</option><option value="name" ${state.collectionSort === 'name' ? 'selected' : ''}>NAME</option></select></label><div class="collection-sort-order"><span>ORDER</span><button id="collectionSortOrder" type="button" aria-label="Change to ${descending ? 'ascending' : 'descending'} order" data-tooltip="Change to ${descending ? 'ascending' : 'descending'} order">${orderIcon}<b>${descending ? 'DESC' : 'ASC'}</b></button></div></div><div class="collection-title-list">${arr.map((x) => `<button class="collection-title" data-id="${esc(x.id)}" type="button"><b>${x.rank ? `#${String(x.rank).padStart(3, '0')}` : 'ADD'}</b><span>${esc(x.title)}${x.year ? ` <small>(${x.year})</small>` : ''}</span><em>${esc(qualityRatingLabel(x.tier, state.ratingFormat, { suffix: state.ratingFormat === 'ten' }))}</em></button>`).join('')}</div></div>`;
    const dialog = $('#collectionDialog');
    if (!dialog.open) dialog.showModal();
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
    const descending = order === 'desc';
    button.innerHTML = `${sortOrderIconHTML(descending)}<b>${descending ? 'DESC' : 'ASC'}</b>`;
    button.setAttribute('aria-label', `Change to ${descending ? 'ascending' : 'descending'} order`);
    button.dataset.tooltip = `Change to ${descending ? 'ascending' : 'descending'} order`;
    button.removeAttribute('title');
  }

  // One sparse episode state is shared by title details and franchise guides.
  const EPISODE_STATES = ['unwatched', 'watching', 'watched'];

  function canTrackEpisodes(x) {
    if (!x || !['anilist', 'tvmaze'].includes(x.api)) return false;
    return /series|tv|ova|ona|special/i.test(`${x.type || ''} ${meta[x.id]?.data?.format || ''}`);
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

  async function loadSeriesGroup(x, { force = false } = {}) {
    if (!canTrackEpisodes(x)) return null;
    const cached = cachedSeriesGroup(x);
    if (!force && cached && !seriesGroupNeedsRefresh(cached)) return cached;
    if (!state.server) {
      if (cached) return cached;
      throw new Error('Series metadata service is offline.');
    }
    if (seriesLoading.has(x.id)) return seriesLoading.get(x.id);
    const task = (async () => {
      const response = await fetch(
        `/api/series?kind=${encodeURIComponent(x.api)}&title=${encodeURIComponent(x.lookupTitle || x.title)}`,
        { cache: force ? 'reload' : 'default' },
      );
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
      if (!matches) throw new Error('The provider returned a different series.');
      seriesGroups[x.id] = { ts: Date.now(), data: result.data };
      save(STORE.series, seriesGroups);
      return result.data;
    })().finally(() => seriesLoading.delete(x.id));
    seriesLoading.set(x.id, task);
    return task;
  }

  function trackerSeasonLabels(entries) {
    let season = 0;
    return entries.map((entry) => {
      if (['TV', 'TV_SHORT', 'ONA'].includes(entry.format)) {
        season++;
        return `S${String(season).padStart(2, '0')}`;
      }
      if (entry.format === 'MOVIE') return 'FILM';
      if (entry.format === 'SPECIAL') return 'SP';
      if (entry.format === 'OVA') return 'OVA';
      return entry.format || 'PART';
    });
  }

  function episodeProgressMeterHTML(ratio, className) {
    const percentage = Math.max(0, Math.min(100, Number(ratio || 0) * 100));
    return `<span class="${className}" aria-hidden="true"><svg class="episode-progress-svg" viewBox="0 0 100 4" preserveAspectRatio="none"><rect class="episode-progress-track" width="100" height="4"></rect><rect class="episode-progress-fill" width="${percentage}" height="4"></rect></svg></span>`;
  }

  function episodeTrackerHTML(owner, group, variant = 'detail') {
    const groupStats = groupEpisodeStats(group);
    const completed = Boolean(groupStats.total && groupStats.watched === groupStats.total);
    const labels = trackerSeasonLabels(group.entries);
    const firstIncomplete = Math.max(
      0,
      group.entries.findIndex((entry) => {
        const stats = entryEpisodeStats(entry);
        return stats.total && stats.watched < stats.total;
      }),
    );
    const percentage = groupStats.total ? Math.round((groupStats.watched / groupStats.total) * 100) : 0;
    const liveStatus = seriesGroupNeedsRefresh(group)
      ? '<span class="series-live-status"><i></i>RELEASING // CHECKED ON OPEN</span>'
      : '';
    const completionLabel = variant === 'franchise' ? 'FRANCHISE COMPLETED' : 'SERIES COMPLETED';
    return `<section class="episode-tracker ${variant === 'franchise' ? 'franchise-tracker' : ''} ${completed ? 'is-complete' : ''}"><header class="episode-tracker-head"><div><span>${variant === 'franchise' ? 'FRANCHISE PROGRESS' : 'UNIFIED SERIES PROGRESS'}</span><h4>${esc(owner.title)}</h4>${liveStatus}</div><div class="episode-total"><b>${groupStats.watched}<i>/</i>${groupStats.total}</b><span>EPISODES WATCHED</span></div></header><div class="episode-overview ${completed ? 'is-complete' : ''}">${completed ? `<span class="episode-complete-label"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.2 3.2 7.8-8"></path></svg>${completionLabel}</span>` : ''}${episodeProgressMeterHTML(percentage / 100, 'episode-overview-meter')}<b>${percentage}%</b></div><div class="episode-key" aria-label="Episode status legend"><span class="unwatched">UNWATCHED</span><span class="watching">WATCHING</span><span class="watched">WATCHED</span></div><div class="season-stack">${group.entries
      .map((entry, index) => {
        const stats = entryEpisodeStats(entry);
        const state =
          stats.total && stats.watched === stats.total ? 'watched' : stats.touched ? 'watching' : 'unwatched';
        const ratio = stats.total ? stats.watched / stats.total : 0;
        const episodes = stats.total
          ? Array.from({ length: stats.total }, (_, episodeIndex) => {
              const number = episodeIndex + 1;
              const status = episodeState(entry, number);
              const episodeCode = `E${String(number).padStart(2, '0')}`;
              const episodeName = String(entry.episodeTitles?.[episodeIndex] || '').trim();
              const episodeText = episodeName ? `${episodeCode}: ${episodeName}` : episodeCode;
              return `<button class="episode-button ${status}" type="button" data-episode-action="cycle" data-entry-id="${esc(entry.id)}" data-episode="${number}" aria-label="${esc(`${entry.title}, ${episodeText}: ${status}`)}" data-tooltip="${esc(`${episodeText}: ${status}`)}"><span class="episode-number">${episodeCode}</span>${episodeName ? `<span class="episode-name">${esc(episodeName)}</span>` : '<span class="episode-name episode-name-pending">Episode title unavailable</span>'}<i></i></button>`;
            }).join('')
          : '<div class="episode-empty">Episode count is not available from the provider.</div>';
        const episodeLabel = stats.total
          ? `${stats.total} episode${stats.total === 1 ? '' : 's'}`
          : 'Episode count pending';
        return `<details class="season-row ${state}" ${index === firstIncomplete ? 'open' : ''}><summary><span class="season-code">${esc(labels[index])}</span>${entry.cover ? `<img src="${esc(entry.cover)}" alt="" loading="lazy">` : ''}<span class="season-copy"><b>${esc(entry.title)}</b><small>${esc([entry.year || '', entry.format || '', episodeLabel].filter(Boolean).join(' // '))}</small>${episodeProgressMeterHTML(ratio, 'season-meter')}</span><span class="season-count"><b>${stats.watched}/${stats.total}</b><small>${state}</small></span><span class="season-chevron">+</span></summary><div class="season-episodes"><div class="season-actions"><button type="button" data-episode-action="continue" data-entry-id="${esc(entry.id)}">NEXT EPISODE</button><button type="button" data-episode-action="all-watched" data-entry-id="${esc(entry.id)}">MARK SEASON WATCHED</button><button type="button" data-episode-action="reset" data-entry-id="${esc(entry.id)}">RESET</button></div><div class="episode-grid">${episodes}</div></div></details>`;
      })
      .join('')}</div></section>`;
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
    if (variant === 'franchise') syncFranchiseCompletionState(mount, group);
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
        if (state.tab === 'adult') renderAdult();
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

  async function populateEpisodeMount(mount, owner, variant = 'detail') {
    mount.dataset.episodeOwner = owner.id;
    mount.dataset.episodeVariant = variant;
    mount.innerHTML = '<div class="episode-loading"><i></i><span>Loading connected seasons…</span></div>';
    try {
      const group = await loadSeriesGroup(owner);
      if (!group || !document.contains(mount)) return;
      mountEpisodeTracker(mount, owner, group, variant);
    } catch (error) {
      if (!document.contains(mount)) return;
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
      const item = findEquivalent({ title: step.title, year: 0, type: 'Series' }, all);
      if (item && canTrackEpisodes(item)) return item;
    }
    return null;
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

  function renderFranchises() {
    const q = $('#franchiseSearch').value.trim().toLowerCase();
    const arr = CAT.franchises.filter(
      (f) => !q || `${f.name} ${f.summary} ${JSON.stringify(f.orders)}`.toLowerCase().includes(q),
    );
    $('#franchiseCount').textContent = `${arr.length} GUIDES`;
    $('#franchiseStack').innerHTML = arr.length
      ? arr
          .map((f, i) => {
            const representative = franchiseRepresentative(f);
            const cachedGroup = representative ? cachedSeriesGroup(representative) : null;
            const cachedStats = groupEpisodeStats(cachedGroup);
            const completed = Boolean(cachedStats.total && cachedStats.watched === cachedStats.total);
            return `<details class="franchise ${completed ? 'is-completed' : ''}" ${representative ? `data-series-owner="${esc(representative.id)}"` : ''}><summary><span class="franchise-no">${String(i + 1).padStart(2, '0')}</span><h3>${esc(f.name)}</h3>${franchiseCompletionBadgeHTML()}<span class="franchise-chevron">+</span></summary><div class="franchise-body"><p class="franchise-summary">${esc(f.summary)}</p>${representative ? `<div class="episode-tracker-mount franchise-episode-mount" data-episode-owner="${esc(representative.id)}" data-episode-variant="franchise"></div>` : ''}${f.orders.map((o) => `<section class="order-block"><h4>${esc(o.label)}</h4>${o.note ? `<p class="order-note">${esc(o.note)}</p>` : ''}<div class="steps">${o.steps.map((s) => `<div class="step"><span class="step-n">${esc(s.n)}</span><span class="step-title">${esc(s.title)}${s.note ? `<small class="step-note">${esc(s.note)}</small>` : ''}</span><span class="flag ${esc(s.flag)}">${esc(s.flag)}</span></div>`).join('')}</div></section>`).join('')}</div></details>`;
          })
          .join('')
      : '<div class="empty-state">No franchise guides match that search.</div>';
    $$('.franchise.is-completed .franchise-completion', $('#franchiseStack')).forEach(
      (badge) => (badge.hidden = false),
    );
    $$('details.franchise[data-series-owner]', $('#franchiseStack')).forEach((details) =>
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.seriesLoaded) return;
        details.dataset.seriesLoaded = '1';
        const owner = itemById(details.dataset.seriesOwner);
        const mount = $('.franchise-episode-mount', details);
        if (owner && mount) populateEpisodeMount(mount, owner, 'franchise');
      }),
    );
  }

  // Server availability and UserList sharing
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
      $('#securityState').classList.toggle('ok', state.signerCompatible);
      $('#securityState').classList.toggle('bad', !state.signerCompatible);
      $('#securityState').innerHTML = state.signerCompatible
        ? `<b>PORTABLE USERLIST // ${esc(state.signerFormat)}</b><span>Ed25519 signing is ready · key ${esc(state.keyId)}</span>`
        : '<b>SERVER RESTART REQUIRED</b><span>The page is newer than the running server. Restart npm start, then reload.</span>';
      updateStats();
      queueMetadata(filteredMaster().slice(0, state.visible), { priority: true });
      pumpMetadata();
      hydrateMissingCustomMetadata();
      renderCorrectionWorkspace();
    } catch {
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

  function storeUserDataAtomically(data) {
    const updates = [
      [STORE.progress, data.progress],
      [STORE.opinions, data.opinions],
      [STORE.custom, data.customTitles],
      [STORE.sources, data.sources],
      [STORE.favorites, data.favorites],
      [STORE.episodes, data.episodeProgress],
      [STORE.ui, data.ui],
      [STORE.compact, data.compact],
    ];
    const previous = new Map(updates.map(([key]) => [key, localStorage.getItem(key)]));
    try {
      updates.forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(value)));
    } catch (error) {
      updates.forEach(([key]) => localStorage.removeItem(key));
      for (const [key, value] of previous) {
        if (value !== null) localStorage.setItem(key, value);
      }
      throw error;
    }
  }

  function importUserBackup() {
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
      storeUserDataAtomically(next);
      sessionStorage.setItem(
        'uai:backup-import-message',
        mode === 'replace' ? 'Private backup restored' : 'Private backup merged',
      );
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
      ...customTitles.filter((x) => x.addedByMe).map((x) => x.id),
      ...opinionEntries.map((o) => o.id).filter((id) => !masterById.has(id)),
    ]);
    const titleEntries = customTitles
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
      populateFilters();
      renderAll();
      hydrateMissingCustomMetadata();
      out.classList.add('good');
      out.textContent = `Verified key ${j.keyId}. ${newCount} new title${newCount === 1 ? '' : 's'}, ${mergedCount} merged without duplicates, ${payload.opinions.length} opinions attached to “${label}”.`;
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
    return `<details class="custom-editor optional-editor"><summary class="optional-editor-summary"><div><span>CUSTOM DATA</span><h4>Edit custom metadata</h4></div><b>LOCAL TITLE</b><i class="optional-editor-chevron" aria-hidden="true"></i></summary><div class="optional-editor-body"><p>These fields are included when this title is exported in a signed UserList. Provider-based content ratings are estimates and should be reviewed.</p><button id="refreshCustomMetadata" class="slash-button small" type="button">${x.contentEstimated ? 'REFRESH ESTIMATED METADATA' : 'FIND MISSING METADATA'}</button><div class="custom-editor-grid"><label class="field-label">TITLE<input id="customTitle" type="text" maxlength="180" value="${esc(x.title)}"></label><div class="field-row"><label class="field-label">YEAR<input id="customYear" type="number" min="0" max="2200" value="${Number(x.year) || ''}" placeholder="Unknown"></label><label class="field-label">FORMAT<select id="customType">${formats.map((type) => `<option ${x.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}</select></label></div><label class="field-label">ORIGIN<input id="customOrigin" type="text" maxlength="80" value="${esc(x.origin || '')}" placeholder="Japan / US / China / …"></label><label class="field-label">GENRES / TAGS<textarea id="customGenres" maxlength="500" placeholder="Fantasy, Adventure, Drama">${esc(x.genres || '')}</textarea></label><label class="field-label">CONTENT LABELS<input id="customContentTags" type="text" maxlength="500" value="${esc(content.tags.join(', '))}" placeholder="Ecchi, Gore, Adult Only, …"></label>${adultCatalogToggleHTML(content, 'customAdult')}<div class="custom-content-fields">${levels.map(([label, key]) => `<label>${esc(label)}<input id="customContent-${key}" type="number" min="0" max="5" step="1" value="${content[key]}"><span>/5</span></label>`).join('')}</div></div></div></details>`;
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
    return `<label class="field-label">CONTENT LABELS<input id="${prefix}-tags" type="text" maxlength="500" value="${esc(normalized.tags.join(', '))}" placeholder="Ecchi, Gore, Adult Only, …"></label>${adultCatalogToggleHTML(normalized, `${prefix}-adult`)}<div class="custom-content-fields">${CATALOG_CONTENT_FIELDS.map(([label, key]) => `<label>${esc(label)}<input id="${prefix}-${key}" type="number" min="0" max="5" step="1" value="${normalized[key]}" required><span>/5</span></label>`).join('')}</div>`;
  }

  function adultCatalogToggleHTML(content, id) {
    return `<label class="adult-catalog-toggle" for="${id}"><input id="${id}" type="checkbox" ${isAdultCatalogTitle(content) ? 'checked' : ''}><span aria-hidden="true"></span><b>PROMOTE TO MATURE CONTENT</b><small>Explicitly includes this title in the Mature Content section.</small></label>`;
  }

  function catalogCorrectionEditorHTML(x) {
    const pending = Boolean(catalogDrafts[x.id]);
    return `<details class="catalog-editor optional-editor ${pending ? 'has-draft' : ''}"><summary class="catalog-editor-head optional-editor-summary"><div><span>CURATED DATA</span><h4>Edit catalog ratings</h4></div><b>${pending ? 'DRAFT SAVED' : 'CATALOG VALUES'}</b><i class="optional-editor-chevron" aria-hidden="true"></i></summary><div class="optional-editor-body"><p>Changes can be saved to this installation or added to a correction package for review and sharing.</p>${catalogScoreFieldsHTML(x.scores)}${catalogContentFieldsHTML(x.content)}<div class="catalog-editor-actions"><button id="saveCatalogDraft" class="slash-button wide" type="button">SAVE TO REVIEW PACKAGE</button>${state.catalogWriteEnabled ? '<button id="applyCatalogDirect" class="slash-button hot wide" type="button">SAVE TO THIS INSTALLATION</button>' : ''}</div><div id="catalogEditorResult" class="import-result"></div></div></details>`;
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
    return setAdultCatalogTitle(content, $(`#${prefix}-adult`).checked);
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
        content: readCatalogContent('catalogContent'),
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
    sessionStorage.setItem(
      'uai:catalog-import-message',
      `${result.applied} catalog change${result.applied === 1 ? '' : 's'} saved`,
    );
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
    x.content = setAdultCatalogTitle(
      {
        sex: level('sex'),
        nudity: level('nudity'),
        violence: level('violence'),
        gore: level('gore'),
        disturbing: level('disturbing'),
        tags: parseCustomTags($('#customContentTags').value),
      },
      $('#customAdult').checked,
    );
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
    if (!x) return;
    const m = meta[id]?.data || {},
      p = pFor(id),
      verdict = ownVerdict(id),
      ops = sourceOpinions(id),
      bg = m.banner || m.cover || m.image || '';
    const sc = x.scores || {};
    const quality = qualityRatingLabel(x.tier, state.ratingFormat, {
      suffix: state.ratingFormat === 'ten',
    });
    const facts = [
      { value: x.rank ? `#${x.rank}` : 'CUSTOM' },
      { value: quality },
      { value: displayType(x) },
      { value: liveYear(x) },
      { value: x.origin },
      { value: m.studio },
      { value: sc.overall ? `Overall ${sc.overall}` : '' },
    ].filter((fact) => fact.value);
    $('#dialogBody').innerHTML =
      `<div class="detail-hero">${bg ? `<img class="detail-bg" src="${esc(bg)}" alt="">` : ''}<div class="detail-heading"><div class="kicker">${x.rank ? `MASTER RANK #${String(x.rank).padStart(3, '0')}` : 'CUSTOM ADDITION'} // ${esc(quality)}</div><h2>${esc(x.title)}</h2></div></div><div class="detail-content"><div class="detail-facts">${facts.map((fact) => `<span class="fact">${esc(fact.value)}</span>`).join('')}</div><div class="detail-grid"><div>${m.description ? `<h4>Synopsis</h4><p>${esc(m.description)}</p>` : '<p class="metadata-wait">Synopsis will appear when metadata is available.</p>'}${x.watch_note ? `<div class="callout"><h4>Watch note</h4><p>${esc(x.watch_note)}</p></div>` : ''}${x.caveat ? `<div class="callout"><h4>Worth knowing</h4><p>${esc(x.caveat)}</p></div>` : ''}${m.siteUrl ? `<a class="external-link" href="${esc(m.siteUrl)}" target="_blank" rel="noopener">OPEN SOURCE ↗</a>` : ''}<h4>Content</h4>${contentGuide(x, false)}${x.custom ? `${customEditorHTML(x)}${customPromotionHTML(x)}` : catalogCorrectionEditorHTML(x)}${canTrackEpisodes(x) ? `<div id="episodeTrackerMount" class="episode-tracker-mount" data-episode-owner="${esc(x.id)}" data-episode-variant="detail"></div>` : ''}${ops.length ? `<h4>Imported opinions</h4><div class="source-opinion-list">${ops.map((o) => `<div class="source-opinion"><b>${esc(o.label)}</b><span class="${o.verdict === 'recommend' ? 'yes' : 'no'}">${o.verdict === 'recommend' ? 'RECOMMENDED' : 'NOT RECOMMENDED'}</span></div>`).join('')}</div>` : ''}</div><aside aria-label="Personal title settings"><div class="user-edit"><button id="modalFavorite" class="favorite-detail ${isFavorite(id) ? 'active' : ''}" type="button">${isFavorite(id) ? '♥ FAVORITE' : '♡ ADD TO FAVORITES'}</button><div class="user-edit-label" id="recommendationLabel">MY RECOMMENDATION</div><div class="verdict-row" role="group" aria-labelledby="recommendationLabel"><button class="verdict-btn rec ${verdict === 'recommend' ? 'active' : ''}" data-v="recommend" type="button">RECOMMEND</button><button class="verdict-btn no ${verdict === 'avoid' ? 'active' : ''}" data-v="avoid" type="button">DON'T RECOMMEND</button><button class="verdict-btn neutral ${!verdict ? 'active' : ''}" data-v="" type="button">NEUTRAL</button></div><label for="modalStatus">WATCH STATUS</label><select id="modalStatus">${['Not started', 'Watching', 'Completed', 'On hold', 'Dropped'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><div class="rating-format-head"><span>MY RATING</span></div><div id="modalRatingEditor">${ratingEditorHTML(p.rating)}</div><small class="rating-scale-help" id="ratingScaleHelp">${esc(ratingScaleHelp())}</small><label for="modalNote">PRIVATE NOTE</label><textarea id="modalNote" maxlength="2000">${esc(p.note || '')}</textarea><button class="slash-button hot wide" id="saveDetail" type="button">${x.custom ? 'SAVE TITLE + LOCAL DATA' : 'SAVE LOCAL DATA'}</button>${x.custom ? '<button class="danger-button wide" id="removeCustomTitle" type="button">REMOVE CUSTOM TITLE</button>' : ''}</div></aside></div></div>`;
    $('#dialogBody').dataset.itemId = id;
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
      applyManualTitleStatusToEpisodes(cachedSeriesGroup(x), progress[id].status);
      if (selectedVerdict) myOpinions[id] = selectedVerdict;
      else delete myOpinions[id];
      save(STORE.progress, progress);
      save(STORE.opinions, myOpinions);
      $('#detailDialog').close();
      renderAll();
      toast('Saved locally');
      if (metadataChanged) refreshCustomMetadata(x, { force: true, silent: true });
    };
    $('#detailDialog').showModal();
    const episodeMount = $('#episodeTrackerMount');
    if (episodeMount) {
      episodeMount.closest('.detail-grid')?.after(episodeMount);
      populateEpisodeMount(episodeMount, x, 'detail');
    }
    if (x.custom) refreshCustomMetadata(x, { silent: true });
    else queueMetadata([x], { priority: true });
  }

  function metaFresh(id) {
    const cur = meta[id];
    return !!(cur && Date.now() - cur.ts < META_TTL && cur.data);
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
              items: chunk.map((x) => ({ key: x.id, kind: x.api, title: x.lookupTitle || x.title })),
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
  function switchTab(name) {
    state.tab = name;
    $$('.rail-tab').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `${name}Tab`));
    if (name === 'adult') renderAdult();
    if (name === 'collections') renderCollections();
    if (name === 'franchises') renderFranchises();
    if (name === 'favorites') renderFavorites();
    if (name === 'userlist') renderUserSummary();
    history.replaceState(null, '', `#${name}`);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function renderAll() {
    renderMaster({ noMeta: true });
    renderCollections();
    renderFranchises();
    if (state.tab === 'adult') renderAdult();
    if (state.tab === 'favorites') renderFavorites();
    renderUserSummary();
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
    saveUIState();
    populateFilters();
    $('#ratingFormatSelect').value = state.ratingFormat;
    renderMaster();
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

  // UI events
  $$('.rail-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  ['searchInput'].forEach((id) =>
    $('#' + id).addEventListener('input', () => {
      state.visible = PAGE_SIZE;
      saveUIState();
      renderMaster();
    }),
  );
  [
    'tierFilter',
    'typeFilter',
    'genreFilter',
    'statusFilter',
    'sortSelect',
    'hideCompleted',
    'customOnly',
  ].forEach((id) =>
    $('#' + id).addEventListener('change', () => {
      state.visible = PAGE_SIZE;
      saveUIState();
      renderMaster();
    }),
  );
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
    renderMaster();
  });
  $('#adultSearch').addEventListener('input', () => {
    saveUIState();
    renderAdult();
  });
  ['adultTierFilter', 'adultTypeFilter', 'adultGenreFilter', 'adultStatusFilter'].forEach((id) =>
    $('#' + id).addEventListener('change', () => {
      saveUIState();
      renderAdult();
    }),
  );
  $('#adultSort').addEventListener('change', () => {
    saveUIState();
    renderAdult();
  });
  $('#adultSortOrder').addEventListener('click', () => {
    state.adultSortOrder = state.adultSortOrder === 'desc' ? 'asc' : 'desc';
    renderSortOrderButton($('#adultSortOrder'), state.adultSortOrder);
    saveUIState();
    renderAdult();
  });
  $('#loadMoreBtn').addEventListener('click', () => {
    state.visible += PAGE_SIZE;
    renderMaster();
  });
  $('#viewToggle').addEventListener('click', () => {
    state.compact = !state.compact;
    save(STORE.compact, state.compact);
    $('#viewToggle').textContent = state.compact ? '▤' : '▥';
    renderMaster();
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
      renderAdult();
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
  $('#detailDialog').addEventListener('close', () => cancelEpisodeActionConfirmation());
  $('#collectionDialog').addEventListener('close', () => cancelEpisodeActionConfirmation());
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

  // boot
  populateFilters();
  restoreUIState();
  $('#viewToggle').textContent = state.compact ? '▤' : '▥';
  renderMaster({ noMeta: NO_META });
  renderCollections();
  renderFranchises();
  renderFavorites();
  renderUserSummary();
  renderCorrectionWorkspace();
  updateHero();
  await checkServer();
  checkForUpdates();
  const backupImportMessage = sessionStorage.getItem('uai:backup-import-message');
  if (backupImportMessage) {
    sessionStorage.removeItem('uai:backup-import-message');
    setTimeout(() => toast(backupImportMessage), 120);
  }
  const catalogImportMessage = sessionStorage.getItem('uai:catalog-import-message');
  if (catalogImportMessage) {
    sessionStorage.removeItem('uai:catalog-import-message');
    setTimeout(() => toast(catalogImportMessage), 120);
  }
  const hash = location.hash.replace('#', '');
  if (['master', 'collections', 'franchises', 'adult', 'favorites', 'userlist'].includes(hash))
    switchTab(hash);
  setTimeout(showRatingFormatOnboarding, 350);
})().catch((error) => {
  console.error('Catalog startup failed:', error);
  const main = document.querySelector('.main-shell');
  if (main) {
    main.innerHTML =
      '<section class="panel active"><div class="empty-state">The catalog could not be loaded. Start the included server and reload the page.</div></section>';
  }
});
