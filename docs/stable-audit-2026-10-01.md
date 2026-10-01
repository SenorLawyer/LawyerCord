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

## Completion requirements

- Account for every baseline path with an explicit disposition and evidence scope.
- Finish the semantic review and validate every changed behavior with the smallest sufficient proof.
- Align package version, changelog and release documentation.
- Pass the repository checks and desktop/browser builds, then inspect the final PR diff against main.
- Open the PR with only `release:nightly`, attach it to this chat and enable auto-merge.

Signed-in Discord behavior and provider-dependent integrations require separate runtime evidence. Source inspection and mocked tests cannot establish that every possible defect has been eliminated.
