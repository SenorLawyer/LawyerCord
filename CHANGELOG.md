# Changelog

All notable LawyerCord changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/) with a fourth packaging revision retained while the project remains compatible with its upstream version format.

## 2.1.2.0 - 2026-09-05

### Fixed

- Check patch definitions with quoted keys or whitespace instead of skipping them before parsing.

- Inspect individual patch properties so compact formatting cannot hide lint errors.

- Limit patch lint to patch definitions instead of flagging unrelated URL rewrite rules.

- Remove an invalid, ineffective transform from the hidden-message indicator.

- Report attachment read failures instead of opening a schedule with missing files.

- Stop scheduled reaction retries when the initiating account changes.

- Use the configured check interval for overdue scheduled messages that cannot currently send.

- Keep scheduled sends from proceeding under a different account after saving queue state.

- Stop pending scheduled sends and their follow-up notifications when the initiating account changes.

- Suppress scheduled reactions and notifications after shutdown while preserving successful-send cleanup.

- Prevent scheduled message requests from starting after shutdown during storage or attachment loading.

- Stop automatic scheduled-send batches from starting another message after shutdown.

- Stop restoring scheduled previews after cleanup or an account change, and skip messages removed during restoration.

- Wait for scheduled preview insertion before reporting completion and log preview failures without message content.

- Ignore delayed scheduled-message previews after cleanup, replacement, or an account change.

- Ignore stale scheduled-message storage reads after newer loads, queue edits, or shutdown.

- Reschedule interval changes without starting the scheduled-message plugin while it is disabled.

- Prevent a pending scheduled-message startup from restarting the scheduler after the plugin is disabled.

- Preserve attempted scheduled messages until sending succeeds and prevent automatic retries after failed or interrupted attempts.

- Stop scheduled messages from sending with missing attachments when an upload fails.

- Remove redundant sticker category wrappers that assigned the same React key to every pack.

- Use CSS for sticker settings hover styling and give the icon button an accessible name.

- Remove duplicate sticker search state and its shared timer so clearing search cannot restore an older query.

- Reuse shared async loading for recent stickers, removing the manual loader and handling failures and unmounts.
- Derive the sticker inspector’s pack label from the hovered sticker, removing stale duplicate selection state.
- Use the shared async hook for sticker picker loads and derive its sidebar from loaded packs, removing duplicate state and effects.
- Handle partial sticker settings load failures and ignore completions after the settings close.
- Preserve pending replies during sticker conversion and upload failures, and clear only the matching reply after a successful upload message post.
- Insert sticker links without duplicating existing draft text or clearing a pending reply.
- Handle sticker conversion, upload, and message-post failures without unhandled rejections or stale-account notices.
- Stop stale sticker sends after the active Discord account changes during conversion or upload.
- Keep sticker conversion input and output filenames distinct and reject failed FFmpeg executions.
- Load FFmpeg only for animated sticker conversions and terminate each worker afterward. Remove the picker’s FFmpeg state and context.
- Save sticker payloads and metadata atomically, and delete packs and recent entries in one transaction.
- Reject malformed saved sticker metadata while preserving the original records.
- Normalize missing sticker pack titles without mutating the imported object, and remove the single-use metadata conversion helper.
- Reject malformed or mismatched stored sticker packs without deleting the stored records.
- Validate every sticker pack in an imported file before saving any of them.
- Refresh sticker settings after migration, handle storage failures, and remove the unused recent-sticker setter.
- Allow interrupted sticker migrations to resume without replacing current packs or recent stickers.
- Report incomplete sticker migrations once and retain legacy recent stickers while packs remain unmigrated.
- Match migrated LINE emoji IDs and sticker pack references to the current importers.
- Preserve custom sticker packs during legacy migration and stop deleting saved packs when migration cleanup fails.
- Store sticker pack payloads under dedicated keys so imported IDs cannot overwrite unrelated settings. Keep legacy payloads intact while hiding deleted packs.
- Remove the unused dynamic sticker pack refresh function and its credential forwarding path.
- Fetch audio directly for visualizations instead of forwarding audio URLs through a third-party proxy.
- Stop automatically uploading legacy Streaks records that lack an owning account. Preserve the local records.
- Remove Navidrome instance artwork sharing to keep server authentication out of Discord asset requests, and migrate existing selections to None.

- Remove SupportHelper execution of JavaScript snippets from messages and embeds while preserving diagnostic actions.
- Preserve successful webpack patches and their diagnostics when later replacements fail.
- Resolve bulk webpack lookups when multiple matches share one module.

- Finish removing retired Questify auto-completion code, network handlers, and the related ChannelTabs animation. Preserve quest browsing preferences and genuine progress displays.

- Remove unused message logger native write handlers, cache exposure, and obsolete types.

- Remove unused MarkdownTables parser entry points and a dead helper.
- Retain outgoing MessageBurst text until the edit resolves, and remove its unused popover dependency.
- Preserve Source resolution when changing screenshare frame rate.
- Keep InvisibleChat decryption local by removing automatic URL preview requests to Discord.

- Cancel instant screensharing when its selected source is unavailable instead of sharing a different screen or window.
- Use the managed message hook for Ingtoninator so its API dependency and cleanup are handled automatically.
- Remove the empty contact-history startup wrapper and its unnecessary async yield.
- Preserve saved hidden servers when the plugin stops before loading finishes, and flush only pending edits.
- Preserve existing Chromium feature flags when applying startup workarounds.
- Remove an unused native download helper and correct the pull request release instructions.
- Preserve literal CSS in userscript builds and remove obsolete browser editor metadata and About page scripting.
- Use native integer decoding for extension headers and reject truncated archives.
- Resolve cancelled file pickers and release their temporary inputs.
- Simplify extension extraction, reject paths outside the extension directory, and finish cleanup before reporting installation failures.
- Await backup file imports, preserve empty QuickCSS backups, and remove backup-content logging and duplicate import handling.

- Honor the default two-way cloud sync direction and remove unreachable startup warnings and unused notification code.

- Keep cloud sync failures retryable and report failed downloads or deletions instead of recording success.

- Preserve zero volume when creating audio players.

- Delete the unused predecessor to the UserSettings API.

- Delete notification log entries by their unique ID without overwriting concurrent updates.

- Enable the badges API for plugins declaring profile badges.

- Propagate nested dependency failures and restart requirements before starting plugins.

- Handle queued task failures without unhandled promise rejections while continuing queued work.

- Require linked-message previews to match the requested message ID.

- Replace the hand-written attachment metadata base64 codec with browser primitives.

- Validate desktop favourite attachment downloads, reject redirects, cap downloads at 500 MiB and return safe errors.

- Apply the existing clip size limit to native file reads and reuse the byte-upload writer for selected clips.

- Remove unused icon viewer modal styles.

- Use the managed message hook for random mentions and choose members from the destination channel.

- Propagate folder-read and size-limit failures when automatically zipping dropped folders.

- Preserve incomplete automation log records until their remaining bytes arrive.

- Validate AI conversation entries before serialization and forward only their role and content.

- Delete unused automation cloning and linear-flow helpers.

- Use the existing validated data-path reader for automation templates and AI inputs.

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
