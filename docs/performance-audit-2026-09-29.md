# Client performance and update audit

Baseline: `v1.16.1.0` (`fc0de7e443ed551f7bd005bf0a7f71edee48add0`). Reviewed endpoint: `d783136e33046f71ec753ca308df17549e7e64de`.

The comparison contains 712 changed files. The audit reviewed changed runtime code, followed suspicious call sites, and classified deleted code, types, documentation, generated artifacts, tests, and build-only tools separately. Findings below concern remaining behavior at the endpoint, rather than historical issues already fixed by intervening commits.

| Scope | Changed files | Review |
| --- | ---: | --- |
| Plugins | 510 | Event handlers, rendering, storage, network requests, timers, cleanup, and patch changes. |
| Automation UI and runtime | 32 | Scheduling, execution, editor rendering, queues, logs, and persistence. |
| Core and shared source | 82 | Startup, settings synchronization, stores, webpack lookup, updater, components, and main-process code. |
| Build, tests, and tooling | 52 | Build inclusion and native discovery; tests and offline utilities classified as non-runtime. |
| Browser and MCP tooling | 8 | Browser packaging, extension behavior, and MCP server changes. |
| Packages, configuration, and documentation | 28 | Dependency/build impact and non-runtime metadata. |

## Repairs

| Area | Evidence | Change |
| --- | --- | --- |
| Windows archive installation | The installed updater returned `EPERM` while renaming a staged archive over the loaded archive. Moving the installed archive also failed, while opening it for writes succeeded. | Keep atomic replacement where possible. On Windows `EPERM`, back up the old archive and copy the verified update into the existing file. Restore the backup if copying fails. Other permission errors still fail. |
| Cold modal rendering | A running Discord session had no loaded `Modal` export. Loading the native confirmation-modal chunks made both exports available. | Wait for the shared native chunks before rendering either modal component. Load on demand rather than at startup. This compatibility problem also existed in the baseline. |
| Shared button initialization | The live common Button export was `undefined`, although its implementation existed. This caused the reported `Sizes` render error. | Re-export the live binding rather than capturing its value during circular module initialization. |
| Desktop renderer startup | The previous desktop bundle contained approximately 1.4 MB of embedded media data. | Package media separately and stream it on use. Desktop renderer output fell from approximately 6.0 MB to 4.6 MB. Web builds retain their self-contained payload. |
| Cloud synchronization errors | Persisted error notifications wrote notification history, which the newer DataStore listener treated as a reason to upload again. | Keep errors visible without persisting synchronization failure notifications. Real data changes still schedule uploads. |
| V1 cloud uploads | The newer upload setup read and cloned unrelated DataStore data before discovering that V1 does not upload it. | Determine the backend before taking the snapshot; preserve full snapshots for V2 and downloads and retain account/edit conflict checks. |
| Schedule previews | A one-minute schedule outside active hours constructed 549 date formatters for five preview occurrences. | Reuse the active-hours formatter for the current timezone. Check normal, overnight, and DST behavior. |
| Oversized native log lines | Three polls repeatedly read the same 4 MiB prefix and left the offset at zero. | Advance through oversized lines with bounded discard state, then resume at the next complete record. |
| Session header inspection | Reading a short header requested up to 4 MiB from each session file. | Read incrementally in 16 KiB blocks, stopping at the header or three complete lines. Preserve support for headers up to the original 4 MiB bound. |
| Roblox activity | Unrelated presence events triggered additional native process checks beyond the existing timer. | Keep process discovery on its owned timer. |
| Sticker blocking | Each sticker render reparsed the unchanged blocklist. | Reuse the parsed set until the setting changes. |
| Sticker search | Each keystroke rebuilt the picker content synchronously. | Debounce result updates with the shared lodash utility, keep the input immediate, and cancel pending work on cleanup. |
| Session names | Concurrent session rows each loaded and validated the same saved account map. | Share only pending reads for the same account, without caching completed Discord data. |
| Reaction avatars | The selector included a global user-store version, rerendering reaction rows for unrelated user changes. | Compare the relevant reaction users and their displayed profile fields instead. |
| Call timers | The hidden self timer still mounted ticking work. | Mount the timer hook only in the visible child while keeping settings reactive. |
| Role interaction patches | The live patcher rejected an unmatched opening parenthesis before the second grouped replacement could close it. | Apply each wrapper as one balanced replacement, verified against both live module factories. |

## Verification and limits

- The original updater failure was reproduced through the installed client's native updater API. A disposable Windows file held with the same no-delete lock then verified the production replacement path, exact installed bytes, and backup retention.
- The repaired client rendered the cold modal, its compatibility button, and the actual updater tab. The packaged video loaded in Discord with its expected dimensions and duration.
- Regression tests cover the repairs, including checksum rejection, write rollback, account isolation, synchronization conflicts, timezone boundaries, oversized lines, long headers, unrelated user updates, and lifecycle cleanup.
- Built-in media now follows Discord's selected audio output. The default browser output was an inaudible monitor while Discord used Voicemeeter; replaying through the selected output was confirmed audible. Updated effects exist only during playback, cap confetti at 650 and sparks at 1600, and release animation frames, listeners, timers, and audio on dismissal or completion.
- This is a source-diff audit plus focused runtime tests and workload measurements. It is not an FPS, idle-CPU, heap, or startup-time comparison between two complete Discord installations. It does not establish performance parity with `v1.16.1.0` or claim that every user's slowdown has the same cause.
- Existing fixes for default-off automations, bounded queues, subscription cleanup, native watcher demand, and download limits were retained. New features were not removed merely because they increase source size.
- The fallback Windows copy is not atomic. It preserves a backup and rolls back caught write failures, but a process or machine interruption during copying can still require repair from the backup or installer.
