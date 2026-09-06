# LawyerCord

LawyerCord is a security-hardened fork of [ProtonnCord](https://github.com/ProtonDev-sys/ProtonnCord), which is based on [Equicord](https://github.com/Equicord/Equicord) and [Vencord](https://github.com/Vendicated/Vencord).

This repository keeps upstream attribution and protocol compatibility where changing an internal identifier would break existing data. Product names, build artifacts, settings, app data, browser metadata, and user-facing text use LawyerCord.

## Security posture

LawyerCord is safe-by-default, not network-free:

- Discord analytics, metrics, and Sentry are disabled by the required `NoTrack` plugin.
- Cloud settings sync is disabled by default.
- Source auto-updates are disabled by default. Only enable them after configuring a Git remote you control and trust.
- Optional plugins may contact services required for their feature. Review a plugin before enabling it.
- The voice-message transcriber performs inference locally but currently loads its pinned runtime and speech models from jsDelivr and Hugging Face. Keep it disabled if runtime CDN code is outside your trust model.
- The optional `DiscordMCP` plugin intentionally retains ProtonnCord's unrestricted access to every channel visible to the authenticated account, including its fixed send/delete surface.
- Discord credentials are never read, exported, embedded, or packaged. Each installation uses its own current Discord session and creates its own random local MCP bridge secret only after the user enables the plugin.
- CI rejects release artifacts containing Discord token-shaped values or LawyerCord runtime configuration, indexes, queues, ledgers, and downloads.
- No generic Discord REST, token-export, webhook, moderation, membership, relationship, or arbitrary filesystem MCP tool is exposed.

See [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) for network and storage behavior.

## Discord MCP verification

The opt-in live test reads authorized target IDs from local environment variables; no personal account, guild, or channel IDs are stored in the repository or release. It verifies the account and read surface without sending a message. Live tests require a reviewed installed build and an explicitly enabled Discord debugging endpoint:

```powershell
$env:LAWYERCORD_RUN_LIVE_DISCORD_MCP_READONLY = "VERIFY_AUTHORIZED_DISCORD_TARGET"
$env:LAWYERCORD_MCP_TEST_USER_ID = "<authorized-user-id>"
$env:LAWYERCORD_MCP_TEST_GUILD_ID = "<authorized-guild-id>"
$env:LAWYERCORD_MCP_TEST_CHANNEL_ID = "<authorized-channel-id>"
pnpm tsx scripts/testDiscordMcpLive.ts
```

## Development

Requirements:

- Git
- Node.js 22.13 or newer within Node 22, or Node.js 24 or newer
- The pnpm version specified by `packageManager` in `package.json`

Install dependencies without running as administrator:

```shell
pnpm install --frozen-lockfile
```

Build the desktop injection:

```shell
pnpm build
```

Build the browser extension and userscript:

```shell
pnpm buildWeb
```

Run the static test suite:

```shell
pnpm test
```

Injecting into Discord modifies the local Discord installation. LawyerCord will not download and execute a mutable installer release; provide an installer binary you built or verified locally:

```powershell
$env:LAWYERCORD_INSTALLER_PATH = "C:\path\to\verified\EquilotlCli.exe"
pnpm inject
```

See [LOCAL_INJECTION.md](./LOCAL_INJECTION.md) for injection, rebuilds, Discord debugging, logs, local tests, repair, and removal.

Do not inject or run live Discord tests from an unreviewed branch. The live MCP and secure-messaging scripts connect to a running Discord client through its debugging interface and are intentionally excluded from the normal test command.

## Releases

Release builds use the exact merge commit. Apply exactly one release label before merging; an unlabeled pull request does not publish a release:

- `release:nightly` creates an immutable nightly prerelease.
- `release:beta` creates a versioned beta prerelease.
- `release:stable` creates the versioned stable release and marks it latest.
- `release:skip` performs no release, which is appropriate for release-process-only changes.

Every channel publishes the same Windows asset set:

- `LawyerCordInstaller.exe`: graphical offline installer with the exact release build embedded.
- `LawyerCordInstallerCli.exe`: command-line offline installer.
- `LawyerCord.asar`: standalone desktop injection payload.
- A portable build ZIP, corresponding installer source ZIP, and `SHA256SUMS.txt`.

The installers do not contain a Discord token, contact an account-specific service, download the client at runtime, or update themselves. Stable releases require a unique version in `package.json`; tags are never moved or overwritten.

## Credits and license

LawyerCord is licensed under GPL-3.0-or-later. Copyright notices from ProtonnCord, Equicord, Vencord, and individual contributors are preserved in their files.

Discord is a trademark of Discord Inc. LawyerCord is not affiliated with or endorsed by Discord. Client modifications can violate Discord's Terms of Service; use a client mod only if you accept the account risk.
