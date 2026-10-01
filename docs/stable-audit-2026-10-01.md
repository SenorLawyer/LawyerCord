# Stable codebase audit

Baseline: `v3.0.1.0`, commit `428784bba91586ece25778f143c0e806155ee452`.

Status: in progress. The user requested a review of every file and line, with justified deletions, simplifications and performance improvements, followed by a Nightly pull request. The final tree returns to this Stable baseline rather than retaining the two subsequent Nightly changesets. Release history remains intact.

The baseline contains 1,657 tracked files and approximately 287,000 lines. This includes generated data, declaration packages, tests, licenses and documentation. The local inventory records each path and source fingerprint. Automated scans and earlier audit records are evidence, not substitutes for a fresh semantic review.

## Baseline checks

- The existing performance suite passes all 701 tests and the timezone correctness check.
- The dependency audit reports 14 advisories in fast-uri, brace-expansion, moment and DOMPurify.
- TypeScript's unused declaration diagnostics identify candidates for inspection. Unused positional arguments and React subscriptions must not be removed blindly.

## Decisions

- Keep settings proxies uncached. Stable object identity can conceal in-place mutations from React dependencies. Reducing allocations alone does not justify changing that contract.
- Keep atomic storage operations, checksum validation, account ownership and cancellation protections. Their complexity follows real failure cases.
- Restore Stable through a merge that acknowledges later main history while retaining the Stable tree. This makes the requested rollback explicit in the final PR and preserves immutable release tags.

## Verified changes

- Dependency updates pass the audit at the low severity threshold with no known advisories. TypeScript passes.
- Two lifecycle regressions fail against Stable and pass after the manager fix. The focused suite passes all seven tests. Duplicate starts now stop before registration; stop failures still log and release manager-owned commands, hooks, renderers and Flux callbacks. Plugin-owned cleanup failures remain reported failures.
- Remove the obsolete Encryptcord message suppression. No bundled plugin uses that name.
- Server list boundaries retain their registration keys when neighboring components are removed, added or reordered. The regression fails against Stable and all three focused badge/server-list tests pass with the fix.
- Delete the permanently disabled CSS-debugging chunk path, unused script imports and an unreachable QR video preview. Existing QR callers provide images or null.
- Delete IndexedDB cursor fallbacks. The browser manifests require Chrome 91/111 and Firefox 128, all of which provide `getAll` and `getAllKeys`. Seven focused DataStore tests pass, including atomic writes, request failures and paired bulk reads in one transaction.
- Construct one active-hours formatter per schedule search. DST gaps, DST overlaps, overnight windows and equal start/end hours retain their behavior. A local median benchmark of five minute-interval searches through 1,439 candidates falls from 692 ms to 13 ms. Formatter construction falls from 1,440 to two per search, including timezone validation.
- Replace deep cloning of primitive audio records with shallow snapshots. Retained processor references cannot alter the previous snapshot, original options remain separate and volume/speed updates still reach the audio element. The local median for 50,000 preprocessing updates falls from 357 ms to 62 ms. These are focused synthetic measurements, not whole-client latency claims.

