# Checkpoint v161 import record

Imported from `ultimate-animation-index-checkpoint-v161-2026-08-24.zip` on the
catalogue migration path. The archive is retained outside the repository; no
covers, metadata cache or private user data are imported.

## Verified input

- Checkpoint: v161, dated 2026-08-24.
- 575 archive checksums verified before import.
- Release output: 10,765 ranked titles, 49 collections, 287 franchise guides
  and 2,592 normalized research-source entries.
- The public catalogue uses the ten-step editorial scale only:
  `F`, `E`, `D`, `C`, `C+`, `B`, `B+`, `A`, `A+`, `S`.

## Controlled source repairs

The checkpoint is an editorial work-in-progress, so the importer applies only
explicit, reproducible corrections. Every repair is recorded in
`catalog.importMetadata.repairs` in the generated source file.

1. `Treasure X` had no origin. It is recorded as Australia and points to the
   production page at <https://reli.sh/animation/project/treasure-x-series/>.
   The client is Moose Toys, whose head office is in Melbourne, Australia:
   <https://www.moosetoys.com/our-story>.
2. Five v139 additions had their synopsis in `id` and a numeric value in
   `watch_note`. The importer assigns a deterministic `m:<slug>:<hash>` ID,
   keeps the synopsis in `sourceSynopsis`, clears the invalid watch-note field
   and retains the numeric input as `sourceNumericWatchNote` for audit rather
   than inventing a meaning for it.

Affected titles:

- LEGO Star Wars: The Padawan Menace
- LEGO Star Wars: The Empire Strikes Out
- Zen - Grogu and Dust Bunnies
- LEGO Star Wars: Rebuild the Galaxy - Pieces of the Past
- Boonie Bears: Guardian Code

## Existing-user continuity

The import contains ten deterministic legacy-ID migrations for titles that
were renamed or consolidated by v161. At application startup, progress,
ratings, favorites, notes, cached metadata, cover overrides and catalog drafts
move to the current catalog ID when no current value exists. Ambiguous legacy
groupings, such as the former combined `Naruto + Naruto Shippuden` item, are
intentionally left untouched instead of being assigned to an arbitrary title.

## Repeatable commands

```powershell
npm run check:checkpoint -- "C:\path\to\ultimate-animation-index-checkpoint-v161-2026-08-24.zip"
node scripts/import-checkpoint.js "C:\path\to\ultimate-animation-index-checkpoint-v161-2026-08-24.zip"
npm run build:catalog
```

`check:checkpoint` validates archive checksums, normalizes the documented
input quirks in memory and runs the strict release validator. The import
command repeats that process before writing `data/catalog-source.json`.

## Editorial follow-up queue

`npm run audit:catalog` is the repeatable completeness report for the imported
catalog. It deliberately reports optional editorial omissions without guessing
at a subjective value or weakening the release validator. The v161 import has
19 legacy records without both `pace` and `commitment`, and 922 records
without a title-level `sourceUrl`. Provider metadata and the normalized
research-source set remain available, but these specific fields need a future
reviewed editorial pass rather than fabricated data. Aliases are intentionally
optional: an empty alias list is not a completeness issue.

## Provider identity

When a catalog item includes a numeric `externalId` alongside `api: "anilist"`
or `api: "tvmaze"`, metadata and episode loading use that provider ID before a
title search. A user-selected series match remains higher priority and can
always replace it. This prevents a curated identity from being overwritten by
an unrelated same-name result.
