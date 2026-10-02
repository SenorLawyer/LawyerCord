# Plugin settings and session performance audit

Candidate: 4.0.0.0 Nightly. Baseline: `53260d5900b155a60e89a3fbb89489df6a37cc66`. This continues the earlier whole-project and progressive-performance audits, with fresh review of the reported plugin-settings and voice-recorder opening failures, the post-1.16 history, plugin workloads, and automation ownership.

The reported long-session FPS collapse has not been reproduced in a live Discord renderer. Source tests demonstrate the defects below; their counts are work and resource measurements, not FPS. The user's running desktop client has no available renderer debugging endpoint. Its installation was not changed or restarted. Local enabled flags guided prioritization without publishing private configuration, workflows or message data.

## Reproduced failures and changes

| Area | Before | Candidate |
| --- | --- | --- |
| Shared modal discovery | Named Modal and ConfirmModal barrels absent on cold load despite loaded implementations | Find the exported implementation by component code; opening fixtures resolve the actual captured Discord factories |
| Plugin authors | Rendering a loading placeholder dispatched USER_UPDATE | No store dispatch during rendering |
| Plugin catalog | Constructed 362 cards before slicing, then grew its mounted list | Construct 36 cards per page; optional and required sections each stay bounded |
| Catalog subscriptions | Background plugin setting changes invalidated the entire screen | Subscribe to enable flags and imported parent objects |
| Settings proxies | 33,100 allocations across 100 mutations with 110 plugin settings objects | At most 200 new proxies; unchanged siblings retain identity |
| Settings ownership | Candidate strong ancestor references and local alias caches retained deleted objects | Weak ancestor lineage, bounded path metadata and removal of obsolete property bindings; real GC regression checks collection |
| Desktop settings persistence | 100 synchronous mutations sent 100 complete settings payloads and performed 100 disk writes | Two payloads and writes, first and latest; failed writes retain dirty paths, reload rejects old document writes, and explicit sync rejects concurrent local edits |
| MessageLogger edit history | 5,050 diff calculations while adding 100 edits | 100 calculations; earlier mounted edit diffs are reused |
| Shiki fallback highlighting | Highlighted 100 hidden codeblocks | Zero hidden highlights; first visible block still highlights |
| Automation admission | An old request could enter a replacement account session after awaiting state load | Capture cancellation ownership before yielding |
| Automation cooldown | queueLimit 2 retained 20 queued triggers while no previous run was active | Retain two; cancellation and fresh runs still work |
| Native Codex scans | 100 concurrent consumers enumerated two directories each | One shared pair of reads; later and additional-source requests refresh |
| Automation native programs | Stopping a run discarded renderer results while the child continued | Sender-owned request cancellation and physical admission until child close |
| Automation AI | Renderer destruction left requests running until their deadline | Abort on renderer destruction or crash; release listeners and admission after settlement |
| SongLink | 100 duplicate lookups started 100 native requests with no deadline | One shared request; eight distinct requests, 30-second deadline and 1 MiB response limit |
| MusicControls translation | 100 unique lines started 100 simultaneous requests | Four translation workers; shared eight-request admission, deadline, body limit and stop ownership |
| Saved lyrics | 100 reads cloned a 1,000-track history 100 times | Zero legacy reads after atomic migration, including restart; per-track values preserve saved translations |
| Voice playback preparation | 20 missing-waveform mounts started 20 downloads and decodes | Three pending preparations, one active, same-URL deduplication and immediate queued cancellation |
| Moyai | Bursts accumulated pending loops and audio elements | Four burst/audio slots; stop releases media and rejects old continuations |
| SecureMessaging render callbacks | 1,000 repeated renders retained 3,000 equivalent callbacks | One callback per live owner, with correct forceUpdate receiver |
| SecureMessaging native queue | A stalled vault lock admitted all 512 operations | Admit 256; excess work returns a retryable busy response |
| SecureMessaging previews | 200 mounts started 200 pending decryptions; clearing could admit more unfurls while previous requests remained | At most 32 pending embed decryptions, 16 attachment preparations and 128 unfurls; reservations remain until settlement |
| ChannelTabs navigation | Old startup hydration could navigate after unmount; rapid navigation accumulated restoration callbacks | Invalidate old hydration, replace pending restoration and cancel it on unmount |
| RobloxActivity | 1,000 unrelated presence events caused 1,000 process checks | No process checks for unrelated users |

New-plugin acknowledgments now save only after Continue, Restart or Don't show this again. Closing or failing to render preserves unread changes, concurrent opens are rejected, and legacy migration retains newly added plugins. The modal constructs only one page of cards.

Discord MCP stops subsequent sends, deletions, page requests and stale successful responses when its session changes. FileUpload checks cancellation before creating a public WebDAV share. VoiceJoinMessages and collapsed song previews ignore old completions. Remix removes crop listeners before canvas cleanup and releases the selected tool on editor unmount. QuickCSS initial loading preserves a newer change event and disabled state.

