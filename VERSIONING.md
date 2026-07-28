# Versioning and releases

`package.json` is the source of truth for the LawyerCord version.

The current four-part format is retained for upstream compatibility:

```text
major.minor.patch.packaging
```

- Increment `major` for incompatible stored-data, plugin, or protocol changes.
- Increment `minor` for backwards-compatible features.
- Increment `patch` for backwards-compatible fixes and security hardening.
- Increment `packaging` for rebuilds that change distribution metadata without changing source behavior.

## Release process

Releases are produced only by the GitHub Actions workflow after a protected pull-request merge or an explicit manual dispatch against current `main`. Do not push release tags manually.

Pull-request labels select the channel:

- No release label or `release:nightly`: `nightly-YYYYMMDD-HHMM-<commit>` prerelease.
- `release:beta`: `v<package-version>-beta.<workflow-run>` prerelease.
- `release:stable`: `v<package-version>` stable release marked latest.
- `release:skip`: no release.

Only one channel label may be applied. `release:skip` takes precedence.

For a stable release:

1. Update `CHANGELOG.md` and `package.json` in a release pull request.
2. Apply `release:stable`.
3. Confirm required CI checks pass and merge through the protected branch.
4. The workflow checks out the exact merge commit, reruns audits, focused tests, and builds, rejects packaged credentials/private runtime data, builds offline Windows GUI and CLI installers from the pinned audited installer source, then publishes the immutable release with SHA-256 checksums and corresponding installer source.
5. Test the artifact on its target platform before enabling it for automatic updates.

Release tags are immutable. Fix a bad release with a new version instead of moving an existing tag.