- Coalesce PrimaryStreamAudio tracking and Flux bursts into one animation frame. A sole audio source needs no primary-video scan. The regression fails against Stable; both focused renderer tests and the selection/volume suite pass. Pending frames are cancelled on stop. This removes demonstrated repeated work, but does not establish the cause of friends' reported 3 FPS.
- Cloud feedback regression: two tests fail against Stable because operation notifications persist to the notification log, which marks cloud data dirty and schedules another upload. All 49 SettingsSync tests pass after making cloud operation feedback transient. TypeScript and source lint pass.
- Automation UI initialization: the registry uses the existing LazyComponent and keeps the tab error boundary outside the lazy factory. The builder is required only from its open action. Both new regressions fail against Stable and pass after deferral; the engine retains its direct core import. TypeScript, source lint, standalone desktop and Chromium/Firefox/userscript builds pass. The IIFE still bundles the code, so this defers initialization rather than reducing initial download or parse size.
- RobloxActivity lifecycle: a pending process check could send a session notification after disabling the plugin or changing accounts. The regression fails on Stable and passes for stop, restart and account change after rejecting stale generations and account IDs. Current checks still report sessions; TypeScript and source lint pass.
- Oversized system log lines: Stable stops advancing when a line exceeds its 4 MiB read cap, causing repeated reads and hiding all later events. Keep a discard flag in each scanner until the next newline. The regression fails against Stable; native tests now cover large lines, real Codex polling, partial UTF-8 lines, short reads and truncation. Native and Discord automation suites, TypeScript and source lint pass. The byte cap remains in place.
- Automation editor duplication: delete the whole-workflow copy before selection. Reuse cloneBlock for selected blocks, leaving unrelated blocks untouched. The new regression fails against Stable and the runtime/editor suite passes, including independent nested data in the copied selection. Source lint passes.
- Browser startup metadata: malformed messages could throw, prematurely consume initialization or select arbitrary CSS URLs. Validate the metadata shape and packaged Chrome/Firefox stylesheet URLs before resolving readiness. The regression fails before the change and passes afterwards. Source lint and TypeScript pass. This validates the destination, not the identity of a same-page sender.

- Animalese sound loading: cancel replaced downloads and prevent pending messages from recreating audio after stop. Each load owns its cancellation and completion; late completions cannot replace current buffers. Regression cases cover stop, restart, rapid quality changes, returning to a loaded quality and network failure/retry. Both original lifecycle regressions fail before the change; all four tests pass after it. The new metadata and audio tests run in the existing performance check.

- Codeblock language guessing: delete explicit-language overriding, its extra highlighter pass and obsolete result metadata. Preserve author-supplied tags, including plain text, and skip guessing above the existing 50,000-character bound. Untagged hints and cached detection remain; Shiki receives the original tagged props and restores the original render function on stop. Three regressions fail before the change and pass afterwards.

- Automatic ZIP compression: remove synchronous whole-archive deflation from the renderer. Reuse fflate streaming compression and the existing Queue, with one worker active across uploads. Small files below 64 KiB avoid worker startup and batches yield after an 8 ms budget; larger inputs are fed in 64 KiB copies so transfer cannot detach the original data or leave a whole-input CRC pass on the renderer. Stop cancels compression and pending delivery; delivery retains the initiating channel and account. Existing 100 MiB and 500-file bounds and original-file fallback remain. Eight tests cover real worker-backed roundtrips, event-loop progress, worker limits, cancellation, special names, folder paths, limits, failed compression and stale delivery. Desktop builds pass. These proofs do not establish Discord frame rates on affected devices.

- Hidden call timers: extend the existing fixed-timer hook to disable scheduling when unused and include interval changes in effect ownership. Hidden self timers and absent voice connections retain hooks without scheduling ticks. Both regressions fail before the change and pass afterwards, including cleanup and interval changes. Source lint passes.

- Snowfall compatibility cleanup: use standard transforms, transitions and transition events supported by the declared browser minimums. Delete prefix probing and unsafe style casts, defer SVG encoding until image snow is selected, and read viewport dimensions when the effect starts. This removes startup work from disabled Snowfall. Source lint and TypeScript pass.

- ChannelTabs fallback work: unchanged updates retain their snapshot instead of copying and serializing all cached channels. Bursts coalesce into one active write plus a latest-state write. Loads remain retryable, writes wait for hydration, and concurrent accounts retain separate records. Seven focused tests pass; three initial regressions fail before the fix. Badge selectors now supply channel dependencies, complete store subscriptions and value equality. Source lint and TypeScript pass.

- ChannelTabs idle paint: remove infinite mention/Nitro shadow and icon-fill animations while retaining static colors, glows and saved glow toggles. The drag insertion marker keeps its shadow fixed and animates opacity only. Stylesheet lint passes. This removes continuous paint work visible in the CSS; affected-device FPS remains unmeasured.