## Catalog and storage compatibility

Status, source, tags, new plugins, settings and expected impact filters combine. Sorting supports name, new plugins and lowest expected impact. Discord inputs, selectors, buttons and theme variables remain in use. All 402 source plugin entries carry a qualitative `performance` impact and a source explanation; all 380 entries emitted by the public metadata generator include it. User plugins without metadata say Not reviewed. These categories describe work while a feature is used, not a measured benchmark score or a promise about a particular machine.

The major version covers per-track lyric storage. Existing history imports atomically with a completion marker; explicit history deletion clears both formats. Older builds retain their old saved entries but cannot see tracks or translations newly stored by this release after a downgrade. The native program cancellation protocol ships with the matching renderer in one release artifact.

Desktop settings batching is enabled only when the native bridge exposes synchronous unload persistence. Document sessions and revisions prevent an old pending write from replacing the final unload snapshot or a newly loaded document. Explicit imports and cloud sync wait for ordinary saves and reject concurrent edits. External hosts without the capability retain immediate persistence. Browser persistence remains immediate.

## Review coverage and history

The previous [full coverage ledger](progressive-performance-coverage-2026-10-02.tsv) remains the source for earlier full reads and hashes. The [current coverage ledger](plugin-settings-review-coverage-2026-10-03.tsv) distinguishes fresh full reads, current section review, inherited reads, resources and test support. This pass adds fresh Equicord entry/helper review, shared API and utility review, webpack discovery review, main-process and settings review, and complete current automation renderer/native source review. Upstream plugin metadata review reconciles prior full helper reads with current runtime sections; changed helper implementations are reread. Inherited reads are not described as newly repeated full reads.

The [history ledger](post-1.16-history-review-2026-10-03.json) records all 25 first-parent commits and changed paths from `v1.16.0.0` (`eb3118ac61ef213ca9cb09f5844c3ca040e2dac6`) through this baseline. Fourteen historical diffs were read in full, two had complete runtime diff review, and nine have explicit selective review. Large bulk audit PRs have selective historical review; their current runtime paths are covered by source partitions. No claim is made that every line of every historical bulk diff was reread. Automation startup was also executed at seven historical revisions: the disabled engine creates zero subscriptions, recurring timers or writes. A deliberately removed disabled guard fails the control. This does not establish whether the user's persisted engine is disabled.

RobloxActivity's unfiltered presence checks were introduced in PR 41, removed in PR 52 and restored in PR 53. The local plugin is disabled, so that finding does not explain the user's active session. MusicControls is enabled but local lyric flags are disabled, and local MessageLogger edit-diff display is disabled. Those fixes are valid general defects without evidence that they caused this particular FPS collapse. SongLink, Discord MCP and the shared settings paths are active locally, but still require renderer profiling for causal attribution.

## Validation and limits

Modal discovery uses captured public Discord component factories from `https://discord.com/assets/web.24a0dd4254453b09.js`, captured on 2026-10-02. The main bundle SHA-256 is `d141f126a87e0e4c49898f95c71b467641fe7e26022da5abcec663c104f3afcb`. Modal module 189213 exports `a`; ConfirmModal module 732159 exports `u`. Their named barrels are loaded through other chunks. Regressions execute the actual finder/filter source against those factories. The desktop and web voice-opening fixtures invoke no microphone, codec, native download or Discord network request. These are ABI and opening-path checks, not live screenshot proof across every Discord build.

The settings microbenchmark measured a mixed 110-plugin read/write workload at approximately 389 ms before and 179 ms after. Unchanged reads measured 203 ms before and 216 ms after. These local medians are affected by concurrent machine load; the allocation and identity assertions are stronger evidence than the elapsed times. Real GC tests include collected controls and a surviving live store, and demonstrated failure against both strong ancestor retention and unbounded transient alias caches.

The sealed local candidate passed all 1,244 performance tests with actual FFmpeg and no skips, followed by the timezone formatter check. The full automation suite, settings-sync suite, SecureMessaging cryptographic/protocol and native IPC suites, TypeScript, full source ESLint, CSS, intl and patch lint passed. Desktop, Vesktop, Equibop, web, userscript and extension builds passed, as did generated metadata validation, the moderate-level dependency audit and packaged credential/private-data audit. CI additionally checks Linux and Windows installer packaging before merge.

Already submitted Discord or external actions cannot be undone by cancelling their later completion. Native program cancellation targets its directly spawned child; independently launched descendants are outside that contract. One active voice preparation can finish under its existing 120-second native deadline, retaining admission until it settles. In-flight SecureMessaging Discord unfurls cannot be physically cancelled through RestAPI; their slots remain reserved until settlement and obsolete retries stop. None of these source checks proves live FPS recovery.
