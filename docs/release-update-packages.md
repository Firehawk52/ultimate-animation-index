# Release Update Packages

Release Update Packages are small, curated JSON files for newly announced animation titles and meaningful changes to upcoming or recently released titles. They are not a generic catalog importer and they do not perform web discovery.

## Workflow

1. In **My Library → Release Updates**, select `ultimate-animation-index-release-updates-YYYY-MM-DD.json`.
2. Select **Preview**. No catalog file changes at this stage.
3. Review each field-level before/after change. Valid meaningful changes are selected by default; conflicts and no-ops are not.
4. Select **Apply Selected** on the machine running the UAI server. The selected set is revalidated and written atomically.
5. The local import-history list records the package ID, generated date and result. It can be cleared without affecting the catalog.

## Version 1 format

The top-level object has exact keys:

```json
{
  "format": "UAI_RELEASE_UPDATES",
  "version": 1,
  "packageId": "stable unique package id",
  "generatedAt": "2026-08-28T08:00:00Z",
  "scope": "curated-animation-release-monitor",
  "window": { "from": "2026-08-27T08:00:00Z", "to": "2026-08-28T08:00:00Z" },
  "entries": []
}
```

See [the complete example](examples/release-update-package-v1.json). Every entry has an `updateId`, `action` (`add` or `update`), stable identity `match`, `reasons`, factual `release` object, explicit `patch`, `audience`, and HTTPS source evidence. Delete actions are not supported.

## Patch and identity rules

Only fields present in `patch` change. Omitting a field never deletes it. Updates resolve in this order: exact catalog ID, exact canonical title plus year, then lookup title or aliases. Ambiguous identities are shown as conflicts and are never applied automatically. Provider Season/Part variants therefore cannot silently create a second master.

New additions require factual canonical fields: title, type, origin, year, genres, provider, lookup title and an official source URL. The importer generates a stable local ID. It never writes a global rank; unranked records remain provisional until the separate editorial ranking process handles them.

Supported release-update patch fields cover factual title/provider/origin metadata, aliases, release data, curated profile notes, quality scores, content scores and tags. `rank`, user data, franchise orders, collections, settings and arbitrary objects are rejected.

## Upcoming, quality and audience policy

Upcoming titles may receive factual metadata and sourced audience classification only. Quality scores, editorial tiers and custom content severity can be added only when `release.status` is `released`.

`audience.mature` and `audience.forKids` are independently `true`, `false`, or `null` (unknown). Mature maps to the existing `Adult Only` content label; For Kids maps to the canonical `For Kids` label. Neither flag is inferred by the importer and both can technically coexist when editorial policy permits it.

The only accepted editorial scale is `F`, `E`, `D`, `C`, `C+`, `B`, `B+`, `A`, `A+`, `S`.

## Security and idempotence

Packages are capped at 1 MB and 200 entries. The server verifies exact schema keys, ISO dates, text limits, IDs, score/content ranges, audience values, HTTPS source URLs and released-work rules. An apply request also requires the existing local, same-origin catalog write token.

The server resolves and diffs every selected entry again immediately before writing. It validates the complete resulting catalog, writes a temporary JSON file, atomically replaces the source catalog, then rebuilds `data/catalog.sqlite`. A failure leaves the original catalog intact. Re-importing a package whose changes are already present is rendered as no-ops and cannot create duplicate titles.

Release sources are retained as per-item `releaseSources` for local auditability and remain visible in package preview. They are not mixed into personal UserList opinions.
