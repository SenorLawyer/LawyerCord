# Changelog

All notable LawyerCord changes are recorded here. Versions follow [Semantic Versioning](https://semver.org/) with a fourth packaging revision retained while the project remains compatible with its upstream version format.

## Unreleased

### Added

- Automated nightly, beta, and stable release channels driven by protected pull-request merges.
- Release ZIP checksums and artifact auditing for Discord credential patterns and private runtime data.

### Changed

- New installations begin with no channels approved for local semantic indexing.
- Live Discord MCP verification accepts authorized target IDs only through local environment variables.

### Security

- Release artifacts cannot contain local Discord MCP/control-panel configuration, bridge secrets, queues, ledgers, indexes, downloads, or Discord token-shaped values.
- The optional MCP remains unrestricted within its fixed tool surface but uses only the enabling installation's current Discord session and locally generated bridge secret.

### Planned

- An audited SecureMessaging protocol v2 after the provider, licensing, packaging, and migration gate is approved.
- Signed installable artifacts and platform-specific release verification.

## 1.14.16.0 - 2026-07-28

### Added

- LawyerCord product identity, browser metadata, local icon, and application-data namespace.
- App-lifetime loopback control panel with account, guild, relationship, plugin, storage, and network statistics.
- Encrypted local approved-channel search and tamper-evident evidence exports.
- Generated privacy inventory covering plugin domains, storage, and elevated capabilities.
- Scoped live Discord MCP verification harness.
- Security, privacy, contribution, CI, dependency review, CodeQL, audit, and controlled release documentation.

### Security

- Audited the ProtonnCord fork delta and documented remaining trust boundaries.
- Disabled source auto-update and cloud sync by default.
- Removed mutable remote installer execution and inherited upstream publishing workflows.
- Updated production and development dependencies until the full audit reported no known vulnerabilities.
- Replaced the obsolete `zip-local` build wrapper with the current JSZip API so extension packaging no longer depends on vulnerable JSZip 2 behavior.
- Retained the intentionally unrestricted Discord MCP with its fixed tool surface, authenticated local queue, attachment validation, mention suppression, and sent-message-only deletion ledger.

### Changed

- Renamed product-facing ProtonnCord identifiers to LawyerCord while preserving attribution and cryptographic protocol compatibility identifiers.
