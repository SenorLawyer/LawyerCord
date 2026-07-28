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
- The required `ControlPanel` plugin serves a capability-token-protected dashboard on `127.0.0.1`, preferring port `47831` and falling back to an available loopback port.
- No generic Discord REST, token-export, webhook, moderation, membership, relationship, or arbitrary filesystem MCP tool is exposed.

See [SECURITY.md](./SECURITY.md) and [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) for the audit summary and network boundaries.

## Local control panel

Open the panel with the local `/lawyercord control panel` command. It is available only while LawyerCord is running and includes:

- Discord account, server, relationship, channel, plugin, storage, and runtime-network statistics.
- Encrypted-at-rest local hybrid semantic search over explicitly approved channels.
- Evidence exports with automatic redaction, timestamps, SHA-256 file hashes, and a chained record manifest.
- A generated per-plugin source inventory of external domains, local storage, and elevated capabilities.
- Honest SecureMessaging protocol and migration status.

The semantic index initially approves channel `1085873944751521792`; change indexing scope from the dashboard. This does not restrict Discord or the MCP. The panel binds only to loopback, embeds no remote assets, disables CORS, and uses an unguessable URL stored with mode `0600` where supported.

## Discord MCP verification

The live test targets account `1045011641940574208`, guild `690342051778396403`, and channel `1085873944751521792` without turning those IDs into product restrictions. It verifies the account and read surface without sending a message. Live tests require a reviewed installed build and an explicitly enabled Discord debugging endpoint.

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

## Project status

There is no official LawyerCord release feed configured yet. Build from reviewed source, and do not enable source auto-update until this fork has a repository and release process under your control.

## Credits and license

LawyerCord is licensed under GPL-3.0-or-later. Copyright notices from ProtonnCord, Equicord, Vencord, and individual contributors are preserved in their files.

Discord is a trademark of Discord Inc. LawyerCord is not affiliated with or endorsed by Discord. Client modifications can violate Discord's Terms of Service; use a client mod only if you accept the account risk.
