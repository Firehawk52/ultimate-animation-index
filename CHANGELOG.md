# Changelog

All notable changes to Ultimate Animation Index are documented here.

## Unreleased

## [2.3.2] - 2026-08-20

### Changed

- Refined the technical typography system: numeric interface values use Michroma at a minimum 16 px, while descriptive metadata and help copy retain their normal reading fonts.
- Reworked Mature content-rating cards so each compact card clearly presents its score and category without relying on a hover tooltip.
- Removed the repository's legacy integration-test suite and test-only HTML validation tooling. Continuous integration now retains formatting, JavaScript syntax, catalog-build, launcher and Docker checks.

## [2.3.1] - 2026-08-20

### Fixed

- Restored the complete Master-style filter toolbar in Adult: quality tier, format, genre and watch status now sit alongside Adult search, sorting and order.
- Kept Adult filters independent from Master, persistent across refreshes and included in private backup/import.
- Refreshed the Adult interface cache key so installed sites immediately load the complete toolbar.

## [2.3.0] - 2026-08-20

### Added

- Added a full Adult toolbar with independent title search, every Master sort mode and a separate ascending/descending control. Adult search and sorting persist across refreshes and private backup/import.
- Reworked content guidance into a shared, severity-coloured five-card system for title details and Adult cards, with accessible compact labels and modern tooltips.
- Added a dedicated **MY LIBRARY** area for the global rating-display preference, private data tools and portable sharing.
- Added a required first-run rating-format setup modal with letter, 10-point and five-star choices. The selection applies across the interface and can later be changed in **MY LIBRARY**.

### Changed

- Renamed the broader personal-data section from **USERLIST** to **MY LIBRARY** while retaining the compatible UWL shared-list format.
- Standardized all built-in tooltips on one modern accessible tooltip layer.
- Clarified the personal letter scale as `F`, `E`, `D`, `C`, `C+`, `B`, `B+`, `A`, `A+` and `S`.

### Fixed

- Ensured rating choices made during first-run setup are saved and immediately reflected in **MY LIBRARY**.
- Added cache versioning for the new interface assets so existing installations receive the current Adult sorting and rating setup code.

## [2.2.6] - 2026-08-20

### Fixed

- Replaced the legacy, non-comparable `Niche` catalog label with the established `B+` tier for all 26 affected titles. Each already has an Overall score of 76, matching the existing `B+` band, so letter, numeric and star filters now remain internally consistent.

## [2.2.5] - 2026-08-20

### Added

- Added a third private rating format: a five-star scale with true half-star selection, giving ten equally spaced rating choices.
- Expanded the letter scale to ten stored steps: `F`, `E`, `D`, `C`, `C+`, `B`, `B+`, `A`, `A+` and `S`.
- Added graphical star badges to title covers and a matching star-tier filter that uses real half-star rendering instead of textual fractions.
- Added episode titles to season trackers from AniList-linked Jikan metadata and TVMaze, with resilient local caching and rate limiting.

### Changed

- Redesigned season episode tracking for clearer titles, full-width use of incomplete rows, a dedicated action console and centred season codes.
- Personal rating controls, recommendation buttons, rating guidance and selects now share the detail panel’s higher-contrast visual language.
- The episode-derived status now reports **On hold** when a series has watched episodes but no episode is currently marked Watching.
- Preserved the selected star format in local UI state and portable user backups.
- Updated Attack on Titan: Lost Girls guidance to place it after season one.

### Fixed

- Matched the star-tier filter’s background, border, typography and chevron to the other Master-page dropdowns.
- Corrected episode-title retrieval and cache versioning so AniList series can refresh title data safely while finished series remain cached.

## [2.2.3] - 2026-08-19

### Added

- Updated Attack on Titan franchise guidance to keep all OVA and side-story entries in the intended watch order.
- Ensured AniList series now includes OVA/ONA/SPECIAL `SIDE_STORY` relations when building unified series trackers, so missing side stories appear.
- Added **Elfen Lied** to the official catalog and explicitly promoted it to the Adult section.
- Added an Adult-section control to catalog rating edits, custom-title edits and the missing-title form; the selection is preserved in UserLists, backups and catalog correction packages.

### Changed

- Kept the one-click catalog-update cache key versioned to avoid stale episode-group state when OVA-side metadata changed.
- Added explicit adult-section toggles to custom metadata and catalog editors, with options preserved in UserLists, backups, and review packages.
- Assigned each newly accepted catalog title a deterministic next catalog rank so new entries no longer display `ADD`.
- Kept the large hand-curated catalog source outside automatic Prettier rewrites so individual title additions remain small and reviewable in GitHub diffs.
- Collapsed catalog rating edits, custom metadata edits and custom-title promotion controls by default, keeping infrequently used tools accessible without dominating title details.

## [2.2.2] - 2026-08-18

