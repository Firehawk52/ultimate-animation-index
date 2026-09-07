import assert from 'node:assert/strict';
import {
  awardProgramOptions,
  awardSummary,
  matchesAwardFilter,
  safeAwardSourceUrl,
} from '../public/award-format.js';
import { compareCatalogTiers, normalizeCatalogTier } from '../public/rating-format.js';
import { providerSeriesLabels } from '../public/series-labels.js';
import { validateCatalog } from '../scripts/build-catalog.js';
import { buildLegacyIdMigrations } from '../scripts/checkpoint-import.js';

assert.equal(normalizeCatalogTier('S+'), 'S');
assert.equal(normalizeCatalogTier('A-'), 'A');
assert.ok(compareCatalogTiers('S', 'A+') < 0);
assert.ok(compareCatalogTiers('F', 'C') > 0);

assert.deepEqual(
  providerSeriesLabels([
    { provider: 'tvmaze', format: 'TV', seasonNumber: 1 },
    { provider: 'tvmaze', format: 'TV', seasonNumber: 2 },
    { provider: 'tvmaze', format: 'SPECIAL', seasonNumber: 0 },
    { format: 'TV', title: 'Example Season 3 Part 2' },
    { format: 'MOVIE' },
  ]),
  ['S01', 'S02', 'SP', 'S03P2', 'FILM'],
);

const awardItem = {
  awards: [
    {
      programKey: 'academy:animated-short',
      award: 'Academy Awards',
      category: 'Animated Short Film',
      result: 'Winner',
    },
    { programKey: 'annecy:feature', award: 'Annecy', category: 'Feature', result: 'Nominee' },
  ],
};
assert.deepEqual(awardSummary(awardItem), { total: 2, wins: 1, nominees: 1, programs: 2 });
assert.equal(matchesAwardFilter(awardItem, 'winner'), true);
assert.equal(matchesAwardFilter(awardItem, 'program:annecy:feature'), true);
assert.equal(awardProgramOptions([awardItem]).length, 2);
assert.equal(
  safeAwardSourceUrl({ sourceUrl: { label: 'Official source', url: 'https://example.test/source' } }),
  'https://example.test/source',
);
assert.equal(
  safeAwardSourceUrl({ sourceUrl: '[Official source](https://example.test/source)' }),
  'https://example.test/source',
);

assert.doesNotThrow(() =>
  validateCatalog({
    version: 1,
    generated: '2026-08-24',
    scope: 'source-reference fixture',
    ratingScale: 'ten-tier',
    items: [
      {
        id: 'm:source-fixture:1',
        title: 'Source fixture',
        rank: 1,
        provisional: false,
        tier: 'C+',
        communitySignal: { recommend: 1, avoid: 0, lists: 1, completed: 1 },
        sourceUrl: { label: 'Official source', url: 'https://example.test/source' },
      },
    ],
    collections: [],
    franchises: [
      {
        id: 'source-fixture-franchise',
        name: 'Source fixture franchise',
        summary: 'Stable ID linkage fixture.',
        orders: [
          {
            label: 'Recommended order',
            steps: [
              {
                id: 'fixture-step-1',
                n: '01',
                title: 'Source fixture',
                kind: 'animation',
                flag: 'ESSENTIAL',
                itemId: 'm:source-fixture:1',
              },
            ],
          },
        ],
      },
    ],
    sources: [],
  }),
);

const migrations = buildLegacyIdMigrations(
  { items: [{ id: 'm:old:111', title: 'An Old Title' }] },
  { items: [{ id: 'm:new:222', title: 'Current Title', aliases: ['An Old Title'] }] },
);
assert.deepEqual(migrations, { 'm:old:111': 'm:new:222' });

console.log('Catalog format helpers passed.');
