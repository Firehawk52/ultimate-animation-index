# Contributing

Thanks for helping improve the Ultimate Animation Index.

## Before making a change

1. Install Node.js 20.19+, 22.16+, or 24+.
2. Run `npm ci` once to install the exact development tools from the lockfile.
3. Keep the change focused. Avoid committing local covers, metadata caches or
   UserList signing keys.

## Catalog changes

The source of truth is the readable `data/catalog-source.json`. Do not edit the
generated `data/catalog.sqlite` database directly.

After changing catalog data or curation rules, run:

```bash
npm run build:catalog
```

Do not commit the generated database; CI rebuilds it from the source. Keep existing
title IDs stable when renaming a canonical title because those IDs connect saved browser
data and imported UserLists. Add an alias when a rename is meant to preserve identity.

### Correction packages

The application can export rating edits and completed custom-title candidates as a `UAIC`
review package. Packages are data-only proposals; they do not grant repository or server
access. Validate the package in the UserList correction workspace and inspect every
before/after value before applying it to a local checkout.

Applying a package updates `data/catalog-source.json` and regenerates the ignored SQLite
database. Review the resulting Git diff before committing. A local catalog change becomes part
of the public project only after it is accepted and pushed to `main` through the normal
GitHub permissions and review process.

## Application changes

Before opening a pull request, run:

```bash
npm run format
npm run verify
```

## Interface translations

Contributors can download an English translation template from **My Library → Interface
Language**, fill it out, then install it locally to test it. A local installation is never
official and does not change the repository.

To submit a translation, include the completed JSON in a pull request. Official packs belong
in `public/translations/<locale>.json`; add the matching entry to
`public/translations/index.json`. The pack and registry must use the same locale, language,
positive revision and contributor list. Contributors may use `{ "anonymous": true }`; only
non-anonymous names are shown in the app.

Run this before submitting an official translation:

```bash
npm run check:translations
```

The maintainer reviews the wording, credits and validation result, then merges and releases
the change. Do not mark a locally installed or unreviewed pack as official.

## Pull requests

Describe the user-visible outcome, note any data migrations or compatibility risks,
and include screenshots for visual changes. Never include `data/catalog.sqlite` or files
from `.userlist-keys/`, `.cache/`, `data/covers/`, the legacy `covers/` folder or
`node_modules/`.
