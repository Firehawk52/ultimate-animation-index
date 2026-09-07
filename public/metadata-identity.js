// Provider data may enrich a catalog record only when its identity agrees.
export function metadataMatchesTitle(item, data) {
  if (!item || !data) return false;
  const year = Number(item.year);
  if (year && Number(data.year) !== year) return false;
  if (
    data.source === 'tvmaze' &&
    (data.mediaType !== 'Animation' || !matchingName(item, data.canonicalTitle))
  )
    return false;
  if (item.externalId && item.api === data.source && String(item.externalId) !== String(data.externalId))
    return false;
  return true;
}

function matchingName(item, name) {
  const names = [item.title, item.lookupTitle, ...(item.aliases || [])].filter(Boolean);
  const normalize = (value) =>
    String(value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  return names.some((candidate) => normalize(candidate) === normalize(name));
}

export function matchingAnimatedShow(item, show) {
  if (!show) return false;
  return metadataMatchesTitle(item, {
    canonicalTitle: show.name,
    source: 'tvmaze',
    externalId: show.id,
    mediaType: show.type,
    year: Number(String(show.premiered || '').slice(0, 4)),
  });
}
