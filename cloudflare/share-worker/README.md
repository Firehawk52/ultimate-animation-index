# Ultimate Animation Index share worker

This Worker is the temporary transport for two deliberately separate payload types:

- `recommendation-list` wraps a signed `UWL` list.
- `editor-review` wraps a `UAIE` editor review package.

It never receives user-data backups, cover packs, Cloudflare R2 credentials, or a catalog write token.

## Cloudflare dashboard setup

1. Create the private R2 bucket `ultimate-animation-index-shares`. Do not enable an R2.dev public URL.
2. Add a lifecycle rule that deletes all objects after 30 days.
3. Create the Worker named `ultimate-animation-index-shares` and paste/deploy `src/index.js`.
4. Add an R2 binding named `SHARES` to that bucket.
5. Add two Rate Limiting bindings: `PUBLISH_LIMIT` (5 requests / 60 seconds) and `READ_LIMIT` (60 requests / 60 seconds).
6. Create a Turnstile widget for `localhost` and `127.0.0.1`, then add its secret as the Worker secret `TURNSTILE_SECRET`.
7. Put the Worker URL and public Turnstile site key in the local app `.env` using `.env.example` as the template, then restart the app.

R2 lifecycle cleanup is asynchronous. The Worker also rejects expired payloads immediately, so an object cannot be read during the cleanup window.
