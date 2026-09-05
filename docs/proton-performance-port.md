# ProtonnCord performance ports

Source snapshots inspected on 5 September 2026:

- [Nightly](https://github.com/ProtonDev-sys/ProtonnCord/tree/57444b9324e9bede6fd311f9689bfd715eb2e9d4), `57444b9324e9bede6fd311f9689bfd715eb2e9d4`.
- [PR #81](https://github.com/ProtonDev-sys/ProtonnCord/pull/81), `8f520c42e1130dbd919f136a7bdc9990c632a815`.
- Initial LawyerCord baseline, `6210ccf67`. Rebased onto automation PR #45 at `b25ed68a80a759e73f2defbbdfd0e5c721a6480f`, preserving its code, dependency fixes and release workflow.

The audit covered the current nightly and PR file inventories and relevant history, then traced the performance candidates and their callers. It is not a line-by-line correctness audit of every unchanged ProtonnCord plugin. Secure Messaging, hardware vaults, encrypted attachments, and their integration hooks are excluded.

## Ported work

| Area | Change | Upstream source |
| --- | --- | --- |
| Notifications | Replace the 10 ms React progress timer with an animation and one dismissal timer; release dismissed queue items. | `e0cdb4b8f`, `fe5f1e704` |
| Visibility | Keep the intersection callback stable so unchanged renders reuse the observer. | `f1409a2b4` |
| Timezones | Reuse up to 128 locale/timezone formatter configurations; keep system timezone probes live. | `e0cdb4b8f` |
| VoiceStats | Use a one-second timer instead of an accidental zero-delay loop. | `354cba425` |
| MemberCount | Subscribe to scalar counts and skip voice-channel selection for tooltip-only renders. | `0f10b5706` |
| Badges | Keep component identity stable; filter GlobalBadges per requested user; keep chat CSS lazy; unregister the same FriendshipRanks descriptors that were registered. | `5e27ab19a`, `8f2bf3cd2`, `abe37adab` |
| Media | Share FFmpeg imports, coalesce APNG worker loading, retry failed loads, and use the existing atomic DataStore updater for sticker metadata. | `d0589070d`, `62d98e029`, `8307cfb61` |
| DataStore | Reuse the cursor transaction; abort failed batches without publishing partial work. | `b3f44838d` |
| Plugin lifecycle | Keep Flux callbacks unchanged across restarts and remove the actual subscribed wrappers. | `a3f23574c` |
| Themes | Load browser theme data concurrently, discard stale results, revoke replaced URLs, abort obsolete ClientTheme fetches, and remove ineffective settings-proxy memoization and copied names. | `008e8f593`, `a4f6ce461`, `fdc9c18b7`, `8f520c42e` |
| Plugin settings | Cancel delayed pagination when visibility changes or the page unmounts. | `54dde06f3` |
| Native CSS | Replace repeated watcher setup for the same renderer and cancel pending initialization on destruction. Preserve independent renderer windows. | `3220c7045`, adapted after review |
| Browser build | Stop building and packaging unused Monaco worker bundles; remove their stale unpacked output. | `008e8f593` |
| ConsoleShortcuts | Resolve aliases on demand, remove module/store scan caches, reuse a preview React root, and release it when closed. | `7ddc3fd62` |
| Decor | Bound public lookup batch delay, deduplicate pending users, discard obsolete responses, abort stopped requests, and select individual avatar records. | `258b778c5`, `a2033394f` |
| DevCompanion | Give each socket one owner and reject events or replies from replaced connections. | `f9748644b` |
| Presence | Cancel obsolete AppleMusic, arRPC and CustomRPC work; coalesce updates; remove connection polling; cancel timers on stop; bound timestamp loops. | `6641fbddb`, `7967dcd1a` |
| Folders and sessions | Cancel deferred folder work; respect disabled animations; invalidate stopped or account-stale session polls. | `fc71649ae`, `89827afea` |
| CallTimer | Remove redundant component wrapping and release old join observations on logout. | `66800f902` |
| Animation and emoji menus | Honor disabled role animation and defer Unicode helper lookup until its menu action is used. | `acdcd25f1`, `b4b8ba1b0` |
| ClearURLs | Abort obsolete rule downloads while preserving the existing URL cleaner. | `90fddb782` |
| ListenBrainz | Cache public metadata and cover art for 15 minutes; keep playback live; clear timers on stop and reject stale cache writes. | `159698f6f`, cache timer repair `ff06cbf8d` |
| ZIP previews | Inspect the directory without inflating the archive, extract selected entries in workers, cap active/waiting extraction, and retain two archives. Validate extraction bounds and reject stale results after stop. | `8cf0d7e1d`, adapted after review |

The ZIP parser and its validation travel together because extracting untrusted files on demand still requires compressed and expanded size limits, path validation and integrity checks. The existing dependency provides worker inflation. No new dependency is added.

## Deliberate exclusions

- Secure Messaging and all its integrations, including the newest nightly receipt-prefetch change.
- Proton branding, updater channels, release workflows, changelog redesign, PWA features and unrelated upstream plugin additions.
- BetterActivities: LawyerCord already has a 500-entry cache bound and failed-fetch retry that the upstream replacement would lose.
- WhoReacted: retain LawyerCord's bounded queue and precise per-emoji subscriptions.
- PlatformIndicators: retain LawyerCord's linear session reduction instead of restoring a sort.
- BetterSessions: retain single-flight polling and changed-only storage writes instead of adding unconditional writes or a separate cache event bus.
- Historical LoadLazyChunks caching: absent from both inspected Proton tips. A historical commit alone is not evidence that current nightly still uses it.
- RecentDMSwitcher account-key migration and modal redesign, CustomRPC preset persistence, Decor authorization/private-write redesign, upload-name semantics, image/crown overrides, command ownership, timestamp restoration, backup rewriting, CSP/updater/security changes, declaration packaging and cosmetic/dead-code cleanup unrelated to the ported work.
- Queue logging and nullable-default fixes are correctness changes without a demonstrated performance gain in LawyerCord's existing implementation.

## Verification

`pnpm testPerformance` runs deterministic module and lifecycle checks plus formatter correctness. The existing CI also runs it. No timing threshold is used in CI.

Measured in this worktree against the initial LawyerCord baseline:

| Fixture | Before | After |
| --- | --- | --- |
| Five-second notification callbacks / component invocations | 500 / 500 | 1 / 1 |
| Intl formatter constructions per warm 100-header batch | 400 | 100 |
| Timezone formatting median per 100 mocked headers | 10.3863 ms | 2.5627 ms |
| Observer constructions over 100 unchanged renders | 100 | 1 |

The fixtures execute actual source with mocked React, stores, timers or transports. They verify reduced JavaScript work, output equivalence, cancellation, retry and resource ownership. These figures do not measure Discord FPS, total CPU, layout or user-visible latency. Theme projections matched the baseline in 540 combinations of filtering, search, lists and pinning.

Optional before/after reproduction requires the initial baseline commit locally:

```powershell
pnpm exec tsx scripts/testNotificationPerformance.ts --baseline=6210ccf67
pnpm exec tsx scripts/benchmarkTimezones.ts --baseline=6210ccf67
pnpm exec tsx scripts/testSettingsPerformance.ts --baseline=6210ccf67
```

Run timing benchmarks sequentially. The regular regression command does not require Git history. Desktop and browser standalone builds, TypeScript, source/style lint, internationalization/patch lint and the artifact credential audit are checked separately. Live Discord rendering and client CPU/FPS remain unverified; this work does not interrupt the other task's installed client.

## Review corrections

- Reject ZIP extraction results whose source cache was cleared while the worker ran. Tests cover coalescing, two active/four waiting limits, retries, queued cancellation and active completion after stop.
- Scope native watcher replacement to one sender so a popout cannot disable the main window's CSS updates.
- Preserve LawyerCord's existing stronger caches, queue bounds, storage writes, branding and release behavior.
- The two existing lint scripts needed URL-to-path conversion for Windows directories containing spaces. PR #45 independently included the same fix, retained on rebase.
