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
- The required `ControlPanel` plugin serves a capability-token-protected dashboard on `127.0.0.1`, preferring port `47831` and falling back to an available loopback port.
- CI rejects release artifacts containing Discord token-shaped values or LawyerCord runtime configuration, indexes, queues, ledgers, and downloads.
- No generic Discord REST, token-export, webhook, moderation, membership, relationship, or arbitrary filesystem MCP tool is exposed.

See [SECURITY.md](./SECURITY.md) and [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) for the audit summary and network boundaries.

## Local control panel

Open the panel with the local `/lawyercord control panel` command. It is available only while LawyerCord is running and includes:

- Discord account, server, relationship, channel, plugin, storage, and runtime-network statistics.
- Encrypted-at-rest local hybrid semantic search over explicitly approved channels.
- Evidence exports with automatic redaction, timestamps, SHA-256 file hashes, and a chained record manifest.
- A generated per-plugin source inventory of external domains, local storage, and elevated capabilities.
- Honest SecureMessaging protocol and migration status.

The semantic index starts with no approved channels. Add channels explicitly from the dashboard; this indexing scope does not restrict Discord or the MCP. The panel binds only to loopback, embeds no remote assets, disables CORS, and uses an unguessable URL stored with mode `0600` where supported.

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
- Node.js 22 or newer
- pnpm 11.13.0

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

Regenerate the privacy inventory after adding or changing plugins:

```shell
pnpm generatePrivacyInventory
```

Injecting into Discord modifies the local Discord installation. LawyerCord will not download and execute a mutable installer release; provide an installer binary you built or verified locally:

```powershell
$env:LAWYERCORD_INSTALLER_PATH = "C:\path\to\verified\EquilotlCli.exe"
pnpm inject
```

Do not inject or run live Discord tests from an unreviewed branch. The live MCP and secure-messaging scripts connect to a running Discord client through its debugging interface and are intentionally excluded from the normal test command.

## Releases

Every merged pull request is built from its merge commit and defaults to a unique nightly prerelease. Apply one release label before merging to select a different result:

- `release:nightly` creates an immutable nightly prerelease.
- `release:beta` creates a versioned beta prerelease.
- `release:stable` creates the versioned stable release and marks it latest.
- `release:skip` performs no release, which is appropriate for release-process-only changes.

Each release contains a Windows ZIP and `SHA256SUMS.txt`. Stable releases require a unique version in `package.json`; tags are never moved or overwritten.

## Credits and license

LawyerCord is licensed under GPL-3.0-or-later. Copyright notices from ProtonnCord, Equicord, Vencord, and individual contributors are preserved in their files.

Discord is a trademark of Discord Inc. LawyerCord is not affiliated with or endorsed by Discord. Client modifications can violate Discord's Terms of Service; use a client mod only if you accept the account risk.
