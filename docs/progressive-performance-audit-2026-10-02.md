# Progressive performance audit

Candidate version: 3.1.4.0, Nightly. Baseline: `52c4d09feb29036cccddf53ba8fe96ce40148bbc`. Branch: `perf/progressive-fps`.

The reported problem is low FPS that worsens during a long Discord session with approximately 110 enabled plugins. This pass addresses demonstrated repeated work, retained resources and stale asynchronous ownership across core APIs, settings, automation, upstream plugins and Equicord plugins. It continues the earlier whole-project audit and 3.1.3.0 performance work.

## Coverage and evidence

The baseline inventory contains 1,747 tracked files, including 1,427 paths under `src/`. The [coverage ledger](progressive-performance-coverage-2026-10-02.tsv) records baseline Git-blob and candidate Git-blob SHA-256 values, the original checkout bytes supplied to reviewers, review disposition and notes for each baseline path, plus the 42 new regression scripts. Separate checkout hashes account for Windows line endings and resolved symbolic links without changing the committed artifact hashes. AGENTS.md, CLAUDE.md and GEMINI.md are instruction links to `.rules`; their Git hashes cover the link text while their review-input hashes cover the target contents. Every runtime source path has a completed fresh source/resource disposition. There are no pending runtime review assignments.

Review partitions were Equicord A through M (441 paths), Equicord N through Z (304), upstream plugins (422), and core/support (580). GPT-6 Astra agents at medium reasoning reviewed separate partitions, implemented scoped fixes and independently reviewed the integrated changes. Root reviewed shared core changes, integrated tests and release metadata.

Coverage distinguishes full source reads from stylesheet resource review, static-data classification, test parsing and inherited supporting-artifact review. Two hundred unchanged supporting files match the previous whole-project audit byte for byte; their prior review is carried forward explicitly. Ninety-five existing supporting test sources were parsed in full, with changed assertions reviewed and execution recorded separately. Historical audit documents are references, not newly repeated manual reviews. Icons executable JSX was read; static SVG geometry was parsed and classified, without a new visual appearance review. These classifications are not interchangeable with live runtime proof or a security certification.

Regression tests execute the changed source with controlled stores, timers, requests, React lifecycle fixtures or native IPC/crypto. The deterministic counts below compare the reproduced old behavior with the candidate. They do not measure Discord FPS.

## Shared core and automation

| Path | Reproduced work | Candidate behavior |
| --- | --- | --- |
| SettingsStore | 90,001 proxies for 30,000 repeated reads through three nested paths | Four proxies between mutations; notification paths, aliases, array edits and root replacement preserved |
| Notifications | 500 retained pending notices | Latest 100 queued entries while preserving the displayed permanent notice |
| CSP reports | 10,000 duplicate insertions and unlimited distinct reports | Duplicate exit and latest 256 distinct reports |
| Cloud backup/export | All IndexedDB values hydrated, including downloaded speech models | Keys filtered before value reads in the same readonly transaction; full local backup remains complete |
| Message popover | Factories could add hooks to the parent's render as enabled plugins changed | Each factory runs in its own keyed React component and error boundary |
| Plugin author modal | 100 failed opens registered 100 synthetic users | Stable synthetic author identity per static author record |
| ZIP compression | Canceled queued work waited behind a stalled compressor | One active job, four queued jobs, immediate removal and settlement of queued cancellation |
| Automation editor | 100 pointer events produced 98 workflow copies and 196 coordinate reads | One frame update and two coordinate reads; final release coordinates preserved |
| Automation model requests | 100 concurrent forced refreshes | One shared pending request, followed by a fresh refresh after settlement |
| Automation snapshots | Editing mutated earlier snapshots | Immutable array replacement, preserving previous render snapshots |
| Native Codex scan | A short header required reading a 4 MiB history | Header completion ends reads within the first 4,096-byte block; long UTF-8 headers retain the original limit |

Settings proxies remain stable only until mutation, including explicit plain-data change notification. Weak ownership avoids retaining obsolete roots. A local repeated-read benchmark improved by roughly 22%, but concurrent machine load and the synthetic workload prevent translating that number into an FPS claim.

The automation runtime retains the earlier bounded worker, compiled-definition reuse, queue cancellation and account ownership design. This pass fixes editor and request costs without changing the stored workflow format. A new query dependency or replacement of Discord's stores would duplicate existing ownership; it was not justified by the reproduced failures.

## Session growth and rendering

| Subsystem | Reproduced work | Candidate behavior |
| --- | --- | --- |
| MusicControls lyrics | 1,000 same-track events read persistent history and emitted 1,000 times | One read/emission until the track or relevant revision changes |
| BetterAudioPlayer | 100 paused mounts downloaded audio and created contexts | No download/context until first play; four physical requests, 12 resolved entries and 24 MiB cache |
| Audio download size | Missing-length stream buffered 140 MiB before rejection | Stream stopped at the existing size limit rather than fully buffered |
| VoiceChannelLog | Unlimited events and snapshots of 20,000 unrelated participants | Relevant participants only; 1,000 events/channel by default, configurable to 5,000, 10,000 total events and 50 channels |
| ChannelTabs | 5,000 revisits accumulated duplicate history | Unique MRU entries; latest 100 reopen records; all close paths release removed tab state |
| SongSpotlight | 5,001 remote profile records retained | 200 recent remote updates while preserving the signed-in account's editable songs |
| Timezones | 1,000 formatters to discover the same system timezone | One system discovery per minute, with refresh after timezone changes |
| PlatformIndicators | 100 self indicators caused 99 redundant invalidations | No redundant PresenceStore writes; actual status changes still notify |
| SupportHelper | 10,000 ordinary message renders read support-server roles | No support-role reads outside the support surface |
| ValidUser | Queue eviction retained 94 dropped IDs | No dropped IDs retained; evicted lookups can retry |
| Speech model settings | Bulk hydration of models and unrelated values | Model keys first, sequential value reads, stop after unmount |

