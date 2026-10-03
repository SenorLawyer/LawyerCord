# Braces security patch

`braces@3.0.3.patch` contains the five runtime-file changes from [upstream PR 72](https://github.com/micromatch/braces/pull/72), pinned to commit [`d0d575e55e74a4e0218e5248fafb79efc3e54ebb`](https://github.com/micromatch/braces/commit/d0d575e55e74a4e0218e5248fafb79efc3e54ebb). Its SHA-256 is `37f95f7d660c05bfd44d4b429ca49ceeede99dcff68389f81ee9b995a8ea24d2`.

The npm registry still publishes 3.0.3 as the latest version as of October 3, 2026. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no patched release. The upstream pull request remains unmerged. This is a locally applied, pinned upstream proposal, not an official fixed release.

The patch bounds brace and parenthesis nesting at 100 in the parser and guards compile, expand and stringify for callers passing ASTs directly. A lower `maxDepth` is supported; a higher value cannot remove the hard limit. Normal glob behavior is retained.

CI may exclude only this advisory after `scripts/testBracesSecurity.mjs` succeeds. That check verifies the patch hash, exact workspace registration, every locked Braces version and reference, and the installed package reached through Stylelint and Micromatch. It tests malicious patterns below the existing character limit, direct ASTs, the depth boundary, and ordinary glob expansion. Other advisories retain their existing audit severity thresholds.

When an official fixed version is available, replace the patch with that release and remove the matching advisory exception together. Keep the regression coverage.
