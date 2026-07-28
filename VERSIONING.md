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

1. Merge reviewed changes to `main`.
2. Update `CHANGELOG.md` and `package.json` in a release pull request.
3. Confirm `pnpm audit --prod --audit-level low` and required CI checks pass.
4. Create a signed or verified tag matching the package version, such as `v1.14.16.0`.
5. Push the tag. The release workflow verifies the version, rebuilds, reruns focused checks, packages `dist`, and creates the GitHub release.
6. Do not publish an installer or enable automatic updates until the artifact has been tested on its target platform and the release owner has approved it.

Release tags are immutable. Fix a bad release with a new version instead of moving an existing tag.
