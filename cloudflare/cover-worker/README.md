# UAI cover storage worker

This worker deliberately exposes only immutable cover archives plus the two catalog files:

- `cover-pack.json`
- `catalog-source.json`
- `catalog-source-manifest.json`
- `packages/covers-*.zip`

It uses the `ultimate-anime-index` R2 bucket and does not expose writes, listing, credentials, or arbitrary object keys.
