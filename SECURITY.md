# Security

## Audit scope

The LawyerCord fork was reviewed against the Equicord merge base at commit `1e353f3bdea3545c198b32c7e2216fcd0b923dbf`. The review covered added and modified source, GitHub workflows, dependency sources, lifecycle scripts, network calls, process execution, Electron IPC, local persistence, updater behavior, Discord MCP, voice transcription, and secure messaging.

Static review did not find a token stealer, webhook exfiltration path, credential export, obfuscated payload, or automatic upload of Discord messages to a ProtonnCord-controlled service. LawyerCord now intentionally includes the documented loopback-only control-panel server described below.

Static review cannot prove the absence of every vulnerability in a large client-mod codebase or in code downloaded later by optional plugins.

## Hardening applied

- Preserved the user's requested unrestricted Discord MCP behavior while retaining its fixed tool surface, disabled mention parsing, attachment validation, authenticated local queue, and sent-message-only deletion ledger.
- Disabled automatic source updates by default.
- Removed inherited write-capable Equicord release/reporting workflows.
- Replaced mutable latest-release installer downloads with an explicit local installer path.
- Kept cloud settings sync disabled by default.
- Updated vulnerable Moment.js versions and forced a patched DOMPurify version.
- Preserved Electron `safeStorage`, Discord-origin IPC checks, authenticated encryption, bounded attachment downloads, and CDN host/path validation in secure messaging.
- Preserved the required `NoTrack` plugin, which disables Discord analytics, metrics, and Sentry.
- Added a loopback-only control panel with a random capability path, same-origin API checks, no remote UI assets, encrypted semantic-index persistence, and bounded request bodies.
- Added generated static plugin privacy inventory plus runtime domain observations.
- Added redacted evidence exports with SHA-256 file and chained-record manifests.
- Added a release-artifact audit that rejects Discord token-shaped values and private MCP/control-panel runtime files, including bridge configuration, queues, ledgers, semantic indexes, and downloads.

## Discord account boundary

LawyerCord does not package a Discord token or a connection to the maintainer's account. The optional MCP plugin runs inside each user's existing authenticated Discord renderer and does not expose a token-export or generic authenticated REST tool. When enabled, that installation generates a new random local bridge secret in the user's application-data directory. The secret, local MCP queue, sent-message ledger, control-panel capability, approved-channel list, semantic index, and evidence data are not repository or release assets.

Personal user, guild, and channel IDs are not compiled into the product. The live verification harness accepts authorized IDs only through local environment variables and is excluded from normal CI.

## Remaining trust boundaries

- Enabling an optional plugin authorizes the network and local behavior implemented by that plugin.
- Several inherited media and editor features load version-pinned runtime assets from CDNs. A compromised CDN, package publisher, or configured custom host can affect those features.
- The Discord renderer is a privileged environment. A malicious enabled plugin can read visible content, as can the deliberately unrestricted MCP when it is enabled.
- The control-panel URL is a bearer capability. Malware running as the same operating-system user can read its local configuration, access the decrypted in-memory index, or connect to the loopback service.
- Electron can observe runtime network destinations but cannot reliably attribute every bundled request to the exact plugin that initiated it. The dashboard keeps source declarations and observations separate.
- Source updates execute newly fetched code after a rebuild. Only update from a reviewed remote under your control.
- The MCP file secret protects against accidental queue injection, not against malware already running as the same operating-system user.
- Enabling the unrestricted MCP grants its documented tool surface the same channel visibility as that installation's currently authenticated Discord account. Keep it disabled when it is not actively needed.
- Secure messaging has no forward secrecy or post-compromise healing and has not received an independent cryptographic audit. The dashboard reports this as legacy protocol v1. No unaudited replacement is silently enabled.

## Reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SenorLawyer/LawyerCord/security/advisories/new). Do not open a public issue for a security vulnerability.

Do not include Discord tokens, private messages, encryption keys, MCP queue secrets, or private attachment URLs unless they are strictly required to reproduce the issue. Revoke or rotate any credential that may have been exposed before submitting the report.
