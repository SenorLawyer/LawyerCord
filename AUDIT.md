# Project audit working report

This audit is still in progress. File coverage records review work; it does not establish that every finding is resolved or that the client is ready to release.

## Scope and source

- Baseline: `6e664e03ba3d0b7746ce34740ca444f5112b04bc`, published as `nightly-20260905-1918-6e664e03`.
- The baseline inventory contains 1,661 tracked files, including source, tests, configuration, documentation, and assets. The review ledger records all baseline entries as reviewed.
- At `480d81f23`, the branch contains 1,656 tracked files: this report and five added test files, with eleven removals relative to the baseline.
- The five added tests cover startup flags, CRX conversion, extension installation, file selection, and settings synchronization. Their file hashes were rechecked against the reviewed versions at `480d81f23`.
- The generated internationalization mapping was checked semantically against the runtime hash function across 19,440 pairs. That is generated-data validation, not manual review of each pair.
- Main at `8fc182ba7` was reviewed separately. A fresh fetch at `480d81f23` confirmed that main and the published nightly remain unchanged. Main changes have not been integrated into this branch.

Changes are accumulated in [PR #47](https://github.com/SenorLawyer/LawyerCord/pull/47). The PR remains a draft with `release:nightly`; merge and auto-merge are paused. It still conflicts with main.

## Approach and changes

The audit prioritizes deletion, then simplification, then optimization. Code is left unchanged when a proposed improvement lacks a concrete justification. Relevant callers and history are checked before shared behavior changes.

The accumulated changes cover storage consistency, asynchronous lifecycle handling, plugin behavior, native boundaries, and build/release tooling. Recent scheduling work includes:

- Retaining attempted messages after uncertain or failed sends instead of automatically replaying them.
- Requiring every attachment upload to succeed before sending.
- Recording the originating account and enforcing it for sending and preview creation.
- Pausing older entries without a trustworthy account rather than assigning the active account.
- Stopping stale work across shutdown, logout, and reconnection.
- Preserving newer composer drafts and uploads after scheduling.
- Serializing queue reads and mutations, validating storage before the first write, and exposing changes in memory only after storage commits.
- Preserving invalid stored queues and blocking writes until a valid reload.
- Removing duplicate reaction state and preventing delayed previews from restoring removed or outdated entries.
- Rendering video previews without an extra seek, with cleanup on success, failure, and timeout.
- Preserving queue entries and previews after failed deletion, with failure feedback in the UI.
- Removing unused rescheduling and channel-filter helpers.

ThemeLibrary changes remove duplicate filtering state, cancel closed-tab requests, and lock like actions before authorization. Native downloads validate IDs and filenames, bound response size and duration, reject redirects, and replace installed files only after a temporary write succeeds. Live provider testing corrected an inaccurate string-only ID declaration.

The development-only userplugin installer now propagates installation and update preparation failures, stops on missing or malformed metadata, handles Git launch failures, and checks Git results before building updates. Review closure, page-load failures, cancellation cleanup, and external-link failures now settle the pending operation. Cleanup revalidates directories; clone destinations are explicit; review links are restricted to repository URLs. Install, update, and uninstall reject overlapping mutations within the same native instance, holding ownership through review, build, and cleanup settlement. Background update scans wait for mutations and skip directories removed before scanning. Git fetch disables terminal and Git Credential Manager prompts. External filesystem changes, separate native instances, custom credential helpers, and live Electron behavior still require review.

New installations clone into hidden staging directories excluded from plugin discovery and native builds. Replacement requires confirmation after review, preserves the installed source until promotion, and attempts to restore it if promotion fails. Replacing native code with a renderer-only plugin still requires restart. Isolated real-filesystem fixtures verified fresh installation, replacement, cancellation, and rollback after an injected promotion failure; an actual local Git clone verified the empty staging-directory boundary. These fixtures do not install or modify user plugins. Process crashes, rollback failures, and failed builds after promotion remain open.

Review templates use typed file imports and substitute placeholders in one pass, preserving literal metadata. Warning styles render directly in the stylesheet; the custom staging element and runtime style-copy step were removed.

Installer UI changes preserve existing settings when enabling unloaded plugins, render installed plugins absent from the running bundle, honor direct custom channel allowlists, and handle cancellation without treating it as an error. Duplicate update-name state and sorting work were removed. The uninstall control uses the shared button with an accessible name and consistent sizing.

The installer parses metadata using the existing TypeScript dependency without executing plugin code. Its actual handler accepts all 379 checked plugin declarations, including four rejected by the old regex. Development-only native plugins are excluded from ordinary release builds, keeping the parser out of those bundles; development and reporter builds retain it.

Native plugin discovery now applies the renderer target restrictions in desktop builds. Actual temporary plugins with `.web`, `.discordDesktop`, `.vesktop`, and `.equibop` suffixes verified matching renderer and native inclusion in both desktop targets. Those fixtures were removed and the output rebuilt without them.

Notification changes remove unused toast close callbacks, clear toasts on session changes, subscribe visible toasts to display settings, and enforce reduced queue limits on arrival. Shared notifications and toasts use separate action and dismiss controls alongside message content, with accessible labels and keyboard focus outlines. Their timers pause while keyboard focus remains inside the card. Guild toasts use Discord's resolved notification level and the raw message mention list rather than reconstructing settings and searching message text. Isolated fixtures cover these behaviors; live Discord, screen-reader acceptance, role/everyone mentions, and remaining mute-policy questions are still open.

Narrator changes preserve saved voice preferences while voices load, refresh the voice picker on browser events, retain unfamiliar language tags, and remove stale availability warnings and the English-only sample restriction. Speech formatting preserves placeholder text inside names. Announcements use the voice channel's server for nicknames, tolerate unavailable speech support, and initialize from an existing voice connection. Tests exercise actual helpers and components with mocked speech, stores, and React hooks; live playback, session transitions, and speech queue ownership remain open.

VoiceStats now rejects stale startup reads before changing totals, waits for storage before tracking, keeps failed saves pending for a later attempt, preserves sessions on repeated channel events, and pauses tracking when stored totals are malformed. Actual DataStore code in isolated Chrome preserved invocation order for 100 concurrent writes with both cold and initialized storage, so no additional save queue was added. Account scope, unsaved totals across restart, recovery controls, and clock behavior remain open.

VoiceRejoin now preserves existing active calls, cancels pending attempts on the user's voice activity or logout, stops stale channel polling, and ignores stale persistence-cache completions. Channel and active-session state are written in one DataStore transaction. Actual code in isolated Chrome verified that an aborted transaction preserves both old values and a retry updates both. Saved targets now carry an account owner, and reconnect attempts reject foreign or ownerless records and account changes during lookup. Paired reads use one transaction; saved channel fields are validated before use. Live connection readiness, permission checks, timeout semantics, and state changes after a paired read remain open.

The proposed version is `3.0.0.0` because older scheduled data now requires explicit recovery. See [VERSIONING.md](VERSIONING.md) for the compatibility and downgrade implications. No release tag has been created for this audit.

Message pronouns now read the message channel's guild rather than the browsed channel, and subscribe to formatting, self-visibility, and account changes. All UserSettings API consumers declare their dependency explicitly. The required SupportHelper currently enables that API globally, which previously masked missing declarations.

StatusWhileActive binds saved status to its account, discards it on logout, initializes from the current call when enabled, and preserves manual status changes when leaving or stopping. The unrelated channel-status text event handler was deleted. Mocked lifecycle regressions cover these changes. Repeated in-call voice events now preserve the session record and manual presence choices. Failed applications release that record for retry; live event ordering remains unverified.

AutoDND now binds restoration to the account and the status it applied, clears saved state on logout, and restores on shutdown without overwriting manual changes. Enabling AutoDND reads already-running games from the shared store. Invisible-status exclusion no longer blocks game-exit cleanup. Both automatic status plugins propagate Flux update promises and log asynchronous lifecycle failures locally. Repeated game events no longer reapply the status during a recorded session, including when the initial status already matched. Failed applications permit retry without clearing a newer session. Failed restoration recovery remains under review.

GIF descriptions handle missing sources, exclude query parameters and fragments, and match literal GIF extensions. BetterGifPicker now marks its patch-dependent setting as requiring restart. StickerBlocker removes unused wrappers and a repeated ID, uses Discord's React export, and subscribes to display preferences without requiring restart. The block decision now subscribes to the saved list; live patch compatibility and actual client refresh remain open. SteamStatusSync skips unmapped status launches; its event payload assumptions and live protocol behavior still require validation.

TalkInReverse now has one plugin-owned send hook, preserves grapheme clusters when reversing text, and shares temporary toggle state across composers using the existing Zustand API. Its duplicate SVG was removed. The chat-button API already provides the error boundary; no extra wrapper was added. Live composer and subscription behavior remain unverified.

StreamingCodecDisabler no longer assumes all codecs are supported or carries capability values across responses. It validates complete responses before applying settings, ignores callbacks from stopped runs, logs asynchronous failures, and hides the unimplemented VP8/VP9 controls while retaining saved keys. Codec support does not prove prior enabled state, so restoration still needs native evidence.

StatusPresets saves special object-property names as ordinary entries, deletes by the stored key, and subscribes its submenu to preset and premium-state changes. Actual SettingsStore tests cover change notifications and serialization/reloading. Failed applications produce one failure toast; invalid expiration values are rejected before updating Discord. Valid expiration tests cover no expiration, timed expiration, and next local midnight across daylight saving. The internal saved-record field is hidden from plugin settings. Live custom-status payloads and remaining saved-data validation still need work.

WebContextMenus shares image downloads, reports copy/save failures, releases decoded bitmaps, and preserves URLs outside Discord media. Real browser conversion checks cover bitmap cleanup and PNG pixels; OS clipboard permissions and live menus remain unverified.

UserPFP separates remote avatars from saved local overrides, gives local choices priority, rejects malformed remote maps, and cancels stale database loads. Avatar edits use transactions before updating memory. File reads cancel on replacement, typed URLs, or unmount, and guild avatar URLs are no longer rewritten. Legacy saved entries are preserved because their provenance is unknown. Local-data validation, file constraints, and live-client behavior remain under review.

MediaPlaybackSpeed preserves a speed chosen before the first voice play event, identifies voice controls through an explicit patch prop, and falls back to 1x for invalid saved rates. Its control uses the shared button and radio menu items. CustomFolderIcons removes the redundant save helper, unused class, forwarding callbacks, repeated lookups, and non-null assertions; its renderer uses the shared error boundary. Regression fixtures cover these paths. Live patch matches, layout, and remaining settings reactivity are unverified.

Sticker menus use format metadata instead of CSS-name guesses, and sticker blocking reads subscribed settings without a duplicate cache. Expression cloning settles file-read failures, validates server errors, captures the chosen name before asynchronous work, keeps visible input and validation aligned, and subscribes its server list to account, permission, emoji, and sticker stores. Clone controls use shared keyboard-accessible buttons. Each modal owns its pending request, prevents duplicate activation, and cancels on cleanup; a two-modal fixture verifies that closing one leaves the other request running. Plugin stop and logout cancel downloads and file reads. Intentional cancellation produces no failure toast.

CopyStatusUrls awaits the shared clipboard helper and reports asynchronous failures. Its metadata result is validated before copying; malformed results leave the clipboard untouched. The broad webpack finder and patch still need live-client validation.

Updater checks now clear stale selections and reject superseded downloads before writing. Renderer checks respect resets, concurrent update requests share work, failed rebuilds remain available for retry, and recovery prompts relaunch only after success. HTTP archive replacement writes to a temporary sibling before renaming it into place. Isolated filesystem tests cover partial writes, rename failures, retries, and real ASAR contents. Native operations already in flight, actual Electron archive locking, archive integrity checks, and crash durability remain open.

RelationshipNotifier snapshots guild, group, friend, and request data before asynchronous persistence. Checks stop after account changes, logout, restart, or reconnect; old caches and manual-removal markers are cleared at session boundaries. Overlapping manual removals retain separate markers, and delayed alerts recheck current relationships and settings. Notification rejections are logged. Startup sync failures are logged, and connection setup cancels the duplicate startup timer. Guild and group removals keep storage current with alerts disabled, using one path for manual and external removals; two redundant deletion helpers were removed. Deferred-storage and lifecycle fixtures cover these changes. Real Discord event ordering, failed manual operations, and reconnect baseline ordering remain open.

PinDMs reads categories from the current account settings instead of retaining a startup array. Category modals preserve account ownership through lazy loading and reject edits to replaced categories, using the underlying SettingsStore object identity rather than transient proxy identity. Forms reject blank names, normalize cleared colors, and ignore duplicate category saves. Render callbacks are released on unmount without clearing a newer mount. The shared settings hook now compares subscription path values and snapshots paths for cleanup, avoiding resubscriptions caused only by new array objects. Fixtures use actual SettingsStore behavior with mocked React hooks; live sidebar rendering and sorting assumptions remain unverified.

VoiceMessages preserves the browser recorder MIME type, releases streams after failure or unmount, and handles repeated controls using the recorder state. Preview timers run only while recording, and preview URLs belong to committed audio blobs. Send requires completed metadata matching the current blob. Native recording paths reject invalid types before filesystem access. Focused fixtures cover these boundaries; isolated Chrome checks use synthetic audio streams. Desktop recorder lifecycle, upload format handling, account and channel ownership, and live message delivery remain open.

Transcription workers release script URLs when construction fails. Prepared-audio failures remove only their own cache entry, preserving newer retries. Copy controls use the shared clipboard feedback instead of custom state and timers, and malformed timestamp ranges are discarded while transcript text is preserved. Worker callbacks use unknown payload types, and native audio bytes retain their precise buffer type. Synthetic Chrome decoding verifies mono/stereo mixing, resampling, and context closure. Model downloads, account ownership, cache memory limits, and live Electron behavior still need further validation.

Transcription stop and logout terminate active workers and invalidate pending results before clearing caches. Result caches and component keys include the account, and jobs check current account ownership before starting and accepting delayed results. Language pickers retain their opening account, session, and job. Model URLs require HTTPS without credentials or nonstandard ports on the existing hosts; cached and downloaded responses share one path using the transferred byte length. Cache storage failures are reported, and progress percentages are finite and bounded. Fixtures cover these changes; live account event ordering, already-issued native/provider requests, model integrity, redirects, and memory limits remain open.

Translate retains the selected provider when DeepL credentials are missing or its quota is exhausted. It reports the failure instead of forwarding text to Google or resetting provider and language settings. The existing auto-translation send hook cancels sending on translation failure. Provider fixtures verify that these failures make no Google request.

Translation responses validate required fields and report provider failures without source text or response bodies. Native provider POSTs reject redirects, and unused error bodies are cancelled. Missing message views discard late results; an older view cannot remove a newer view's handler. The unused fallback language converter was deleted. Account ownership, overlapping requests, native response limits, and live provider compatibility remain open.

Translate language options follow provider changes, and only the main composer owns the enabled tooltip. Native handlers reject invalid argument types and omit raw exceptions from IPC failures. Auto-translation cancels before changing text after account changes, logout, plugin stop, disabled settings, or intervening text edits. Context-menu and popover translations share one delivery function that rejects results from previous sessions. Deferred fixtures cover these cases; already-issued requests, overlapping same-message requests, mounted accessory state, response limits, and live account-event ordering remain open.

DeepL automatic detection omits the source-language field, and source labels use the real language tables without inherited object properties. Its native handler rejects UTF-8 request bodies above the documented 128 KiB limit. Kagi stops before sending without a session token. The unused plugin-object translation export was removed. Translation accessories are keyed by account and message, and each message retains setters for all mounted views. Actual React fixtures verify state reset, duplicate-view delivery, and cleanup; Discord stores and parsing remain mocked. Request cancellation, response limits, concurrent result ordering, and live event timing remain open.

## Verification record

Evidence applies to the recorded commit and scope, not to a future merge with main.

| Check | Commit | Result and limits |
| --- | --- | --- |
| Broader performance/correctness suite | `bd695428d` | 476 tests and timezone correctness checks passed, including 423 plugin regressions. |
| Repository-wide ESLint | `bd695428d` | Passed for configured source and config rules. Build output, browser output, vendored types, and test scripts are outside those rules. |
| CSS lint | `c50d116a4` | Passed; excludes userplugins. |
| Internationalization lint | `5e869fea9` | Passed for tracked source markers and patch strings, not live Discord module compatibility. |
| Latest focused regressions and TypeScript | `bd695428d` | Translation provider and accessory lifecycle regressions, full TypeScript, and focused lint passed. Earlier voice lifecycle, preview, and metadata regressions also pass in the broader suite. Source fixtures reject TypeScript syntax diagnostics before execution. |
| Standalone build | `bd695428d` | Passed after the translation changes. Release installer/parser exclusion was verified separately at `1f7dab047`. This does not establish installed-client behavior. |
| Development build | `0fc6ab63b` | Passed after composer, codec, preset, and game-status startup changes. |
| Installer review browser checks | `d7b99b737` | Actual templates and generator functions in isolated Chrome preserved literal metadata, all four native/pre-send warning combinations, the native acknowledgement gate, and cancellation. Electron IPC and real installation were not exercised. |
| Native development filter | `dc2df481a` | Actual development and reporter bundles retain the installer; release bundles exclude it. |
| Web build | `bd695428d` | Passed. Packed Chromium/Firefox manifest versions match `3.0.0.0`. |
| Release artifact audit | `bd695428d` | Passed for `dist`, including ZIP entries. This is a credential-pattern and private-runtime-path check. |
| Avatar startup and edit ordering | `296e36989` | Actual loader, editor actions, and DataStore in isolated Chrome preserved edits in 20 overlapping runs, ten with startup first and ten with saving first. This checks one client context, not synchronization between clients. No extra production guard was added. |
| Avatar edit transactions | `3bf4098d6` | Actual AvatarModal actions and DataStore code in isolated Chrome preserved storage and memory after an aborted write, kept both concurrent user edits, and deleted only the selected override. React rendering and Discord dependencies were mocked. |
| Real IndexedDB queue behavior | `ce04cc40a` | Isolated Chrome verified aborted additions, ordered concurrent additions, aborted clearing, and subsequent successful clearing using actual queue and DataStore code. |
| Clone download cancellation | `1ea9bc2e2` | Actual cloning code in isolated Chromium against a local HTTP server passed stop/logout checks before response headers and during body download. All four cases closed the connection, settled without failure feedback, and made no upload call. Discord stores, upload helpers, and toasts were mocked; already-issued uploads remain unverified. |
| Clone file-read cancellation | `4c491774d` | Actual clone helper with native Chromium Blob and FileReader aborted a pending read once without uploading. A completed read removed its abort listener. Downloads, stores, and uploads were mocked. |
| Clone button keyboard behavior | `38736e4cd` | Actual CloneModal props, shared Button, and stylesheet in isolated Chrome produced 64px controls at a 16px parent font, Tab focus, a focus ring, Enter/Space activation, and no activation while disabled. React and Discord dependencies were mocked; full client layout and uploads were not exercised. |
| Playback rate application | `44d2a1156` | Actual MediaPlaybackSpeed code with Chrome audio/video elements passed 42 valid/invalid rate cases, preserved a 3x first-play selection, and verified one-shot listener and cleanup behavior. Play events were synthetic; no audio or live Discord UI was exercised. |
| Image copy conversion | `41343b959` | Actual WebContextMenus code in isolated Chrome converted a JPEG to a 3 by 2 PNG, preserved red pixels, and closed the source bitmap exactly once. Clipboard delivery was intercepted; OS clipboard permission and live Discord menus were not tested. |
| Translation dismissal keyboard behavior | `7e5ae9a39` | Actual shared TextButton props and shared/plugin CSS in isolated Chrome passed Tab focus, a visible focus ring, Enter and Space activation, and zero form submissions. React dismissal behavior was verified separately with the actual shared component. Browser event handlers were fixture counters; full Discord layout was not exercised. |
| Translation accessory reconciliation | `bd695428d` | Actual plugin rendering and accessory code with isolated React 18.3.1 and its test renderer reset state on message/account changes, unmounted on logout, delivered to two views of one message, and preserved the remaining view after cleanup. Discord stores used a controlled external-store bridge; parsing and icons were mocked. No live Discord client or provider was exercised. |
| Native translation redirects | `638d668e6` | Actual native handlers with Node fetch rejected local 301, 302, 303, 307, and 308 redirects. Ten valid initial requests reached the server; none reached the redirect destination. Failure responses contained no exception details. Credentials and text were synthetic; remote provider compatibility and Electron IPC were not exercised. |
| Transcription model response transfer | `28bf744a0` | Actual worker wrapper with native Node fetch decoded a local 66-byte gzip response into 2,030 bytes. Download and cache-hit responses reported the decoded size and preserved every byte; native structured-clone transfers detached both sending buffers. Worker delivery and persistent storage were represented by a transfer sink and cloned in-memory cache. Remote models, IndexedDB, and Electron were not exercised. |
| Transcription audio decoding | `d7c9fcdf9` | Actual decoder in isolated Chrome passed mono/stereo WAV cases at 16 kHz and 48 kHz, producing 16,000 samples per second and the expected channel average. All five native AudioContexts reached closed state, including invalid-input failure. Audio was synthetic; Electron integration, long-file memory limits, and transcription models were not exercised. |
| Video preview decoding | `fd216ca34` | Actual preview code in isolated Chrome produced a PNG from an FFmpeg-generated WebM and returned null for invalid video. |
| Theme replacement on the filesystem | `07903f31c` | Actual native code preserves installed files after injected partial writes and rename failures, and cleans temporary files. This is not crash-durability testing. |
| Theme provider download | `9b03d446d` | The actual native handler downloaded catalog entry 91 with HTTP 200 and no redirect into an isolated directory. All 136 catalog entries were separately checked against ID, filename, and catalog-content size rules. |
| HTTP archive replacement | `0ea68f8c4` | Actual updater code on Windows preserved old ASAR bytes and readable contents after injected partial-write and rename failures. Retrying installed the complete new archive and removed temporary output. Electron original-fs was represented by Node fs; live Electron locks and crash durability were not tested. |
| Extension archive extraction | `e33811df0` | Actual extraction code, fflate ZIP decoding, and the Windows filesystem preserved nested files/directories, skipped metadata, rejected three traversal/absolute paths, removed partial output, and preserved an outside sentinel. Electron loading, archive resource limits, and crash durability were not tested. |
| Uninstall button browser checks | `d4efc449d` | Actual shared component props and styles in isolated Chrome verified the accessible name, keyboard focus indicator, and consistent 32px sizing in both stylesheet orders. Full Discord layout was not exercised. |
| Other isolated browser checks | Earlier audit commits | Specific sticker-storage transactions, codec conversion, and CSS behavior were exercised. These are not general live-client acceptance. |

Mocked Discord requests do not establish live account-switch, message-send, or plugin-patch compatibility. No real Discord messages were sent by these regression fixtures. At `bd695428d`, GitHub reported an empty check rollup for the open draft PR, no auto-merge request, and conflicts with main. Current-head CI success has not been established.

## Remaining work

The full finding ledger is still being worked through. This list identifies major open areas and is not an assertion that other findings are closed:

- Scheduled-message recovery controls, remaining persisted-data constraints, modal lifetime handling, media cancellation, and coordination between separate client contexts.
- Remaining plugin account, cancellation, network-response, storage, and resource-lifecycle findings across the broader codebase.
- Runtime validation of patch anchors. The current patch validator reports 192 warnings; those warnings have not all been resolved or justified against current Discord modules.
- Native and provider behavior that mocked tests cannot establish, including target-platform installer and live-client acceptance.
- Integration of separately reviewed main changes, preservation of main's release history, and final checks against the combined source.
- A final finding-by-finding disposition, current-head CI, and final audit report before removing draft status.

The audit must not be described as a clean-codebase or release-readiness certification while these items remain unresolved.
