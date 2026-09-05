# Changelog

All notable LawyerCord changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/) with a fourth packaging revision retained while the project remains compatible with its upstream version format.

## 2.1.1.0 - 2026-09-05

### Fixed

- Reduce notification updates, timezone formatting work, visibility observer churn and repeated badge rendering work.
- Cancel obsolete plugin requests, presence updates, theme loads and native CSS watchers while preserving independent Discord windows.
- Share media loading, update sticker metadata atomically, cache ListenBrainz metadata and extract ZIP preview files only when opened.
- Remove unused browser editor bundles and cancel settings pagination after leaving the page.
- Port the applicable ProtonnCord nightly and PR #81 performance changes without the secure messaging extensions. Add regression checks for resource cleanup and output compatibility.

## 2.1.0.0 - 2026-09-05

### Added

- Automations can now react to this computer: triggers for joining or leaving a Roblox game (with the game's name, players, visits, icon and link, and how long you played), for a program starting or closing, and for Codex starting, finishing or asking a question.
- New block families: This computer (list running programs, is a program running, wait for a program, run a program, read a file, open a link), Roblox (current game, look up a game) and Codex (last result, recent sessions).
- Roblox game log and Codex finished templates.

### Changed

- Automations now default off. The master switch stops runs, queues, trigger listeners and computer polling while keeping the editor available.
- Computer events scan only the requested sources, with no permanent background timer.
- Add workflow migration, explicit data connections, reusable workflows, cancellable execution, calendar schedules and dry-run tests.

- Rebuild the Automations settings page as a spacious list with an on/off switch, plain-English "when it starts" text, template cards, and grouped run history and settings.
- Rebuild the automation builder: one toolbar, a single "What happens next" connections panel, beginner-first block settings with everything else folded under Advanced, a "+" on every output dot to add a connected block, hover-to-remove connection lines, wheel panning with Ctrl+wheel zoom, and grid snapping on release instead of during the drag.
- Auto-arrange now lays automations out left to right, with the Yes branch above, the No branch below, and the error branch beneath that.

### Fixed

- Update the pinned fast-uri dependency to 3.1.6 to resolve the dependency audit failures.

## 2.0.1.0 - 2026-08-29

### Fixed

- Restore Discord's original app archive when an interrupted update leaves only the LawyerCord patch marker, so Install, Reinstall / Repair, and Uninstall work again.

## 2.0.0.0 - 2026-08-29

### Fixed

- Make Stable, Beta, and Nightly updates fall back to the newest eligible release instead of reporting an older channel build as current.
- Show the installed LawyerCord version in Updater settings.
- Stop advertising Favorites editing because Discord enforces that permission server-side.

### Changed

- Advance Beta and Nightly source-update branches only from successful eligible releases.
- Replace stale Dependabot pull requests with pinned GitHub Actions updates and remove the Dependabot schedule.

## 1.17.0.0 - 2026-08-29

### Added

- Add Lawyers Fake Nitro, a targeted override for high-quality streaming and Favorites editing that does not change emoji, sticker, or theme access.

## 1.16.2.0 - 2026-07-30

### Fixed

- Repair folder-style patched Discord installations before installing LawyerCord.

## 1.16.1.0 - 2026-07-29

### Fixed

- Publish the standalone updater asset as `desktop.asar` alongside the LawyerCord-named copy.
- Defer Ghosted's private-settings restore until startup so LawyerCord loads correctly.

## 1.16.0.0 - 2026-07-29

### Added

- Automated nightly, beta, and stable release channels driven by protected pull-request merges.
- Release ZIP checksums and artifact auditing for Discord credential patterns and private runtime data.
- Windows graphical and command-line installer executables for nightly, beta, and stable releases.
- Discord-style local control panel with scrollable server lists, real runtime status, scoped message search, date-range message exports, and expandable privacy activity.
- Bulk channel selection controls for local indexing and message exports.
- Stable, beta, and nightly channel selection for standalone LawyerCord updates.

### Changed

- New installations begin with no channels approved for local semantic indexing.
- Live Discord MCP verification accepts authorized target IDs only through local environment variables.
- Message search now means local hybrid search across only channels explicitly selected in the panel; it does not search every Discord channel or DM.
- Removed the separate index-channel and security tabs. Protocol migration remains a visible runtime warning rather than a standalone settings page.
- Discord MCP message responses now retain Components v2 payloads.

### Security

- Release artifacts cannot contain local Discord MCP/control-panel configuration, bridge secrets, queues, ledgers, indexes, downloads, or Discord token-shaped values.
- The optional MCP remains unrestricted within its fixed tool surface but uses only the enabling installation's current Discord session and locally generated bridge secret.
- Release installers are built from a pinned, hash-verified Equilotl revision, embed the exact LawyerCord client payload, and do not download or self-update executable code.

### Planned

- An audited SecureMessaging protocol v2 after the provider, licensing, packaging, and migration gate is approved.
- Signed installable artifacts and platform-specific release verification.

## 1.14.16.0 - 2026-07-28

### Added

- LawyerCord product identity, browser metadata, local icon, and application-data namespace.
- App-lifetime loopback control panel with account, guild, relationship, plugin, storage, and network statistics.
- Encrypted local approved-channel search and tamper-evident evidence exports.
- Generated privacy inventory covering plugin domains, storage, and elevated capabilities.
- Scoped live Discord MCP verification harness.
- Security, privacy, contribution, CI, dependency review, CodeQL, audit, and controlled release documentation.

### Security

- Audited the ProtonnCord fork delta and documented remaining trust boundaries.
- Disabled source auto-update and cloud sync by default.
- Removed mutable remote installer execution and inherited upstream publishing workflows.
- Updated production and development dependencies until the full audit reported no known vulnerabilities.
- Replaced the obsolete `zip-local` build wrapper with the current JSZip API so extension packaging no longer depends on vulnerable JSZip 2 behavior.
- Retained the intentionally unrestricted Discord MCP with its fixed tool surface, authenticated local queue, attachment validation, mention suppression, and sent-message-only deletion ledger.

### Changed

- Renamed product-facing ProtonnCord identifiers to LawyerCord while preserving attribution and cryptographic protocol compatibility identifiers.
