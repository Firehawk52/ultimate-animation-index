# Security policy

## Reporting a vulnerability

Please do not publish an exploitable security issue in a public GitHub issue. Use the
[private vulnerability report](https://github.com/Firehawk52/ultimate-animation-index/security/advisories/new)
so the maintainer can investigate before details become public.

Include the affected version, reproduction steps, expected impact and any suggested
mitigation. Do not include real UserList private keys or other personal data.

## Sensitive local data

Each installation creates an Ed25519 private key in `.userlist-keys/`. The private
key must never be committed, uploaded or shared. The `.gitignore` excludes this
directory by default.

Portable `UWL` codes include only the corresponding public key. Importers verify that
its fingerprint matches the code and that its signature covers the complete validated
payload. This provides tamper detection and key continuity, not real-world identity
verification; recipients must still trust the person who shared the fingerprint.

UserList codes intentionally omit favorites, watch status, personal ratings, private
notes and the sender's display name. Imported codes are verified and validated before
browser data is changed.

Editor review links are data-only proposals and never contain a write token, private user
data or Cloudflare credentials. Importing a review creates local drafts only; official source
updates still require repository review and a local Git checkout.
