# Secure Messaging protocol v2 gate

Secure Messaging v1 (`PCEM1`) remains readable and writable until a version 2 provider passes this gate. LawyerCord must not describe v1 as forward-secret or silently substitute a home-grown ratchet.

## Evaluated providers

### Official Signal libsignal

[`@signalapp/libsignal-client`](https://github.com/signalapp/libsignal) exposes Signal's Rust implementation to TypeScript and includes the Double Ratchet protocol. It is the preferred one-to-one and per-device candidate.

Current blockers:

- The package is AGPL-3.0-only. Adding it changes LawyerCord's distribution obligations and needs an explicit licensing decision.
- Its unpacked native package is approximately 145 MB and must be packaged for each supported Electron platform and architecture.
- Discord must act as an untrusted delivery service for pre-key bundles, per-device session state, ciphertext type, and replay-safe acknowledgements.
- Group DMs need sender-key or multi-recipient session semantics; a collection of independent one-to-one sessions is not automatically an MLS group.

### OpenMLS

[`openmls`](https://github.com/openmls/openmls) implements RFC 9420 and is MIT-licensed. It is the preferred group-DM candidate once its JavaScript boundary is production-ready.

Current blockers:

- The repository describes its WebAssembly wrapper as experimental and minimal.
- LawyerCord would need to own, build, pin, package, and test a Rust/WASM bridge rather than consuming a supported JavaScript package.
- Group state, key packages, welcomes, commits, fork resolution, removals, and durable encrypted storage all need Discord-specific delivery rules and interoperability fixtures.

## Required migration behavior

1. Assign every local installation a stable device ID protected by Electron `safeStorage`.
2. Publish signed per-device key packages without replacing the v1 account fingerprint.
3. Require explicit device verification and display device additions, removals, and key changes.
4. Dual-read `PCEM1` and the new prefix while sending v2 only after all selected devices advertise support.
5. Persist ratchet or MLS group state transactionally before acknowledging a received message.
6. Prevent rollback to v1 after a conversation is upgraded unless the user performs an explicit safety reset.
7. Preserve historical v1 decryption without using v1 identity keys for new v2 sessions.
8. Pass official protocol vectors, multi-device offline delivery, simultaneous initiation, skipped-message, replay, key-change, removal, and post-compromise recovery tests.
9. Obtain an independent review before marking forward secrecy active in the control panel.

Until those conditions are met, the dashboard reports forward secrecy as inactive and the existing fail-closed v1 behavior remains unchanged.
