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

## Completion requirements

- Account for every baseline path with an explicit disposition and evidence scope.
- Finish the semantic review and validate every changed behavior with the smallest sufficient proof.
- Align package version, changelog and release documentation.
- Pass the repository checks and desktop/browser builds, then inspect the final PR diff against main.
- Open the PR with only `release:nightly`, attach it to this chat and enable auto-merge.

Signed-in Discord behavior and provider-dependent integrations require separate runtime evidence. Source inspection and mocked tests cannot establish that every possible defect has been eliminated.

Cloud feedback regression: two tests fail against Stable because operation notifications persist to the notification log, which marks cloud data dirty and schedules another upload. All 49 SettingsSync tests pass after making cloud operation feedback transient. TypeScript and source lint pass.

Automation UI initialization: the registry uses the existing LazyComponent and keeps the tab error boundary outside the lazy factory. The builder is required only from its open action. Both new regressions fail against Stable and pass after deferral; the engine retains its direct core import. TypeScript, source lint, standalone desktop and Chromium/Firefox/userscript builds pass. The IIFE still bundles the code, so this defers initialization rather than reducing initial download or parse size.