### Changed

- Standardized Master, Collections, Franchise Guides and Favorites on one accessible `SEARCH //` component while retaining live filtering and refresh persistence.
- Added search-specific empty states so filtered views distinguish no matches from genuinely empty collections.
- Extended personal letter ratings to `F, E, D, C, B, A, A+, S`, covering the complete 1–10 scale without changing numeric storage or sorting.

## [2.2.1] - 2026-08-18

### Fixed

- Restored the legacy catalog-build entry point required by an updater process started before the 2.2.0 file-extension migration.

## [2.2.0] - 2026-08-18

### Runtime and update reliability

- Fixed automatic updates occasionally starting the replacement server before port 8787 was released.
- Made startup reuse an already running Ultimate Animation Index server and report unrelated port conflicts clearly.
- Required the full UAI health signature before treating a service on the configured port as an existing app instance.
- Standardized active Node.js modules on the `.js` extension, moved the server to `src/` and lowercased update launchers.
- Retained a small legacy `.mjs` restart bridge so one-click upgrades from version 2.1.0 remain compatible.
- Moved downloaded artwork to `data/covers/` with automatic migration from the legacy folder.
- Made the metadata cache human-readable and corrected stale launcher instructions.
- Bound native servers to loopback by default and stopped exposing write/update tokens to remote clients.
- Preserved legacy Docker cover caches, added a container health check and verified container builds in CI.
- Added clear Node, npm, Git and port validation across platform launchers.
- Aligned runtime and development tooling on maintained Node.js releases with precise startup errors.

### Release engineering and project governance

- Expanded CI to Node.js 20 and 22 on Linux, Windows and macOS, including executable-launcher checks.
- Updated GitHub Actions to their Node.js 24-based releases.
- Added one stable protected-branch gate that aggregates every matrix test and the container build.
- Added structured bug, feature and pull-request templates plus monthly dependency update checks.
- Added a repository-wide CODEOWNERS rule so contribution reviews reach the maintainer automatically.
- Added an explicit MIT source-code license while keeping third-party media outside its scope.

### Interface and accessibility

- Added an original browser-tab icon, keyboard content shortcut and assistive active-navigation state.
- Added HTML semantic validation to local verification and CI, then resolved its actionable findings.
- Replaced implicit keyboard behavior on title and collection cards with explicit accessible buttons.
- Made the active cover heart itself visibly pink across every catalog tab.

## [2.1.0] - 2026-08-18

### Community catalog corrections

- Added editable Overall, Production, Story, Emotion and content ratings to every catalog title.
- Added local correction drafts and portable `UAIC` review packages with validated before/after previews.
- Added direct catalog saving for the computer running the local server without exposing write access in exports.
- Allowed completed custom titles to become unranked catalog entries when every required rating is supplied.
- Preserved custom-title quality scores in private backup and restore files.
- Added strict server-side limits, conflict detection and atomic catalog regeneration for accepted changes.
- Replaced duplicate `RUN` launchers with consistently named `start.bat`, `start.command` and `start.sh` files.

## [2.0.13] - 2026-08-18

### Clear completion states

- Added a dedicated completion label above progress meters when a series or franchise reaches 100%.
- Added a high-contrast completed badge and subtle lime frame to completed title covers.
- Added a matching completed badge and highlighted state to fully watched franchise guides.
- Added a restrained lime pulse to completed progress meters while preserving reduced-motion support.

## [2.0.12] - 2026-08-18

### Safer season completion

- Applied the same two-second confirmation flow to **Mark season watched**.
- Added a distinct green confirmation state while sharing cancellation, accessibility and loading behavior with reset.
- Replaced CSP-blocked inline progress styles with SVG meters so overall and per-season status bars fill correctly.

## [2.0.11] - 2026-08-18

### Safer episode reset

- Added a two-second armed state before a season reset can be confirmed.
- Cancelled pending resets when the user clicks anywhere else or closes the active dialog.
- Added accessible loading, confirmation and reduced-motion states matching the episode tracker design.

## [2.0.10] - 2026-08-18

### Sorting and ratings

- Split main-list and collection sorting into separate **Sort by** and ascending/descending controls.
- Saved both sort directions across refreshes and private backup/import.
- Changed the letter scale to `S`, `A+`, `A`, `B`, `C` and `D`, with `S` as the highest rating.
- Removed the obsolete Python reference from the README.

## [2.0.9] - 2026-08-17

### One-command updates

- Added `npm run update` to safely fast-forward clean installations from `origin/main`.
- Added one-click update launchers for Windows and macOS plus a Linux update script.
- Refused automatic updates while the server is running, outside `main` or when local source changes could be overwritten.
- Synchronized packages and regenerated the local catalog after a successful update.
- Added a protected **Update now** action that installs updates in the background, restarts the server and refreshes the page.
- Added the update command to the in-app release notification and documented the workflow.

