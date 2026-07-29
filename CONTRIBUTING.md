# Contributing to LawyerCord

LawyerCord accepts focused security fixes, tests, documentation, upstream syncs, and maintainable features.

## Branch model

- `main` is the protected, releasable branch.
- Create short-lived branches from current `main`.
- Use `feature/<name>`, `fix/<name>`, `security/<name>`, or `maintenance/<name>` with lowercase hyphenated names. Never use a person, agent, or tool name as a branch prefix.
- Submit every change through a pull request. Direct pushes to `main`, including release tags, are not part of the normal repository workflow.
- Keep one logical change per pull request and use squash merge.

## Before opening a pull request

1. Open an issue before starting a broad feature or protocol change.
2. Preserve attribution and compatibility identifiers inherited from ProtonnCord, Equicord, and Vencord.
3. Do not add a dependency unless the pull request explains why existing platform APIs are insufficient.
4. Keep network access explicit, narrowly scoped, and visible in the privacy inventory.
5. Do not store Discord tokens, message content, encryption keys, MCP secrets, or attachment URLs in fixtures, logs, screenshots, or issue text.
6. Add focused tests for security boundaries and failure paths.
7. Installer changes must preserve the pinned source revision, embedded-client model, disabled self-updater, corresponding-source archive, and artifact audit.

Run the relevant local checks:

```shell
pnpm install --frozen-lockfile
pnpm testTsc
pnpm testDiscordMcp
pnpm testControlPanel
pnpm testReleaseArtifactAudit
pnpm testSecureMessaging
pnpm lint
pnpm lint-styles
pnpm buildStandalone
```

If plugin source or network behavior changed, regenerate the checked-in privacy inventory:

```shell
pnpm generatePrivacyInventory
```

## Code standards

- Prefer existing Discord and LawyerCord types over `any`.
- Validate untrusted network, IPC, filesystem, Discord, and JSON data at its boundary.
- Centralize shared domain types instead of repeating local interfaces.
- Use narrow type assertions only where the runtime boundary has already been checked.
- Keep privileged Electron operations in native helpers with origin, path, host, and size validation.
- Fail closed for encryption, permissions, and protected persistence.
- Avoid unrelated formatting or generated-file churn.

## Plugin rules

Plugins must not:

- expose tokens or generic authenticated Discord requests;
- implement self-bot abuse, automated moderation evasion, spam, or account farming;
- load mutable remote executable code without an explicit, documented user action;
- require users to paste private API keys into Discord settings;
- bypass SecureMessaging review or silently fall back to plaintext;
- introduce unbounded filesystem, attachment, message, or network processing.

Well-known third-party services are acceptable only when the feature, provider, transmitted data, and opt-in behavior are documented.

## Review and release

Pull requests require passing CI and resolved review conversations. Merged pull requests default to nightly releases; use exactly one `release:*` label to select beta, stable, or no release. See [VERSIONING.md](./VERSIONING.md) and [CHANGELOG.md](./CHANGELOG.md).
