import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metadataMatchesTitle, matchingAnimatedShow } from '../public/metadata-identity.js';

const item = {
  id: 'm:avatar-last-airbender:7b400516',
  title: 'Avatar: The Last Airbender',
  year: 2005,
  api: 'tvmaze',
};
const show = { id: 555, name: item.title, premiered: '2005-02-21', type: 'Animation' };
test('accepts the original animated series', () => assert.equal(matchingAnimatedShow(item, show), true));
test('rejects the same-name live-action remake', () =>
  assert.equal(matchingAnimatedShow(item, { ...show, premiered: '2024-02-22', type: 'Scripted' }), false));
test('requires both the year and animation type independently', () => {
  assert.equal(matchingAnimatedShow(item, { ...show, premiered: '2024-02-22' }), false);
  assert.equal(matchingAnimatedShow(item, { ...show, type: 'Scripted' }), false);
});
test('rejects unrelated names and conflicting provider IDs', () => {
  assert.equal(matchingAnimatedShow(item, { ...show, name: 'Another series' }), false);
  assert.equal(matchingAnimatedShow({ ...item, externalId: '999' }, show), false);
});
test('permits catalog aliases and refuses missing search results', () => {
  assert.equal(matchingAnimatedShow({ ...item, aliases: ['Avatar'] }, { ...show, name: 'Avatar' }), true);
  assert.equal(matchingAnimatedShow(item, null), false);
});
test('rejects stale unverified TVMaze browser metadata', () => {
  assert.equal(
    metadataMatchesTitle(item, { source: 'tvmaze', year: 2005, canonicalTitle: item.title }),
    false,
  );
  assert.equal(
    metadataMatchesTitle(item, {
      source: 'tvmaze',
      year: 2024,
      mediaType: 'Scripted',
      canonicalTitle: item.title,
    }),
    false,
  );
});
test('rejects conflicting or unknown years from other providers too', () => {
  assert.equal(metadataMatchesTitle(item, { source: 'anilist', year: 2024 }), false);
  assert.equal(metadataMatchesTitle(item, { source: 'wikipedia' }), false);
});
