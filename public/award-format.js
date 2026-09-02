export const AWARD_FILTER_VALUES = ['', 'any', 'winner', 'nominee'];

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceUrlValue(value) {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value) ? cleanText(value.url) : cleanText(value);
  return raw.match(/^\[[^\]]+\]\((https?:\/\/[^\s)]+)\)$/i)?.[1] || raw;
}

export function awardEntries(item) {
  return Array.isArray(item?.awards)
    ? item.awards.filter(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          cleanText(entry.programKey) &&
          ['Winner', 'Nominee'].includes(entry.result),
      )
    : [];
}

export function awardSummary(item) {
  const entries = awardEntries(item);
  const wins = entries.filter((entry) => entry.result === 'Winner').length;
  const nominees = entries.filter((entry) => entry.result === 'Nominee').length;
  return {
    total: entries.length,
    wins,
    nominees,
    programs: new Set(entries.map((entry) => entry.programKey)).size,
  };
}

export function awardBadgeLabel(item) {
  const summary = awardSummary(item);
  if (!summary.total) return '';
  const parts = [];
  if (summary.wins) parts.push(`${summary.wins} award ${summary.wins === 1 ? 'win' : 'wins'}`);
  if (summary.nominees)
    parts.push(`${summary.nominees} ${summary.nominees === 1 ? 'nomination' : 'nominations'}`);
  return `${parts.join(', ')} across ${summary.programs} award ${summary.programs === 1 ? 'program' : 'programs'}`;
}

export function awardSearchText(item) {
  return awardEntries(item)
    .flatMap((entry) => [
      entry.programKey,
      entry.organization,
      entry.award,
      entry.category,
      entry.result,
      entry.cycle,
      entry.eventYear,
      entry.sourceTitle,
      entry.sourceWorkDetail,
    ])
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .join(' ');
}

export function awardProgramOptions(items) {
  const programs = new Map();
  for (const item of items || []) {
    const seen = new Set();
    for (const entry of awardEntries(item)) {
      const key = cleanText(entry.programKey);
      const current = programs.get(key) || {
        value: `program:${key}`,
        programKey: key,
        award: cleanText(entry.award) || key,
        category: cleanText(entry.category),
        entries: 0,
        items: 0,
        winners: 0,
      };
      current.entries += 1;
      if (!seen.has(key)) {
        current.items += 1;
        seen.add(key);
      }
      if (entry.result === 'Winner') current.winners += 1;
      programs.set(key, current);
    }
  }
  return [...programs.values()]
    .map((program) => ({
      ...program,
      label: program.category ? `${program.award} — ${program.category}` : program.award,
    }))
    .sort(
      (a, b) =>
        a.award.localeCompare(b.award) ||
        a.category.localeCompare(b.category) ||
        a.programKey.localeCompare(b.programKey),
    );
}

export function matchesAwardFilter(item, value = '') {
  const filter = String(value || '').trim();
  if (!filter) return true;
  const entries = awardEntries(item);
  if (filter === 'any') return entries.length > 0;
  if (filter === 'winner') return entries.some((entry) => entry.result === 'Winner');
  if (filter === 'nominee') return entries.some((entry) => entry.result === 'Nominee');
  return filter.startsWith('program:') ? entries.some((entry) => entry.programKey === filter.slice(8)) : true;
}

export function sortedAwardEntries(item) {
  return [...awardEntries(item)].sort(
    (a, b) =>
      (a.result === 'Winner' ? 0 : 1) - (b.result === 'Winner' ? 0 : 1) ||
      (Number(b.eventYear) || 0) - (Number(a.eventYear) || 0) ||
      cleanText(a.award).localeCompare(cleanText(b.award)) ||
      cleanText(a.category).localeCompare(cleanText(b.category)) ||
      cleanText(a.sourceWorkDetail).localeCompare(cleanText(b.sourceWorkDetail)),
  );
}

export function safeAwardSourceUrl(entry) {
  try {
    const url = new URL(sourceUrlValue(entry?.sourceUrl));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}
