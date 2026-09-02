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

### Editor reviews

Use **Editor → Send editor review** for metadata, episode and franchise proposals. The
recipient previews imported drafts locally before accepting them. A review link is data-only
and never grants repository or server access.

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
