# Automation revamp review

The revamp is in `C:\Users\larsm\Documents\Development\Active\Developer Projects\LawyerCord-automation-revamp`, on `feature/automation-revamp`. Discord's loader now points to this worktree's `dist\desktop` build.

Baseline commit: `c637282a72ca612f29db2b8072b61c5bd2c943ec`.

The baseline includes the original checkout's tracked changes, deletions, and non-ignored untracked files. The snapshot verified 1,621 file contents and eight deletions before implementation. The original index SHA-256 still matches `d97b512f547d39059291582e27eb57886011868a86b8992868c797f3c811c271`. Unrelated changes belong to the baseline, not the revamp diff. No release version, tag, publishing workflow behavior, or PR was changed.

## Changes

Graph and step views share the same workflow and undo history. The editor adds selection and connection controls, linked steps for loops and joins, output references, validation links, templates, autosaved drafts, an unsaved-workflow list, and separate Save, Test, Run, and Cancel controls. Both the editor and workflow page expose grouped run history.

The production runner is independent of React. Runs have isolated variables, snapshots, cancellation, deadlines, step budgets, output routing, reusable workflow calls, bounded traces, and configurable queues. Event routing shares subscriptions with waiting blocks. Workflow-scoped values use DataStore updates. Dry runs substitute explicit sample results for external blocks and keep value writes in memory.

The block library adds list and object operations, workflow calls and returns, switches, per-item loops, saved values, reaction waits, message and channel reads, Spotify shuffle and repeat, device selection, and AI conversation, schema, timeout, and usage settings. Existing Discord actions continue through the integration adapters.

Version 2 storage backs up legacy definitions before migration. Legacy workflows retain skip mode. Imports are validated before writing, copied IDs and internal references are remapped, and imported workflows start disabled. Unsupported blocks remain visible for repair. Credentials remain in the native credential store and are excluded from exports.

Calendar and five-field cron schedules use an explicit timezone and show upcoming occurrences. The implementation uses [cron-parser](https://github.com/harrisiirak/cron-parser), including its handling of daylight-saving transitions. Tests cover Amsterdam's missing and repeated hours, month boundaries, and leap years.

## Validation

- `pnpm testAutomations`: production runner, routing, loops, cancellation, deadlines, queues, isolation, values, calls, imports, migration, drafts, and calendar checks pass.
- `pnpm testTsc`: passes.
- ESLint across `src` and Stylelint across source styles: pass.
- Internationalization lint: zero errors or warnings. Patch lint: zero errors and 197 existing warnings.
- Desktop and standalone web builds: pass. Desktop and browser artifact credential audits: pass.
- The isolated real-editor preview passes graph/step switching, loop links, dry runs, duplication, undo/redo, and the 100-block fixture.
- Discord checks pass graph/step switching, keyboard selection, duplication, undo/redo, dry runs, a saved data-only run, explicit Save behavior, draft recovery, a small viewport, and light-theme variables. The saved test workflow is removed afterward. Automated tests send no live messages.

Automation tests are included in both CI and release checks. The two lint scripts now handle Windows paths containing spaces through `fileURLToPath`.

Reproduce the isolated and live editor checks with:

```powershell
node scripts/previewAutomations.mjs --test
node scripts/testAutomationEditorLive.mjs --confirm-local-test
```

The isolated preview needs React and ReactDOM in `%TEMP%\lawyercord-automation-preview`, or a directory supplied through `LAWYERCORD_PREVIEW_RUNTIME`. The live check needs Discord's temporary loopback debugging endpoint. It restricts its saved run to the disabled list-processing fixture.

## Performance

These are local measurements with the same fixtures and substituted Discord/storage adapters. Dispatch and snapshot numbers are medians of seven batches. Editor measurements use React's development profiler and sampled allocations, with pointer capture substituted for synthetic selection events. They are comparisons, not production frame-rate guarantees.

| Fixture | Baseline | Revamp |
| --- | ---: | ---: |
| 10,000 unmatched events across 100 workflows | 79.79 ms | 20.88 ms |
| 1,000 workflow snapshot reads | 40.62 ms | 0.19 ms |
| Message subscriptions with 20 concurrent waits | 21 | 1 |
| Storage writes across the runtime fixtures | 24 | 6 |
| 10,000-step run | 38.76 ms | 94.25 ms |
| 50 selections in a 100-block editor | 697.87 ms | 709.56 ms |
| Editor render duration across those selections | 246.30 ms | 252.60 ms |
| Editor render count | 50 | 51 |
| Sampled editor allocations, including collected objects | 149.18 MB | 162.46 MB |
| Editor storage writes | 0 | 1 |

Dispatch, snapshot access, subscriptions, and runtime storage writes improve. Editor selection cost is close to the baseline, with additional allocation overhead and one autosave. The long-run fixture is slower: the runner records input/output and branch metadata and periodically yields to keep the editor responsive. This is a measured tradeoff, not a throughput improvement.

Raw results and screenshots are in `dist/automation-review`: `performance.json`, `editor-before.json`, `editor-after.json`, `ui-checks.json`, `discord-checks.json`, and the corresponding PNG files. The directory is local and ignored by Git.

## Live limits

OpenRouter completions, Spotify playback changes, Discord message mutations, commands, and component interactions were not executed against the account during automated validation. Their adapter behavior is covered by controlled results or sample data; account permissions and provider-specific responses still need targeted live use. No paid AI requests or playback changes were made.

Calendar boundaries are checked with controlled dates; an actual computer sleep/wake cycle was not performed. Heap deltas from the runtime benchmark include garbage-collection noise and are not total allocation counts. The live theme check changes CSS theme classes temporarily and restores them, without changing the saved Discord theme.

The installer used for injection matched the published SHA-256 of `LawyerCordInstallerCli.exe` from `nightly-20260830-1239-6210ccf6`. The original loader backup is at `%TEMP%\lawyercord-installer-verification\original-loader.asar`.
