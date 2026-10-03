# Post 1.16 follow-up audit

Candidate: 4.0.1.0 Nightly, based on `b9ebd83b12b0d2252cfe832f36a9d08eced1fcce`, the merged 4.0.0.0 audit. This follow-up continues the historical reads that the [first report](plugin-settings-performance-audit-2026-10-03.md) explicitly marked selective. Its historical inventory and candidate coverage hashes remain a record of that earlier snapshot.

## Reproduced defects

| Area | Previous behavior | Follow-up behavior |
| --- | --- | --- |
| Automation import | A picker captured the old workflow list. Creating, editing or deleting workflows while choosing a file could be undone by importing. A later account or import could receive an obsolete completion. | Append to the latest state after hydration. Reject obsolete imports after file reads and at the mutation boundary. Scoped account listeners are removed in `finally`. |
| Automation server list | The exporting account's `available` flag decided whether the importing account appeared joined. Names and icons could remain stale. | Subscribe to Discord's GuildStore and use its current membership, name and icon. Imported references provide missing-server details and invitations. Remove the unused asynchronous metadata refresh that could overwrite newer references. |
| Logged message conversion | Discord records were JSON converted before transient render fields were removed. Cyclic React render state on a message or reply could fail conversion. Plain payload copies shared authors and nested values with the input. | Strip render state before record conversion, including replies. Preserve the existing record JSON normalization for timestamps and unsupported values. Use Discord's Lodash deep clone for plain payloads so privacy filtering and later edits do not mutate the source. |
| Animated sticker failures | Failed HTTP responses left their body unmanaged after the deadline timer was cleared. | Cancel unsuccessful bodies and abort settled request controllers. A ten-failure control now releases all ten bodies and signals. |
| V1 cloud uploads | Backend selection happened after a complete DataStore snapshot, although V1 uploads send only settings and CSS. | Select the backend under the captured owner, skip V1 DataStore snapshots, and preserve revision checks across the lookup. Downloads and V2 uploads retain their required data snapshots. |
| Profile timezones | Extracting identity from a banner URL omitted users without banners and server banners. The URL could also disagree with the viewed user. | Forward the viewed user's ID from Discord's owning profile component to its banner component. Preserve profile and own-timezone preferences. |

The automation regression checks exercise concurrent create, edit and delete operations, superseded pickers, logout during file reading, account changes during initial hydration, and live server membership changes. They invoke the actual import and engine source. The cloud regression invokes the public upload and download functions with a 1 MiB cache entry; V1 uploads make zero DataStore payload reads, while V2 and downloads still read their required payloads.

The logger checks also execute the captured public Discord Message `toJS` implementation and Lodash factory, with cyclic root and reply render state and Moment timestamps. The captured Lodash version is 4.18.1, from `https://discord.com/assets/192743.883920cc41783fd8.js`; the Message implementation is from the main asset identified in the first report. An initial clone-customizer approach failed compatibility controls and was replaced before publication. Record conversion retains its existing JSON wire behavior, including `toJSON` keys, omitted functions and symbols, and normalized timestamps. These fixtures do not access real messages or microphone input.

## Validation

The follow-up passed all 1,260 performance tests with actual FFmpeg and zero skips, the timezone formatter check, all 51 settings-sync and progressive cloud-read tests, the complete automation suite, TypeScript, changed-source lint, full repository lint with ignored local evidence excluded, and patch lint. Desktop, Vesktop, Equibop, web, userscript and extension builds passed, followed by the packaged credential/private-data audit. Package version, changelog and versioning documentation agree on 4.0.1.0. Release CI and packaged verification are recorded separately after publication.

The timezone regression uses captured Discord owner module 915614 and banner module 714719 from the main asset identified in the first report. The owner factory SHA-256 is `c91f150480a3573f453e97d35d829de3c4b66c065b1e439d108f04619ce34680`; the banner factory is `fad1a3db3aa430b96b5217fa67f3d73b1c683b3c8cfbbbf4d97a3bdf69c9d226`. The new finder matches only the owning factory in the captured module set. Tests execute the complete factories as well as the pinned profile functions. This verifies the props contract and preserves the existing timestamp placement without inferring identity from a CDN URL.

## Scope and limitations

The [expanded history inventory](post-1.16-followup-review-2026-10-03.json) records complete textual diff review for all 25 first-parent changes from `v1.16.0.0` through the frozen `53260d5900b155a60e89a3fbb89489df6a37cc66` baseline. This closes the eleven entries previously marked selective or runtime-only. The largest patch, PR47, was read across all 72,735 raw lines. Reads include removed code, tests, documents, the complete historical coverage TSV and embedded worker strings; binary media is classified separately. PR57 and this follow-up were reviewed separately as authored changes.

Some historical coverage rows carry copied batch notes or pending-candidate language. Their hashes remain useful provenance, but those notes do not become per-file runtime evidence. The new inventory preserves this distinction and records the additional full-source, semantic-data and embedded-resource reviews without upgrading semantic or binary checks into literal text reads.

The user's progressive FPS collapse has not been reproduced in a live renderer. At 00:39 UTC on 2026-10-03, the running Discord installation had no renderer debugging flags or listeners on ports 9222 and 9223, and Computer Use exposed no Discord browser tab or native app surface. This work did not install or restart Discord.

The same inspection found `enableHardwareAcceleration: false` in Discord's saved settings. Its GPU process used `d3d11-warp-webgl`, and its renderer had `--disable-gpu-compositing`. That is evidence of software rendering and a plausible contributor to low FPS, not proof of the progressive slowdown's cause or its introduction after 1.16. LawyerCord source contains no matching acceleration-disable call or switch. The user's setting was left unchanged.

Passing source and public-factory tests demonstrate the stated defects and resource reductions; they do not prove live FPS recovery or settings visibility across all Discord builds. The 4.0.0.0 Nightly already contains the shared modal, catalog, settings, automation, media and plugin performance changes described in the first report.
