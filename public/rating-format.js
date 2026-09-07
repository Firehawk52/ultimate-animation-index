export const RATING_FORMATS = ['tier', 'ten', 'stars'];
export const CATALOG_TIERS = ['F', 'E', 'D', 'C', 'C+', 'B', 'B+', 'A', 'A+', 'S'];

const TEN_TIER_VALUES = {
  F: 1,
  E: 2,
  D: 3,
  C: 4,
  'C+': 5,
  B: 6,
  'B+': 7,
  A: 8,
  'A+': 9,
  S: 10,
};

// Older releases used six editorial bands. They remain readable until the
// future catalog declares the ten-tier release contract.
const LEGACY_TIER_VALUES = { B: 5, 'B+': 6, A: 7, 'A+': 8, S: 9, 'S+': 10 };
const LEGACY_CATALOG_TIERS = { 'B-': 'B', 'A-': 'A', 'S+': 'S' };
const CATALOG_TIER_DISPLAY_ORDER = [...CATALOG_TIERS].reverse();

const PERSONAL_TIERS = [
  { tier: 'S', minimum: 10, value: 10 },
  { tier: 'A+', minimum: 9, value: 9 },
  { tier: 'A', minimum: 8, value: 8 },
  { tier: 'B+', minimum: 7, value: 7 },
  { tier: 'B', minimum: 6, value: 6 },
  { tier: 'C+', minimum: 5, value: 5 },
  { tier: 'C', minimum: 4, value: 4 },
  { tier: 'D', minimum: 3, value: 3 },
  { tier: 'E', minimum: 2, value: 2 },
  { tier: 'F', minimum: Number.EPSILON, value: 1 },
];

export function normalizeRatingFormat(value) {
  return RATING_FORMATS.includes(value) ? value : 'tier';
}

// S+ existed in early catalog exports. The public display contract is ten
// steps and ends at S, so legacy S+ is shown and filtered as S.
export function normalizeCatalogTier(tier) {
  const value = String(tier || 'CUSTOM').toUpperCase();
  return LEGACY_CATALOG_TIERS[value] || value;
}

// Kept as an alias for existing UI code and external integrations.
export function normalizeCuratedTier(tier) {
  return normalizeCatalogTier(tier);
}

export function compareCatalogTiers(a, b) {
  const fallback = CATALOG_TIER_DISPLAY_ORDER.length;
  const left = CATALOG_TIER_DISPLAY_ORDER.indexOf(normalizeCatalogTier(a));
  const right = CATALOG_TIER_DISPLAY_ORDER.indexOf(normalizeCatalogTier(b));
  return (left < 0 ? fallback : left) - (right < 0 ? fallback : right);
}

export function qualityRatingLabel(tier, format = 'tier', { suffix = false } = {}) {
  const rawTier = String(tier || 'CUSTOM').toUpperCase();
  const normalizedTier = normalizeCuratedTier(rawTier);
  const value =
    TEN_TIER_VALUES[normalizedTier] ?? LEGACY_TIER_VALUES[rawTier] ?? LEGACY_TIER_VALUES[normalizedTier];
  if (!value) return normalizedTier;
  const normalizedFormat = normalizeRatingFormat(format);
  if (normalizedFormat === 'tier') return normalizedTier;
  if (normalizedFormat === 'stars') return starRatingLabel(value / 2);
  return suffix ? `${value}/10` : String(value);
}

export function starRatingLabel(value) {
  const halves = Math.max(0, Math.min(10, Math.round(Number(value || 0) * 2)));
  if (!halves) return '';
  return `${'★'.repeat(Math.floor(halves / 2))}${halves % 2 ? '½' : ''}`;
}

export function personalStarOptions() {
  return Array.from({ length: 10 }, (_, index) => {
    const value = index + 1;
    return { value, stars: value / 2, label: starRatingLabel(value / 2) };
  });
}

export function personalRatingTier(value) {
  const rating = Number(value) || 0;
  return PERSONAL_TIERS.find((entry) => rating >= entry.minimum)?.tier || '';
}

export function personalTierValue(tier) {
  return PERSONAL_TIERS.find((entry) => entry.tier === tier)?.value || 0;
}

export function personalTierOptions() {
  return [...PERSONAL_TIERS].reverse().map(({ tier, value }) => ({ tier, value }));
}
