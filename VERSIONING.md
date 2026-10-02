# Versioning and releases

`package.json` is the source of truth for the LawyerCord version.

The current source version is `3.1.4.0`, targeting Nightly from the audited Stable `3.0.1.0` baseline. The current Stable release version is `3.0.1.0`, including the `3.0.0.0` audit and update-channel fixes.

The current four-part format is retained for upstream compatibility:

```text
major.minor.patch.packaging
```

- Increment `major` for incompatible stored-data, plugin, or protocol changes.
- Increment `minor` for backwards-compatible features.
- Increment `patch` for backwards-compatible fixes, performance improvements and security hardening.
- Increment `packaging` for rebuilds that change distribution metadata without changing source behavior.

## Compatibility in 3.0.0.0

Scheduled messages now record their originating account, and sending requires that account. Entries created by older versions have no trustworthy owner and remain saved but paused until recreated under the intended account. This stored-data behavior requires a major version increment.

Older versions ignore account ownership and attempted-send markers. Downgrading while scheduled entries remain can send messages from another account or repeat an earlier attempt. Review and remove saved scheduled entries before downgrading.

TriviaAI is also removed in `3.0.0.0` because its required API key and arbitrary endpoint conflict with the plugin policy. The Answer With AI actions are unavailable. Existing saved settings are retained but no longer used by a bundled plugin.

## Release process

Releases are produced only by the GitHub Actions workflow after a protected pull-request merge or an explicit manual dispatch against current `main`. Do not push release tags manually.

Pull-request labels select the channel:

- `release:nightly`: `nightly-YYYYMMDD-HHMM-<commit>` prerelease.
- `release:beta`: `v<package-version>-beta.<workflow-run>` prerelease.
- `release:stable`: `v<package-version>` stable release marked latest.
- No release label or `release:skip`: no release.

Only one channel label may be applied. `release:skip` takes precedence.

Stable clients accept only Stable releases. Beta clients accept Stable and Beta releases. Nightly clients accept all three channels. Packaged clients compare the selected release's immutable tag commit, never its moving `target_commitish` branch.

Source clients follow dedicated `stable`, `beta`, and `nightly` branches. After publishing, Stable advances all three branches, Beta advances `beta` and `nightly`, and Nightly advances only `nightly`. Missing branches fail the update check; they never fall back to unreleased `main` commits.

For a stable release:

1. Update `CHANGELOG.md` and `package.json` in a release pull request.
2. Apply `release:stable`.
3. Confirm required CI checks pass and merge through the protected branch.
4. The workflow checks out the exact merge commit, reruns audits, focused tests, and builds, rejects packaged credentials/private runtime data, builds offline Windows GUI and CLI installers from the pinned audited installer source, then publishes the immutable release with SHA-256 checksums and corresponding installer source.
5. Test the artifact on its target platform before enabling it for automatic updates.

Release tags are immutable. Fix a bad release with a new version instead of moving an existing tag.

## VoiceRejoin compatibility in 3.0.0.0

Saved reconnect targets now include the originating account. Older targets without an owner are retained but ignored; joining a call records a new target. Older clients ignore this owner field, so disabling VoiceRejoin before downgrading avoids using a target from another account.