## [2.0.8] - 2026-08-17

### Compact top navigation

- Reduced the sticky topbar height and internal spacing while preserving its angled branding and navigation hierarchy.
- Scaled the brand mark, supporting type and add-title action proportionally across desktop and mobile layouts.
- Kept the update notification offset aligned with the slimmer topbar.

### Collection navigation and sorting

- Kept the selected studio or creator title list open when viewing a title, so Escape returns one level at a time.
- Added persistent collection-title sorting by rating, newest release or name.
- Included the collection sort preference in private UI backups.

## [2.0.7] - 2026-08-17

### Content-guide color mapping

- Matched every content-guide legend marker to its corresponding severity-bar color.
- Centralized the six severity colors so the legend and title details cannot drift apart.
- Increased compact severity-label text for clearer catalog-card scanning.
- Synchronized favorite-heart color and state immediately across Adult, Master and Favorites.

## [2.0.6] - 2026-08-17

### Unified UserList format

- Renamed the portable signed sharing envelope to the single `UWL` format.
- Removed the unused legacy compatibility path because no older codes were publicly issued.
- Updated interface guidance, security documentation and validation tests to use `UWL` consistently.

## [2.0.5] - 2026-08-17

### Node-only catalog generation

- Removed Python from local startup, Docker and continuous integration requirements.
- Replaced the Python catalog builder with a Node.js generator and structural validator.
- Added a readable, version-controlled catalog source while keeping the generated browser database outside Git.
- Regenerated the local browser database automatically when it is missing or its source has changed.
- Kept explicit `npm run build:catalog` rebuilding for development workflows.

## [2.0.4] - 2026-08-17

### Automatic update notifications

- Added a cached server-side check for the latest published GitHub release.
- Added an in-app update notice with the installed version, latest version and direct release link.
- Allowed each release notice to be dismissed locally without hiding notifications for future versions.
- Kept update-check failures silent so the self-hosted catalog remains fully usable offline.

## [2.0.3] - 2026-08-17

### Portable UserList verification

- Added the portable UWL envelope so signed UserLists can be verified and imported on another installation.
- Embedded only the sender's public Ed25519 key; private signing keys remain local and excluded from Git.
- Rejected malformed, modified and schema-invalid codes before importing any data.
- Displayed the verified sender-key fingerprint after import so recipients can compare it with the sender.
- Added cross-installation verification coverage to the server test suite.

## [2.0.2] - 2026-08-17

### Selectable rating formats

- Added a global choice between the S+ letter scale and the 10-point scale.
- Applied the preference to catalog quality labels, filters, collections and personal rating controls.
- Preserved numeric personal ratings internally so format changes do not affect sorting, backup or import.
- Saved the selected format across refreshes and included it in private user backups.

## [2.0.1] - 2026-08-17

### Private backup and restore

- Added local JSON backups for watch statuses, ratings, private notes, favorites and episode progress.
- Included personal opinions, custom titles, imported sources and saved interface preferences.
- Added validated merge and replace import modes with rollback if a browser storage write fails.
- Kept backup creation and parsing entirely in the browser without sending private data to the server.

## [2.0.0] - 2026-08-17

### Episode and series tracking

- Added per-episode `Unwatched`, `Watching` and `Watched` states.
- Grouped AniList prequels, sequels, OVAs and concluding specials under one series tracker.
- Added TVMaze season and episode tracking for western shows such as Arcane.
- Synchronized episode progress between title details and franchise guides.
- Added season actions for advancing to the next episode, completing a season and resetting progress.
- Derived the title-level watch status from episode progress while preserving manual `On hold` and `Dropped` states.
- Cached finished series permanently and checked releasing, announced or paused series whenever their tracker is opened.

### Personal library

- Added distinct cover icons for every watch status.
- Persisted searches, filters, sorting, dropdowns and interface preferences across refreshes.
- Added editable custom titles with genres, tags and independent content-rating values.
- Included custom metadata in signed UserList imports and exports.
- Added metadata lookup and conservative content-rating estimates for custom titles.
- Added removal of custom titles and their associated local data.

### Interface and content guidance

- Redesigned content-severity bars with different lengths, colors, labels and numeric values.
- Added a responsive, keyboard-accessible season tracker that follows the existing visual system.
- Fixed toast notifications appearing behind dialogs.
- Improved the readability of the generated catalog JSON and contributor-facing source.

### Public repository

- Added English setup, architecture, contribution, security and copyright documentation.
- Added annotated screenshots for the catalog, content ratings, franchise guides and episode tracking.
- Kept generated catalogs, downloaded covers, caches, personal data and all video files out of Git.
- Added automated formatting, syntax, catalog and server tests through GitHub Actions.

[2.0.0]: https://github.com/Firehawk52/ultimate-animation-index/releases/tag/v2.0.0
