const SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

export function normalizeSeriesTitle(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function parseProviderPartitionTitle(value = '') {
  const original = String(value || '')
    .normalize('NFKC')
    .trim();
  const empty = { original, base: '', normalizedBase: '', hasPartition: false };
  if (!original) return empty;

  let match = original.match(
    /^(.*?)(?:\s*[-–—:]?\s*)final\s+season(?:\s*[-–—:]?\s*(part|cour)\s*(\d+))?\s*$/i,
  );
  if (match) {
    const unit = String(match[2] || '').toLowerCase();
    const number = positiveInteger(match[3]);
    return {
      original,
      base: match[1].trim(),
      normalizedBase: normalizeSeriesTitle(match[1]),
      finalSeason: true,
      season: null,
      part: unit === 'part' ? number : null,
      cour: unit === 'cour' ? number : null,
      hasPartition: true,
      plainPartOnly: false,
    };
  }

  match = original.match(
    /^(.*?)(?:\s*[-–—:]?\s*)(?:season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s+season)(?:\s*[-–—:]?\s*(part|cour)\s*(\d+))?\s*$/i,
  );
  if (match) {
    const unit = String(match[4] || '').toLowerCase();
    const number = positiveInteger(match[5]);
    return {
      original,
      base: match[1].trim(),
      normalizedBase: normalizeSeriesTitle(match[1]),
      finalSeason: false,
      season: positiveInteger(match[2] || match[3]),
      part: unit === 'part' ? number : null,
      cour: unit === 'cour' ? number : null,
      hasPartition: true,
      plainPartOnly: false,
    };
  }

  match = original.match(/^(.*?)(?:\s*[-–—:]?\s*)(part|cour)\s*(\d+)\s*$/i);
  if (match) {
    const unit = String(match[2]).toLowerCase();
    const number = positiveInteger(match[3]);
    return {
      original,
      base: match[1].trim(),
      normalizedBase: normalizeSeriesTitle(match[1]),
      finalSeason: false,
      season: null,
      part: unit === 'part' ? number : null,
      cour: unit === 'cour' ? number : null,
      hasPartition: true,
      plainPartOnly: unit === 'part',
    };
  }

  return {
    original,
    base: original,
    normalizedBase: normalizeSeriesTitle(original),
    finalSeason: false,
    season: null,
    part: null,
    cour: null,
    hasPartition: false,
    plainPartOnly: false,
  };
}

export function looksLikeProviderPartitionTitle(value) {
  return parseProviderPartitionTitle(value).hasPartition;
}

function seasonCode(number) {
  return `S${String(number).padStart(2, '0')}`;
}

export function providerSeriesLabels(entries = []) {
  let fallbackSeason = 0;
  return entries.map((entry) => {
    const format = String(entry?.format || '').toUpperCase();
    const providerSeason = Number(entry?.seasonNumber);
    if (entry?.provider === 'tvmaze' && Number.isInteger(providerSeason) && providerSeason >= 0) {
      if (!providerSeason || format === 'SPECIAL') return 'SP';
      fallbackSeason = Math.max(fallbackSeason, providerSeason);
      return seasonCode(providerSeason);
    }
    if (format === 'MOVIE') return 'FILM';
    if (format === 'SPECIAL') return 'SP';
    if (format === 'OVA') return 'OVA';
    if (!SEASON_FORMATS.has(format)) return format || 'PART';

    const parsed = parseProviderPartitionTitle(entry?.title || entry?.altTitle || '');
    if (parsed.finalSeason)
      return `FINAL${parsed.part ? ` P${parsed.part}` : parsed.cour ? ` C${parsed.cour}` : ''}`;
    if (parsed.season) {
      fallbackSeason = Math.max(fallbackSeason, parsed.season);
      return `${seasonCode(parsed.season)}${parsed.part ? `P${parsed.part}` : parsed.cour ? `C${parsed.cour}` : ''}`;
    }
    if (parsed.part) return `P${parsed.part}`;
    if (parsed.cour) return `C${parsed.cour}`;
    fallbackSeason += 1;
    return seasonCode(fallbackSeason);
  });
}

function relationshipScore(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.startsWith(`${right} `)) return 92;
  if (right.startsWith(`${left} `)) return 88;
  const a = new Set(left.split(' ').filter(Boolean));
  const b = new Set(right.split(' ').filter(Boolean));
  const shared = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union && shared / union >= 0.6 ? 60 + Math.round((shared / union) * 20) : 0;
}

export function providerPartitionCandidateScore(title, candidateTitles = []) {
  const parsed = parseProviderPartitionTitle(title);
  if (!parsed.hasPartition) return 0;
  return Math.max(
    0,
    ...candidateTitles.map((candidate) =>
      relationshipScore(parsed.normalizedBase, normalizeSeriesTitle(candidate)),
    ),
  );
}

export function plainPartCanResolveToCandidate(title, candidateTitles = []) {
  const parsed = parseProviderPartitionTitle(title);
  return (
    !parsed.plainPartOnly ||
    candidateTitles.some((candidate) => {
      const normalized = normalizeSeriesTitle(candidate);
      return (
        normalized &&
        parsed.normalizedBase !== normalized &&
        parsed.normalizedBase.startsWith(`${normalized} `)
      );
    })
  );
}

function compatiblePartition(source, target) {
  if (!source.hasPartition || !target.hasPartition) return false;
  if (source.finalSeason !== target.finalSeason && (source.finalSeason || target.finalSeason)) return false;
  if (source.season && source.season !== target.season) return false;
  if (source.part && (!target.part || source.part !== target.part)) return false;
  if (source.cour && (!target.cour || source.cour !== target.cour)) return false;
  return relationshipScore(source.normalizedBase, target.normalizedBase) > 0;
}

export function findProviderPartitionEntry(group, title) {
  const parsed = parseProviderPartitionTitle(title);
  if (!parsed.hasPartition) return null;
  const exact = normalizeSeriesTitle(title);
  return (
    (group?.entries || []).find((entry) => {
      if (!SEASON_FORMATS.has(String(entry?.format || '').toUpperCase())) return false;
      const names = [entry?.title, entry?.altTitle].filter(Boolean);
      return (
        names.some((name) => normalizeSeriesTitle(name) === exact) ||
        names.some((name) => compatiblePartition(parsed, parseProviderPartitionTitle(name)))
      );
    }) || null
  );
}