- Command palette lifecycle and preview: hydrate all command data before installing handlers, reject stopped/superseded starts and register synchronously. Persisted values reject obsolete reads and preserve intervening edits. Delete the preliminary image decoder, unused dimensions and synthetic attachment metadata; the effect owns and revokes each local URL directly. Three regressions fail before the change and pass afterwards. Source lint and TypeScript pass. Malformed image files now use the image element's native error/alt display instead of waiting for a preliminary decode.

- Clientside guild icon ownership: delete the duplicate Blob snapshot and startup storage rewrite. Use the existing atomic DataStore update for save/reset and reject stopped or superseded operations before runtime URL creation. Legacy data URLs remain supported without rewriting storage on read. Images accepted by extension retain their MIME type across restart. All three original runtime regressions fail before the fix; five lifecycle tests and the existing normalization checks pass afterwards. Source lint and TypeScript pass.

- Message and emoji render work: remove CustomUserColors selected-channel lookups, the duplicate server-setting check and the exception/logging path. Use the message context already supplied by Discord. The regression fails before the fix and passes afterwards for DMs, servers, previews and gradients. DragFavoriteEmotes applies the existing pointer-events class directly in React instead of scheduling and cancelling one animation frame per emoji. Source lint and TypeScript pass.

- Clip upload lifetime: each modal owns its controller, which also covers picking, reservation, stamping, conversion, PUT and later sends. Stop aborts every registered lifetime; closing one modal leaves others running. Operations retain their opening account and check it before later stages. Picker tokens are released even when metadata processing is cancelled. Delete the cached FFmpeg instance and per-file cleanup; the existing Queue runs one conversion worker, which terminates on completion, failure or cancellation. Four original regressions fail before the change; six focused tests pass afterwards. Source lint and TypeScript pass. Conversion workers are tested with lifecycle fixtures, not real codec output; future conversions reinitialize WASM.

- Clip native boundary: validate metadata field types and reject metadata over 1 MiB before text decoding and JSON parsing. The malformed-metadata regression fails before the change. Failed temp writes now remove their directories; failed deletion logs a scrubbed warning and retains its token for retry. Eight focused clip tests and the existing 500 MiB read-cap/byte-writer check pass, along with source lint and TypeScript. Reading metadata still reads the bounded whole video; reducing those repeated file reads remains a separate performance finding.

- UserVoiceShow subscriptions: combine displayed voice flags and channel into one value-compared selector so unrelated voice changes do not rerender every indicator. Subscribe to displayed channel, permissions and tooltip users with explicit dependencies. The regression fails before the change and passes afterwards; source lint and TypeScript pass.

- Required helper message work: reject ineligible support messages before plugin-name scans and render its single button directly. Delete each chat card's full dependency map and conditional memo hook; compute active dependents only for required cards. Delete toolbox icon styles with no rendered users. Both helper regressions fail before the change and pass afterwards; source/style lint and TypeScript pass.

- Favourite file render work: compare lightweight saved metadata before decoding and memoize decoded items. Unrelated settings updates no longer inflate every favourite or rerender the picker. Preserve its documented retention of removed items until the query changes. Complete callback dependencies and compare file-row permissions by value. The regression fails before the change and passes afterwards for 100 unrelated updates, changed metadata and picker retention; source lint and TypeScript pass.

## Completion requirements

- Account for every baseline path with an explicit disposition and evidence scope.
- Finish the semantic review and validate every changed behavior with the smallest sufficient proof.
- Align package version, changelog and release documentation.
- Pass the repository checks and desktop/browser builds, then inspect the final PR diff against main.
- Open the PR with only `release:nightly`, attach it to this chat and enable auto-merge.

Signed-in Discord behavior and provider-dependent integrations require separate runtime evidence. Source inspection and mocked tests cannot establish that every possible defect has been eliminated.
