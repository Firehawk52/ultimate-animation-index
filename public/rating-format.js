export const RATING_FORMATS = ['tier', 'ten', 'stars'];

const QUALITY_VALUES = {
  B: 5,
  'B+': 6,
  A: 7,
  'A+': 8,
  S: 9,
  'S+': 10,
};

const QUALITY_TIERS = {
  B: 'D',
  'B+': 'C',
  A: 'B',
  'A+': 'A',
  S: 'A+',
  'S+': 'S',
};

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

export function qualityRatingLabel(tier, format = 'tier', { suffix = false } = {}) {
  const normalizedTier = String(tier || 'CUSTOM').toUpperCase();
  if (!(normalizedTier in QUALITY_VALUES)) return normalizedTier;
  const normalizedFormat = normalizeRatingFormat(format);
  if (normalizedFormat === 'tier') return QUALITY_TIERS[normalizedTier];
  const value = QUALITY_VALUES[normalizedTier];
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
