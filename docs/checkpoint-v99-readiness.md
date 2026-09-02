# Checkpoint v99 readiness

## Purpose and status

This document records compatibility analysis for
`ultimate-animation-index-checkpoint-v99-2026-08-23.zip`. It is a **read-only
readiness assessment**. No checkpoint title, cover, award, franchise or other
editorial data is copied into this repository or published by this work.

The checkpoint is structurally suitable as a working editorial source, but it
is not a release candidate. The public catalog generator deliberately rejects
an official source with unranked, duplicate-ranked or duplicate-ID titles.

## Archive snapshot

| Measure                        | Checkpoint v99 |
| ------------------------------ | -------------: |
| Titles                         |         10,936 |
| Ranked titles                  |            933 |
| Unranked titles                |         10,003 |
| Collections                    |             49 |
| Franchises                     |            208 |
| Watch orders                   |            361 |
| Watch-order steps              |          1,652 |
| Award records                  |          2,652 |
| Titles with awards             |          1,471 |
| Award programs                 |             33 |
| Raw origin strings             |            738 |
| Individual country/area tokens |            139 |
| Co-productions                 |          1,780 |

The large unranked remainder is the current release blocker. A final public
catalog must have one unique positive rank for every official item.

## Supported catalog shape

The catalog validator accepts current data as well as the v99-ready extensions
below. Optional fields remain optional so older public catalogs continue to
build.

| Area            | Supported fields                                                                                                                       | Where users see it                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Identity        | `id`, `title`, `aliases`, `lookupTitle`, `year`, `type`, `origin`, `sourceUrl` (URL or `{ label, url }`), `api`, `provisional`         | Search, filters and title details                          |
| Curated profile | `pace`, `commitment`, `darkness`, `explicitness`, `fit_score`, `entertainment`, `production`, `story`, `scores`                        | Detail modal only                                          |
| Editorial notes | `caveat`, `watch_note`                                                                                                                 | Separate detail callouts                                   |
| Content guide   | `content.sex`, `nudity`, `violence`, `gore`, `disturbing`                                                                              | Existing five-card content guide                           |
| Recognition     | `awards[]` with program, organisation, award, category, result, edition, cycle, year and source                                        | Compact summary plus expandable source-linked detail list  |
| References      | URL-string sources and structured `{ label, url }` sources                                                                             | Validation and future source presentation                  |
| Franchises      | title-only steps today, plus optional stable step IDs, `itemId`, `kind`, `episodeRange`, `timeRange`, `resumeNote`, `note` and `after` | Franchise mode when supplied; stable IDs preserve progress |

Cards remain intentionally compact. New editorial data belongs in the detail
modal, avoiding a 10,000-card wall of dense metadata.

## Rating contract

The final collection must use exactly these ten editorial tiers:

`F`, `E`, `D`, `C`, `C+`, `B`, `B+`, `A`, `A+`, `S`.

Set the final catalog root to `"ratingScale": "ten-tier"`. The build then
rejects any title outside that contract. The application maintains legacy
display compatibility for the current catalog and can inspect temporary
checkpoint-only values, but does not rewrite raw source tiers during
compatibility checks. Any temporary WIP mapping is display-only and must be
resolved in the final editorial source before release.

## Awards

Awards are modelled as an open program system rather than a fixed logo list.
Known programs receive a generated technical mark; unknown future
`programKey` values still render with a safe derived mark and retain their
source link. This means additional organisations, categories and results do
not require a front-end deployment just to be visible.

The current checkpoint includes Academy, Goya, Annecy, BAFTA, Ottawa,
Animafest Zagreb and Hiroshima programs among its 33 program keys. Winner and
nominee counts are summarised before the complete linked list.

## Global origin browsing

Master remains the complete global catalog. Regions is a neutral drill-down,
not a replacement hierarchy or a Western-first section. It treats all listed
origins equally and provides region then country filtering in Master, Regions,
Mature Content, For Kids and Favorites.

The filtering layer preserves the source `origin` text. It only normalizes for
matching, including US/United States, UK/United Kingdom and Türkiye/Turkey.
Co-productions appear under every represented country and region. Umbrella
values such as International, Latin America, Middle East and Pan-Africa remain
findable in `Regional / International` rather than being discarded.

The initial region taxonomy includes Africa, Asia, Europe, North America,
South America, Central America & Caribbean, Oceania and Regional /
International. It is intentionally data-driven: future African countries,
historic names or new regional labels can be added to the mapping without a
new sidebar destination or a UI redesign.

The Regions interface deliberately uses a compact origin index rather than a
map. Region and country values remain local, data-driven filters, so browsing
does not contact a map provider or privilege one country over another.

## Scale and performance

The expected final catalog is approximately 10,000 titles. The interface is
prepared to retain its compact cards and paged rendering:

- Text search is normalized and indexed after catalog load, then debounced.
- Region and country facets operate on the loaded catalog without requesting
  external metadata for every item.
- Artwork and metadata are requested only for cards currently rendered or a
  title explicitly opened by the user.
- Independent filters, sorting and URL state are persisted for each browse
  area, including Regions, Mature Content and For Kids.

No API-wide metadata or cover-refresh operation is permitted as part of
catalog load.

## WIP limitations observed in v99

- 10,003 titles are currently unranked, so the checkpoint cannot produce a
  public release.
- The source is an editorial checkpoint, not a claim that metadata, cover
  availability or provider mappings are final.
- Current franchise data is primarily title-linked. The validator is prepared
  for later stable step IDs, live-action steps, episode splits, time ranges
  and resume instructions, but those additions must be supplied by the final
  source.
- Regional data is diverse and includes co-productions and umbrella labels;
  raw values must remain preserved even when matching aliases are added.

## Release checklist

1. Complete editorial ranking for every official item.
2. Assign a unique positive rank and unique stable ID to every title.
3. Ensure the root has `"ratingScale": "ten-tier"` and every item uses one
   of the ten approved tiers.
4. Validate origin, country aliases, awards, sources and franchise references.
5. Run the archive-only compatibility check:

   ```powershell
   npm run check:checkpoint -- "C:\path\to\ultimate-animation-index-checkpoint-v99-2026-08-23.zip"
   ```

6. Intentionally replace the editorial source only after the checklist passes,
   then run `npm run build:catalog`.
7. Test a 10,000-title fixture for search, facets, sorting, URL restoration,
   backup/import, paging, keyboard navigation and visible-only provider work.

The archive check is read-only. It validates the ZIP directly and never
extracts or imports the checkpoint into the public catalog.
