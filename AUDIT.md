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
- Serializing queue mutations and exposing them in memory only after storage commits.
- Preserving queue entries and previews after failed deletion, with failure feedback in the UI.
- Removing unused rescheduling and channel-filter helpers.

The proposed version is `3.0.0.0` because older scheduled data now requires explicit recovery. See [VERSIONING.md](VERSIONING.md) for the compatibility and downgrade implications. No release tag has been created for this audit.

## Verification record

Evidence applies to the recorded commit and scope, not to a future merge with main.

| Check | Commit | Result and limits |
| --- | --- | --- |
| Broader performance/correctness suite | `d93c2e1ac` | 308 tests and timezone correctness checks passed. |
| Repository-wide ESLint | `d93c2e1ac` | Passed under the repository's configured file scopes and exclusions. |
| Latest plugin regressions and TypeScript | `a6f4ad64a` | 259 plugin tests and full TypeScript passed; focused source lint passed. |
| Standalone and web builds | `f77ae311a` | Passed. Packed Chromium/Firefox manifest versions and generated client versions match `3.0.0.0`. |
| Release artifact audit | `f77ae311a` | Passed for `dist`, including ZIP entries. This is a credential-pattern and private-runtime-path check. |
| Real IndexedDB queue behavior | `0f8af3577` | Isolated Chrome verified aborted additions, ordered concurrent additions, aborted clearing, and subsequent successful clearing using actual queue and DataStore code. |
| Other isolated browser checks | Earlier audit commits | Specific sticker-storage transactions, codec conversion, and CSS behavior were exercised. These are not general live-client acceptance. |

Mocked Discord requests do not establish live account-switch, message-send, or plugin-patch compatibility. No real Discord messages were sent by these regression fixtures. Current-head CI success has not been established.

## Remaining work

The full finding ledger is still being worked through. This list identifies major open areas and is not an assertion that other findings are closed:

- Scheduled-message recovery controls, persisted-data validation, modal lifetime handling, and coordination between separate client contexts.
- Remaining plugin account, cancellation, network-response, storage, and resource-lifecycle findings across the broader codebase.
- Runtime validation of patch anchors. The current patch validator reports 192 warnings; those warnings have not all been resolved or justified against current Discord modules.
- Native and provider behavior that mocked tests cannot establish, including target-platform installer and live-client acceptance.
- Integration of separately reviewed main changes, preservation of main's release history, and final checks against the combined source.
- A final finding-by-finding disposition, current-head CI, and final audit report before removing draft status.

The audit must not be described as a clean-codebase or release-readiness certification while these items remain unresolved.
