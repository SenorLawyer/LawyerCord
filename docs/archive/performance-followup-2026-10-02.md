# Performance audit follow-up

This Nightly continues the whole-project audit merged in PR #53, starting from `f4b27c59d`. Version `3.1.3.0` is a performance and correctness patch. Stable remains `3.0.1.0`.

The inherited [audit](stable-audit-2026-10-01.md) and [coverage ledger](stable-audit-coverage.tsv) cover 1,657 paths at the original Stable baseline. Their fingerprints and conclusions describe that baseline. This follow-up reviews the remaining high-cost paths and the resulting changes against the merged tree; it does not claim a second independent reading of every baseline line or that every possible defect is eliminated. Three GPT-6 Astra agents at medium reasoning implemented separate automation, media and renderer/logger changes, with parent review and integration checks.

## Regression history

The LawyerCord commit immediately before `v1.16.0.0` is `79dba8496`, with package version `1.15.0.0`. The `v1.16.0.0` commit is `eb3118ac6`. Some similarly named 1.15 tags describe upstream history and are unsuitable as the comparison point.

ActivityHeatmap was introduced in 1.16. Its persisted buckets grew indefinitely and its intensity calculation expanded the entire history into `Math.max`. Storage now retains the displayed 28 days, rendering reads at most 672 bucket values, and opening the modal flushes pending messages before rendering. This removes a demonstrated growing cost; it does not establish when or whether that cost caused the reported FPS regression.

