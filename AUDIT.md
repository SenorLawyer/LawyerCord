# Project audit working report

This audit is still in progress. File coverage records review work; it does not establish that every finding is resolved or that the client is ready to release.

## Scope and source

- Baseline: `6e664e03ba3d0b7746ce34740ca444f5112b04bc`, published as `nightly-20260905-1918-6e664e03`.
- The baseline inventory contains 1,661 tracked files, including source, tests, configuration, documentation, and assets. The review ledger records all baseline entries as reviewed.
- At `f77ae311a`, the branch contains 1,655 tracked files: five added test files and eleven removals relative to the baseline. This report is an additional file.
- The five added tests cover startup flags, CRX conversion, extension installation, file selection, and settings synchronization. Their file hashes were rechecked against the reviewed versions at `d93c2e1ac`.
- The generated internationalization mapping was checked semantically against the runtime hash function across 19,440 pairs. That is generated-data validation, not manual review of each pair.
- Main at `8fc182ba7` was reviewed separately. Its changes have not been integrated into this branch.

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

StatusWhileActive binds saved status to its account, discards it on logout, initializes from the current call when enabled, and preserves manual status changes when leaving or stopping. The unrelated channel-status text event handler was deleted. Mocked lifecycle regressions cover these changes. Repeated in-call voice events can still override manual presence; live event ordering remains unverified.

## Verification record

Evidence applies to the recorded commit and scope, not to a future merge with main.

| Check | Commit | Result and limits |
| --- | --- | --- |
| Broader performance/correctness suite | `538340940` | 381 tests and timezone correctness checks passed. |
| Repository-wide ESLint | `e54c36833` | Passed for configured source and config rules. Build output, browser output, vendored types, and test scripts are outside those rules. |
| CSS lint | `c50d116a4` | Passed; excludes userplugins. |
| Internationalization lint | `5e869fea9` | Passed for tracked source markers and patch strings, not live Discord module compatibility. |
| Latest plugin regressions and TypeScript | `7bdd25a3c`, `538340940` | 329 plugin tests passed before the channel-status handler deletion. The expanded status regression, full TypeScript, and focused lint passed after deletion. The broader suite above includes all plugin regressions at the newer commit. |
| Standalone build | `e54c36833` | Passed after narrator and VoiceStats changes. Release installer/parser exclusion was verified separately at `1f7dab047`. This does not establish installed-client behavior. |
| Development build | `538340940` | Passed after pronoun and status lifecycle changes. |
| Installer review browser checks | `d7b99b737` | Actual templates and generator functions in isolated Chrome preserved literal metadata, all four native/pre-send warning combinations, the native acknowledgement gate, and cancellation. Electron IPC and real installation were not exercised. |
| Native development filter | `dc2df481a` | Actual development and reporter bundles retain the installer; release bundles exclude it. |
| Web build | `b87aa473b` | Passed. Packed Chromium/Firefox manifest versions match `3.0.0.0`. |
| Release artifact audit | `b87aa473b` | Passed for `dist`, including ZIP entries. This is a credential-pattern and private-runtime-path check. |
| Real IndexedDB queue behavior | `ce04cc40a` | Isolated Chrome verified aborted additions, ordered concurrent additions, aborted clearing, and subsequent successful clearing using actual queue and DataStore code. |
| Video preview decoding | `fd216ca34` | Actual preview code in isolated Chrome produced a PNG from an FFmpeg-generated WebM and returned null for invalid video. |
| Theme replacement on the filesystem | `07903f31c` | Actual native code preserves installed files after injected partial writes and rename failures, and cleans temporary files. This is not crash-durability testing. |
| Theme provider download | `9b03d446d` | The actual native handler downloaded catalog entry 91 with HTTP 200 and no redirect into an isolated directory. All 136 catalog entries were separately checked against ID, filename, and catalog-content size rules. |
| Uninstall button browser checks | `d4efc449d` | Actual shared component props and styles in isolated Chrome verified the accessible name, keyboard focus indicator, and consistent 32px sizing in both stylesheet orders. Full Discord layout was not exercised. |
| Other isolated browser checks | Earlier audit commits | Specific sticker-storage transactions, codec conversion, and CSS behavior were exercised. These are not general live-client acceptance. |

Mocked Discord requests do not establish live account-switch, message-send, or plugin-patch compatibility. No real Discord messages were sent by these regression fixtures. At `538340940`, GitHub reported an empty check rollup for the open draft PR, no auto-merge request, and conflicts with main. Current-head CI success has not been established.

## Remaining work

The full finding ledger is still being worked through. This list identifies major open areas and is not an assertion that other findings are closed:

- Scheduled-message recovery controls, remaining persisted-data constraints, modal lifetime handling, media cancellation, and coordination between separate client contexts.
- Remaining plugin account, cancellation, network-response, storage, and resource-lifecycle findings across the broader codebase.
- Runtime validation of patch anchors. The current patch validator reports 192 warnings; those warnings have not all been resolved or justified against current Discord modules.
- Native and provider behavior that mocked tests cannot establish, including target-platform installer and live-client acceptance.
- Integration of separately reviewed main changes, preservation of main's release history, and final checks against the combined source.
- A final finding-by-finding disposition, current-head CI, and final audit report before removing draft status.

The audit must not be described as a clean-codebase or release-readiness certification while these items remain unresolved.