MessageTranslate histories retain at most 1,000 entries. Navidrome lookups retain 200 tracks. Message-link previews retain the existing 200-result cache and now bound waiting work to 100 entries. Secure attachment success and failure entries both follow the existing 128-entry cache limit. These bounds deliberately evict older transient history or derived results; voice-log retention is configurable. They do not delete persistent user message logs, saved workflows, downloaded speech models or lyric history.

HideChatButtons now calls the same hooks when its visible button list is empty. IRememberYou no longer clears dirty ownership before an awaited save can finish. GifCollections batches expired URL refreshes into one persistence/index update while preserving concurrent edits. GifMaker loads the catalog on demand and removes loaded FontFaces and blob URLs when its last editor closes. Song preview unmount releases playback and global references; refreshed retained nodes preserve loaded/playback state.

## Asynchronous ownership and admission

Streak updates coalesce per peer and operation, with a 30-second deadline through JSON body consumption. The regression includes an actual localhost HTTP body stalled after headers, then verifies cancellation and a second successful admission without relying on wall-clock scheduling. Music presence polls keep one pending job and pass cancellation through external metadata requests. RichPresence services, GitHub profile views, translation, Quoter and theme metadata requests abort obsolete work and reject late publication.

FavoriteEmojiFirst, RecentDMSwitcher and InstantScreenshare cannot finish stopped startup or install listeners/start sharing late. SilentTyping keeps one expiry timer per channel and releases all on stop or account lifecycle events. HideMedia, ValidReply, MemberCount and Decor suppress previous-session completions and queued work. Theme batch/per-link refreshes abort on replacement or navigation and cannot restore deleted metadata.

ZIP preview admits two active archive loads. Native loads remain counted until IPC settles; browser rejections wait for body cancellation before releasing capacity. Native Discord MCP admits four attachment downloads with a 120-second deadline, cancels readers and releases their locks before admission ends, and avoids redundant per-chunk Buffer copies. Overload produces explicit retry feedback rather than starting unlimited downloads.

SecureMessaging admits two native attachment bundles before vault authentication. Each bundle owns a 60-second deadline. A failed sibling aborts the other downloads, and all download/decrypt operations settle before releasing capacity. Rejected primary responses and redirects cancel their bodies before proxy fallback. Partial plaintext and ciphertext buffers are wiped on failure. Capture disable/re-enable cannot publish an obsolete bundle. Account logout/reconnect clears decrypted attachment/embed URLs; stale account results are wiped before URL creation, including A to B to A replacement. Native code revalidates the renderer origin/frame before returning plaintext, while renderer account lifecycle owns Discord account identity. An overload can be retried through the existing message updater and button.

Independent review caught and fixed stale 304 responses overwriting newer SongSpotlight data, audio ref replacement losing loaded state/playback, unsupported cancellation helpers in changed renderer paths, and secure response-body cleanup bypassing admission limits. Tests cover each finding. Compatibility tests for changed paths remove `throwIfAborted`, newer static AbortSignal helpers and the `reason` property where relevant; this is not an app-wide certification for every old Chromium feature.

## Verification

The final local `pnpm testPerformance` run passed 1,163 tests with zero failures, cancellations or skips, with real FFmpeg fixtures enabled. Its timezone correctness benchmark also passed: a 100-message batch creates 16 formatters, and a repeated batch creates zero; the exact one-minute system refresh boundary is tested.

The full automation suite, secure protocol/native IPC suites, 49 settings sync tests and all remaining focused CI commands passed. TypeScript, source/style/intl/patch lint, desktop/browser standalone builds, dependency audit and release-artifact scanning passed. Installer persistence tests ran the generated Go fixture and passed. Source lint excluded only the ignored local `.modules` directory containing the downloaded Go runtime; clean CI runs the ordinary lint command. No dependency was added and the lockfile is unchanged. GitHub Linux/Windows CI and the release workflow provide the final merged-commit packaging checks.

## Remaining limits and test guidance

No live renderer CPU, heap or frame profile was available. The installed archive inspected during this work identifies the earlier Stable commit `428784b`; it does not establish which code the active renderer has loaded. The candidate was not installed into or tested interactively in the user's running Discord session. Actual FPS recovery, long-session heap stability, Discord patch matching and real-client behavior remain verification tasks for the Nightly.

Try the published Nightly with the usual plugin set, confirm the displayed version, compare a fresh session with an extended session, and exercise channel/tab navigation, media playback, settings, theme switching and automation editing/runs. A renderer CPU/heap recording from a degraded session would identify remaining dominant costs. No user IDs, tokens, local configuration or private runtime logs are included in the published coverage.

Source review also identified candidates without a completed progressive-retention reproduction. They remain explicitly unresolved: synchronous user regex in BlockKeywords, HopOn, KeywordNotify and TextReplace; large sticker-picker/filter work; user-controlled lyric/model/media persistence; some action-triggered image/profile operations that lack full stop ownership; explicit native logger download concurrency; delayed overlay/window launches; and large modal/CSS effects that need actual profiling. Automation UI still renders all bounded graph nodes, and operations without cancellation support may physically outlive logical cancellation. Migrating synchronous message-filter contracts or all UI data to a worker/query layer requires evidence and a separate behavior design. No blanket claim that every possible defect or the original live FPS cause has been resolved is made.