Automations arrived later, in `b25ed68a8` (PR #45). Run metadata invalidated cached definitions, and persistence rewrote unrelated records. Those costs are fixed here. Name formatting, Shiki and MessageLoggerEnhanced have no source difference between the actual pre-1.16 commit and the 1.16 tag, so they do not independently explain that onset. Current costly behavior still warrants fixing.

## Changes and evidence

| Area | Result | Verification |
| --- | --- | --- |
| Automations | Reuse unchanged definitions and compilation, persist dirty keys, index trigger work, cancel account-owned runs, release obsolete cooldown records, serialize native polling. | Actual runtime tests check repeated runs without repeated clones/compilation/validation, storage writes and account changes. |
| Automation regex | One reusable worker evaluates patterns with cancellation, a one-second execution deadline, bounded jobs and a four-million-character aggregate input budget. Regex failures reach run logs. Ordinary value blocks retain synchronous execution. | A real worker runs a catastrophic pattern while a main-thread heartbeat continues, then accepts queued safe work. Integration tests execute regex workflow blocks and triggers. |
| GIFs | Quantization and encoding move to a worker. Decode/compositing work has dimension, frame and source/output pixel budgets. Consecutive restore-to-previous disposal frames preserve their proper snapshots. | Real worker encoding matches the existing algorithm byte for byte. Tests cover buffer transfer, cancellation, deadline, malformed/oversized media and disposal behavior. |
| Uploads | Validate request boundaries, cap streamed responses and concurrent native requests, preserve sender/account ownership, cancel during preparation and clean up workers/readers. Authorization does not cross origins on redirects. | Native and renderer tests cover cancellation, ownership, redirects, size limits and provider failures. |
| Names and Shiki | Defer hover-only name construction, reuse language/theme/startup work, restore plugin-owned wrappers and terminate failed or stopped worker sessions. | Tests cover render allocations, hover output, rapid theme changes, startup failure/retry, post-start deadlines and stop/restart. |
| Logger | Hydrate only displayed matching records, bound transient caches, coalesce cleanup, reject stale reads, defer attachment scans and cancel pending files/downloads. Exports replace the destination only after successful completion. | IndexedDB/query tests and real-filesystem tests cover preservation, UTF-8 chunks, sender ownership, failure, cancellation and cleanup. |
| Shared state | Atomic changelog updates prevent lost history. Intersection callbacks reject disconnected observers and immediately reset visibility for replacement elements. Partial command registration rolls back without removing another plugin's commands. | Concurrent updates and observer/lifecycle regressions execute the affected source. |
| Presence and audio | Superseded osu presence lookups cannot overwrite a newer activity, and pending cover requests stop with the service. Audio and transcription work own their resources and cancellation. | Lifecycle, worker and native fixtures exercise obsolete completions, cleanup and work limits. |
| ServerInfo | Enumerate guilds once per selection, build at most three mutual-server icons per displayed member, and derive current members from stores. | A fixture with two displayed members and 100 mutual guilds reduces icon construction from 300 calls to six while keeping the exact counts. Same-size member replacements and separate modal requests are covered. |
| Animated stickers | FakeNitro reuses the disposable FFmpeg worker instead of decoding and quantizing every frame on the renderer. The shared queue retains at most three jobs and 100 MiB of compressed input. | A real installed FFmpeg executes the production filter chain on a valid APNG fixture: square dimensions, transparent padding, restore-to-previous pixels and exact 100/200/300 ms delays pass. Lifecycle fixtures cover stop/account change and visible failure. |
| Image magnifier | Coalesce raw pointer events into one animation frame and reuse its measured rectangle in rendering. | A burst of 100 moves drops from 200 synchronous rectangle reads before rendering to one total read and one position update, preserving the final pointer. Release, unmount and instance replacement cancel pending work. |

The isolated nonregex runtime benchmark processes 30,000 local blocks at a median of **72.39 ms before** and **58.83 ms after**, using seven measured samples following warmup in the same environment. This is a local throughput measurement, not a Discord FPS measurement. The GIF worker proof also checks main-thread progress during a substantial real encode; it does not claim a faster encoder algorithm.

## Compatibility and limits

- Ordinary workflows and encoded GIF output are preserved. Regex operations now explicitly reject patterns or input exceeding their documented bounds, or execution exceeding one second. Restrictive standalone/userscript CSP can prohibit Blob workers; these clients report the failure instead of running the pattern on the renderer.
- Browser image/audio decoding cannot be interrupted once submitted to the platform decoder. Input/output bounds and ownership checks prevent subsequent obsolete work, but they do not turn that decoder into a cancellable operation.
- FakeNitro's GIF bytes, palette selection and scaling interpolation can differ under FFmpeg. Timing, compositing, dimensions and padding have a real codec proof; installed native FFmpeg does not establish identical browser WASM execution. The GIF Maker worker separately retains byte-identical output.
- Speech-model responses are capped at 2 GiB each. The existing disk cache across model variants is still user-cleared; that cap does not establish a total cache or decoder memory budget.
- PluginManager retains its synchronous lifecycle API. Async start/stop rejection is logged; callbacks are not serialized across plugin transitions.
- Existing logger storage and attachment cache account-sharing semantics are retained. A submitted filesystem rename or IndexedDB write cannot be rolled back by later cancellation.
- Discord patch anchors, rendering, GPU behavior and frame rates require the affected client. No live client installation, messaging, publication or source-only proof establishes that the reported device regression is fully resolved.

## Validation

Final local performance validation passes **1,068 tests with no failures or skips**, including the opt-in real FFmpeg proof. The full automation suite and timezone correctness check pass. TypeScript, source/style/intl/patch lint, desktop and browser builds, dependency and packaged credential audits, installer repair and eleven other focused CI checks pass. GitHub CI is reported on the pull request. New tests are registered explicitly; the live secure-messaging test is not part of this audit run. CI does not install native FFmpeg, so its optional native-codec proof is skipped there; the ordinary conversion and lifecycle fixtures still run.

For the Nightly client test, compare scrolling and channel switching with the same enabled plugins; exercise codeblocks and name hover, ordinary/regex automations, GIF creation, audio/transcription, and logger browsing plus cancelled exports. Record enabled plugins and a renderer profile if lag remains. Stable promotion should follow this device test.
