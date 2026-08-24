import assert from 'node:assert/strict';
import { applyReleaseUpdatePackage, previewReleaseUpdatePackage } from '../scripts/release-updates.js';
import { validateCatalog } from '../scripts/build-catalog.js';

const source = () => ({
  version: 1,
  generated: '2026-08-20',
  scope: 'test',
  collections: [],
  franchises: [],
  sources: [],
  items: [
    {
      id: 'm:known:111',
      rank: 1,
      title: 'Known Series',
      type: 'Series',
      origin: 'Japan',
      year: 2026,
      genres: 'Action',
      api: 'anilist',
      lookupTitle: 'Known Series',
      sourceUrl: 'https://example.com/known',
      provisional: true,
      release: { status: 'upcoming', date: '', datePrecision: 'tba', region: '', platform: '', notes: '' },
    },
  ],
});
const base = (overrides = {}) => ({
  format: 'UAI_RELEASE_UPDATES',
  version: 1,
  packageId: '2026-08-28T08:00:00Z-test',
  generatedAt: '2026-08-28T08:00:00Z',
  scope: 'curated-animation-release-monitor',
  window: { from: '2026-08-27T08:00:00Z', to: '2026-08-28T08:00:00Z' },
  entries: [entry(overrides)],
});
const entry = (overrides = {}) => ({
  updateId: 'update-1',
  action: 'update',
  id: 'm:known:111',
  match: { title: 'Known Series', year: 2026, lookupTitle: 'Known Series', aliases: [] },
  reasons: ['release-date-changed'],
  release: {
    status: 'upcoming',
    date: '2026-10-02',
    datePrecision: 'day',
    region: 'global',
    platform: '',
    notes: '',
  },
  patch: {
    release: {
      status: 'upcoming',
      date: '2026-10-02',
      datePrecision: 'day',
      region: 'global',
      platform: '',
      notes: '',
    },
  },
  audience: { mature: null, forKids: null },
  sources: [{ label: 'Official', url: 'https://example.com/source', accessedAt: '2026-08-28T07:55:00Z' }],
  ...overrides,
});
const addPatch = (title = 'New Feature') => ({
  title,
  type: 'Film',
  origin: 'Japan',
  year: 2026,
  genres: 'Family',
  api: 'anilist',
  lookupTitle: title,
  sourceUrl: 'https://example.com/new',
});

// A–F: additions, date updates, TBA/date and released state.
let preview = previewReleaseUpdatePackage(source(), base());
assert.equal(preview.entries[0].state, 'valid');
assert.equal(
  preview.entries[0].changes.some((change) => change.field === 'release'),
  true,
);
let added = base({ entries: undefined });
added.entries = [
  entry({
    updateId: 'new-upcoming',
    action: 'add',
    id: null,
    match: { title: 'New Feature', year: 2026, lookupTitle: 'New Feature', aliases: [] },
    reasons: ['new-title'],
    patch: addPatch(),
    audience: { mature: false, forKids: true },
  }),
];
preview = previewReleaseUpdatePackage(source(), added);
assert.equal(preview.entries[0].state, 'valid');
let result = applyReleaseUpdatePackage(source(), added, ['new-upcoming']);
assert.equal(result.catalog.items.length, 2);
assert.equal(result.catalog.items[1].rank, null);
assert.equal(result.catalog.items[1].content.tags.includes('For Kids'), true);
validateCatalog(result.catalog);

const released = base({
  entries: undefined,
});
released.entries = [
  entry({
    updateId: 'new-released',
    action: 'add',
    id: null,
    match: { title: 'Released Feature', year: 2026, lookupTitle: 'Released Feature', aliases: [] },
    reasons: ['new-title', 'quality-rating-added', 'content-rating-added'],
    release: {
      status: 'released',
      date: '2026-08-28',
      datePrecision: 'day',
      region: 'global',
      platform: '',
      notes: '',
    },
    patch: {
      ...addPatch('Released Feature'),
      tier: 'A',
      scores: { overall: 85, entertainment: 8, production: 9, story: 8, emotional: 7 },
      content: { sex: 0, nudity: 0, violence: 2, gore: 0, disturbing: 1, tags: [] },
    },
  }),
];
assert.equal(previewReleaseUpdatePackage(source(), released).entries[0].state, 'valid');

// G–J: released editorial data and independent audience flags.
const quality = base({ entries: undefined });
quality.entries = [
  entry({
    updateId: 'released-quality',
    reasons: ['became-released', 'quality-rating-added', 'content-rating-added'],
    release: {
      status: 'released',
      date: '2026-08-28',
      datePrecision: 'day',
      region: 'global',
      platform: '',
      notes: '',
    },
    patch: {
      tier: 'A+',
      scores: { overall: 92, entertainment: 9, production: 10, story: 9, emotional: 8 },
      content: { sex: 1, nudity: 1, violence: 3, gore: 1, disturbing: 2, tags: [] },
    },
    audience: { mature: true, forKids: false },
  }),
];
result = applyReleaseUpdatePackage(source(), quality, ['released-quality']);
assert.equal(result.catalog.items[0].tier, 'A+');
assert.equal(result.catalog.items[0].content.tags.includes('Adult Only'), true);
assert.equal(result.catalog.items[0].content.tags.includes('For Kids'), false);

// K–M: ambiguity conflicts, exact IDs work and a repeated import is a no-op.
const ambiguous = source();
ambiguous.items.push({ ...ambiguous.items[0], id: 'm:known:222', rank: 2 });
const loose = base({ entries: undefined });
loose.entries = [entry({ id: null })];
assert.equal(previewReleaseUpdatePackage(ambiguous, loose).entries[0].state, 'conflict');
const first = applyReleaseUpdatePackage(source(), base(), ['update-1']);
assert.equal(previewReleaseUpdatePackage(first.catalog, base()).entries[0].state, 'noop');

// N–R: hostile URLs, tiers, unreleased editorials, rank mutation and invalid selection are rejected.
assert.throws(
  () => previewReleaseUpdatePackage(source(), base({ entries: undefined })),
  /invalid-release-update-package/,
);
const badUrl = base({ entries: undefined });
badUrl.entries = [
  entry({ sources: [{ label: 'Bad', url: 'javascript:alert(1)', accessedAt: '2026-08-28T07:55:00Z' }] }),
];
assert.throws(() => previewReleaseUpdatePackage(source(), badUrl), /invalid-release-update-package/);
const badTier = base({ entries: undefined });
badTier.entries = [entry({ patch: { tier: 'S+' } })];
assert.throws(() => previewReleaseUpdatePackage(source(), badTier), /invalid-release-update-package/);
const unreleased = base({ entries: undefined });
unreleased.entries = [
  entry({ patch: { scores: { overall: 90, entertainment: 9, production: 9, story: 9, emotional: 9 } } }),
];
assert.throws(() => previewReleaseUpdatePackage(source(), unreleased), /unreleased-editorial-update/);
const rankPatch = base({ entries: undefined });
rankPatch.entries = [entry({ patch: { rank: 99 } })];
assert.throws(() => previewReleaseUpdatePackage(source(), rankPatch), /invalid-release-update-package/);
assert.throws(
  () => applyReleaseUpdatePackage(source(), base(), ['not-in-package']),
  /invalid-release-update-selection/,
);

console.log('Release update package tests passed.');
