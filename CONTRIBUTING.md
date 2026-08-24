# Contributing

Thanks for helping improve the Ultimate Animation Index.

## Before making a change

1. Install Node.js 20.19+, 22.16+, or 24+.
2. Run `npm ci` once to install the exact development tools from the lockfile.
3. Keep the change focused. Avoid committing local covers, metadata caches or
   UserList signing keys.

## Catalog changes

The source of truth is the readable `data/catalog-source.json`. Do not edit the
generated `public/catalog.json` directly.

After changing catalog data or curation rules, run:

```bash
npm run build:catalog
```

Do not commit the generated catalog file; CI rebuilds it from the source. Keep existing
title IDs stable when renaming a canonical title because those IDs connect saved browser
data and imported UserLists. Add an alias when a rename is meant to preserve identity.

### Correction packages

The application can export rating edits and completed custom-title candidates as a `UAIC`
review package. Packages are data-only proposals; they do not grant repository or server
access. Validate the package in the UserList correction workspace and inspect every
before/after value before applying it to a local checkout.

Applying a package updates `data/catalog-source.json` and regenerates the ignored browser
copy. Review the resulting Git diff before committing. A local catalog change becomes part
of the public project only after it is accepted and pushed to `main` through the normal
GitHub permissions and review process.

## Application changes

Before opening a pull request, run:

```bash
npm run format
npm run verify
```

## Pull requests

Describe the user-visible outcome, note any data migrations or compatibility risks,
and include screenshots for visual changes. Never include `public/catalog.json` or
files from `.userlist-keys/`, `.cache/`, `data/covers/`, the legacy `covers/` folder or
`node_modules/`.
