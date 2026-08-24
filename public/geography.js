// Origin data is intentionally preserved in the catalog. This module only
// provides a stable browsing taxonomy for the many country spellings used by
// researched sources and historical co-productions.
export const REGIONS = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Central America & Caribbean',
  'Oceania',
  'Regional / International',
  'Unclassified',
];

// Kept explicitly rather than guessed from a browser locale. It makes the
// exact same filters available offline and lets the source origin remain text.
const REGION_BY_COUNTRY = new Map([
  ..."Algeria|Angola|Burkina Faso|Cameroon|Côte d'Ivoire|Egypt|Eswatini|Ethiopia|Ghana|Kenya|Mali|Morocco|Niger|Nigeria|Senegal|South Africa|Tanzania|Tunisia|Uganda|Zambia|Zimbabwe|Democratic Republic of the Congo"
    .split('|')
    .map((country) => [country, 'Africa']),
  ...'Armenia|Bangladesh|China|Georgia|Hong Kong|India|Indonesia|Iran|Iraq|Israel|Japan|Jordan|Kuwait|Lebanon|Malaysia|North Korea|Pakistan|Palestine|Philippines|Qatar|Saudi Arabia|Singapore|South Korea|Syria|Taiwan|Thailand|Turkey|Türkiye|United Arab Emirates|Uzbekistan|Vietnam'
    .split('|')
    .map((country) => [country, 'Asia']),
  ...'Austria|Belarus|Belgium|Bosnia and Herzegovina|Bulgaria|Croatia|Cyprus|Czech Republic|Czechoslovakia|Denmark|East Germany|Estonia|Finland|France|Germany|Greece|Hungary|Iceland|Ireland|Italy|Latvia|Lithuania|Luxembourg|Netherlands|North Macedonia|Norway|Poland|Portugal|Romania|Russia|Scotland|Serbia|Slovakia|Slovenia|Spain|Sweden|Switzerland|Ukraine|UK|United Kingdom|USSR|Wales|West Germany|Yugoslavia'
    .split('|')
    .map((country) => [country, 'Europe']),
  ...'Canada|United States|US'.split('|').map((country) => [country, 'North America']),
  ...'Argentina|Bolivia|Brazil|Chile|Colombia|Ecuador|Guyana|Paraguay|Peru|Suriname|Uruguay|Venezuela'
    .split('|')
    .map((country) => [country, 'South America']),
  ...'Aruba|Bahamas|Barbados|Costa Rica|Cuba|Curaçao|Dominican Republic|El Salvador|Guadeloupe|Guatemala|Haiti|Honduras|Jamaica|Martinique|Mexico|Nicaragua|Panama|Puerto Rico|Saint Vincent and the Grenadines|Trinidad and Tobago'
    .split('|')
    .map((country) => [country, 'Central America & Caribbean']),
  ...'Australia|New Zealand'.split('|').map((country) => [country, 'Oceania']),
  ...'International|Latin America|Middle East|Pan-Africa'
    .split('|')
    .map((country) => [country, 'Regional / International']),
]);

const CANONICAL_COUNTRY = new Map([
  ['US', 'United States'],
  ['UK', 'United Kingdom'],
  ['Türkiye', 'Turkey'],
  ['Ivory Coast', "Côte d'Ivoire"],
]);

export function originParts(origin = '') {
  return String(origin)
    .split(/\s*\/\s*/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((source) => {
      const country = CANONICAL_COUNTRY.get(source) || source;
      return {
        source,
        country,
        region: REGION_BY_COUNTRY.get(source) || REGION_BY_COUNTRY.get(country) || 'Unclassified',
      };
    });
}

export function titleMatchesRegion(item, region) {
  return !region || originParts(item?.origin).some((part) => part.region === region);
}

export function titleMatchesCountry(item, country) {
  return !country || originParts(item?.origin).some((part) => part.country === country);
}

export function countriesFor(items, region = '') {
  return [
    ...new Set(
      items.flatMap((item) =>
        originParts(item.origin)
          .filter((part) => !region || part.region === region)
          .map((part) => part.country),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
