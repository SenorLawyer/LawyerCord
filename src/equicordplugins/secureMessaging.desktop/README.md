# Secure Messaging

Secure Messaging adds opt-in encrypted messages, stickers, GIF-picker links, and ordinary file attachments to Discord DMs and group DMs. A conversation remains ordinary Discord until the local user verifies at least one participant key and explicitly enables encryption for a selected recipient set.

## Protocol (version 1)

- Each Discord account has an Ed25519 signing key and an X25519 HPKE key pair.
- A message uses a fresh random AES-256-GCM content key and nonce.
- The content key is wrapped independently for every selected recipient, and for the sender, with RFC 9180 HPKE (`DHKEM(X25519, HKDF-SHA256)`, HKDF-SHA256, AES-128-GCM).
- The sender signs the complete canonical envelope with Ed25519. The signature binds the version, message UUID, Discord channel and author, timestamp, persistent counter, sender fingerprint, ordered recipient set, wrapped keys, nonce, and content ciphertext.
- Every attached file is encrypted locally with an independently derived AES-256-GCM key and nonce. The signed message plaintext contains only a compact encrypted bundle descriptor; file bytes and private metadata stay in opaque Discord attachments. An ordered aggregate digest binds the exact ciphertext attachment set to the descriptor.
- Sticker IDs, names, and formats are carried inside the authenticated encrypted payload and reconstructed only for Discord's local native sticker renderer. GIF-picker URLs are encrypted as message text and reconstructed through the native embed renderer.
- The privileged native helper resolves recipients only through its persistent verified-key store. The receiver validates the Discord author/channel binding, pinned sender fingerprint, signature, AEAD tag, recipient entry, and persistent replay state before rendering plaintext.
- Private key material and counters are stored in an encrypted vault protected by Electron `safeStorage`. The plugin refuses to operate if secure OS storage is unavailable, including Linux's `basic_text` backend.

After the vault is validated, a decrypted copy is cached in the trusted Electron main process to avoid a disk and operating-system key-store round trip on every message. Identity keys therefore remain in main-process memory for the lifetime of Discord. The renderer API cannot export them, but malicious code already running in the main process remains outside the threat model.

Key fingerprints bind the Discord user ID and both public keys. Users must compare the full fingerprint through a channel outside the Discord conversation before trusting it. A changed key is never accepted silently and disables affected conversation configuration until it is explicitly verified again.

The client processes key announcements from Discord message events and loaded history independently of whether their React accessory is visible. Key-change quarantine is persisted before protected sends can resume. The exact Discord announcement publication time orders replacements, so replaying an older valid announcement cannot displace a newer verified key.

## Safety properties and limits

After fingerprints are compared and endpoints remain uncompromised, version 1 protects message text from Discord and from unselected chat participants and detects ciphertext modification, sender substitution, and channel copying. It also rejects conflicting envelope UUIDs/counters and exact recorded-envelope replay while the persistent bounded replay record (the latest 4,096 accepted envelopes per local account) is retained.

The encrypted vault retains at most four retired local private identities and four retired verified public identities per peer so authenticated historical messages remain readable after rotation. Historical-key acceptance is bounded by the Discord message snowflake, edit timestamp, signed envelope time, and the persisted retirement cutoff; newly posted or newly edited stale-key messages are rejected. Peer key-change cutoffs use Discord's authoritative announcement metadata. Local identity rotation and voluntary forget have no corresponding Discord server event, so their history cutoff relies on the operating-system clock.

Version 1 is intentionally described as **non-ratcheting E2EE**. Static recipient-key compromise can expose previously recorded version 1 messages addressed to that key, and the protocol does not heal automatically after compromise. A future protocol upgrade should use an audited MLS implementation for forward secrecy and post-compromise security rather than adding a custom ratchet.

The evaluated provider choices, licensing boundary, device model, dual-read migration, and test gate are documented in [PROTOCOL_V2.md](./PROTOCOL_V2.md). LawyerCord does not claim forward secrecy until that gate is satisfied.

The protocol does not hide Discord metadata such as channel membership, sender, timing, message and attachment ciphertext sizes, attachment counts, recipient identifiers, reply relationships, or traffic patterns. It does not encrypt reactions, calls, or notifications. Normal link and GIF previews require disclosing the extracted URL to Discord's unfurl service, while displaying a sticker requests its asset ID from Discord's media CDN; the encrypted message body remains ciphertext. Unsupported send paths are blocked where practical when a conversation is enabled. Discord retains the message and attachment ciphertext. The plugin refuses to decrypt until Electron has applied operating-system screen-capture protection to every Discord window, including future popouts. That mitigates compliant screenshot, recorder, and screenshare APIs; it cannot stop a camera, a modified build, or malicious endpoint code. A compromised endpoint, Discord renderer, malicious client plugin, keylogger, or clipboard monitor can still access plaintext while the user can see it.

## Operational rules

- Encryption is supported only in one-to-one DMs and group DMs.
- The cryptographic recipient set is explicit and can be smaller than the Discord group.
- A Discord group membership change stops encrypted sends until the user reviews and saves the current participant snapshot.
- Participant/key changes set a persistent review-required latch. Background sends remain blocked even if Discord has evicted the channel from its renderer cache, until the user explicitly reviews and saves or disables the conversation.
- Encryption, key-review, listener, or storage errors cancel the send; they never fall back to plaintext. A guarded Discord REST path also covers built-in programmatic sends and blocks programmatic edits, unauthorized attachment reservations, and unsupported non-text sends while the plugin is active.
- Screen-capture protection is mandatory while the plugin is active. Protected sends remain blocked and encrypted content remains hidden unless every current window accepted the operating-system protection request; failures creating or protecting future windows make subsequent decryptions fail closed.
- Only exact, bounded-lifetime, one-use ciphertext/key payloads and opaque attachment reservations produced by Secure Messaging can pass the protected REST backstop. A forged `PCEM1:`/`PCEK1:` prefix is not authorization.
- Up to 10 ordinary files, 100 MiB each and 200 MiB total, are supported per encrypted message. Files are fully authenticated and decrypted before display, cached only in memory, exposed to Discord's native image/video/audio/file renderer through revocable local blob URLs, and never streamed before authentication succeeds.
- Normal edits of protected messages are blocked in version 1. Send a correction as a new encrypted message.
- Plaintext is kept in component memory for display and is not written to Discord's message store or plugin settings.

Client code with direct access to Discord's network stack can deliberately bypass any client-side guard, so other installed plugins remain part of the trusted endpoint. This code and its tests provide implementation evidence, not a formal proof or independent security audit.
