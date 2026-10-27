/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    Aes128Gcm,
    CipherSuite,
    DhkemX25519HkdfSha256,
    HkdfSha256,
} from "@hpke/core";

import {
    canonicalEncryptedEnvelope,
    canonicalKeyAnnouncement,
    decodeBase64Url,
    encodeBase64Url,
    ENCRYPTED_MESSAGE_PREFIX,
    EncryptedEnvelope,
    envelopeHeader,
    isEnvelopeId,
    isProtocolTimestamp,
    KeyAnnouncement,
    MAX_DISCORD_MESSAGE_LENGTH,
    MAX_SELECTED_RECIPIENTS,
    parseEncryptedEnvelope,
    parseKeyAnnouncement,
    PrivateIdentity,
    PROTOCOL_VERSION,
    PublicIdentity,
    requireSnowflake,
    serializeEncryptedEnvelope,
    serializeKeyAnnouncement,
    UnsignedEncryptedEnvelope,
    UnsignedKeyAnnouncement,
    WrappedContentKey,
} from "./protocol";

const HPKE_INFO_PREFIX = new TextEncoder().encode("ProtonnCord/SecureMessaging/v1/HPKE-wrap\0");
const FINGERPRINT_PREFIX = new TextEncoder().encode("ProtonnCord/SecureMessaging/v1/fingerprint\0");
const IDENTITY_CHECK = new TextEncoder().encode("ProtonnCord/SecureMessaging/v1/identity-check");
const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
});

function concatBytes(...values: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
    let offset = 0;
    for (const value of values) {
        result.set(value, offset);
        offset += value.byteLength;
    }
    return result;
}

function cryptoBytes(value: Uint8Array): ArrayBuffer {
    return Uint8Array.from(value).buffer;
}

function unsignedEnvelope(envelope: EncryptedEnvelope): UnsignedEncryptedEnvelope {
    const { z: _signature, ...unsigned } = envelope;
    return unsigned;
}

function hpkeContext(header: Uint8Array, recipientId: string): Uint8Array {
    return concatBytes(HPKE_INFO_PREFIX, header, new TextEncoder().encode(`\0${recipientId}`));
}

async function importSigningPrivateKey(identity: PrivateIdentity): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "pkcs8",
        cryptoBytes(decodeBase64Url(identity.signingPrivateKey, 48)),
        { name: "Ed25519" },
        false,
        ["sign"]
    );
}

function assertIdentityEncoding(identity: PrivateIdentity): void {
    if (!identity || !isProtocolTimestamp(identity.createdAt)) throw new Error("Identity creation time is invalid");
    decodeBase64Url(identity.signingPrivateKey, 48);
    decodeBase64Url(identity.signingPublicKey, 32);
    decodeBase64Url(identity.hpkePrivateKey, 32);
    decodeBase64Url(identity.hpkePublicKey, 32);
}

export async function validateIdentityKeyPairs(identity: PrivateIdentity): Promise<void> {
    assertIdentityEncoding(identity);
    const [signature, signingPublicKey, hpkePrivateKey, hpkePublicKey] = await Promise.all([
        crypto.subtle.sign("Ed25519", await importSigningPrivateKey(identity), cryptoBytes(IDENTITY_CHECK)),
        importSigningPublicKey(identity.signingPublicKey),
        suite.kem.deserializePrivateKey(decodeBase64Url(identity.hpkePrivateKey, 32)),
        suite.kem.deserializePublicKey(decodeBase64Url(identity.hpkePublicKey, 32)),
    ]);
    const signingMatches = await crypto.subtle.verify(
        "Ed25519",
        signingPublicKey,
        signature,
        cryptoBytes(IDENTITY_CHECK)
    );
    if (!signingMatches) throw new Error("Identity signing key pair does not match");

    try {
        const sealedCheck = await suite.seal(
            { recipientPublicKey: hpkePublicKey, info: IDENTITY_CHECK },
            IDENTITY_CHECK,
            IDENTITY_CHECK
        );
        const openedCheck = new Uint8Array(await suite.open(
            { recipientKey: hpkePrivateKey, enc: sealedCheck.enc, info: IDENTITY_CHECK },
            sealedCheck.ct,
            IDENTITY_CHECK
        ));
        if (encodeBase64Url(openedCheck) !== encodeBase64Url(IDENTITY_CHECK))
            throw new Error("mismatch");
    } catch {
        throw new Error("Identity HPKE key pair does not match");
    }
}

async function importSigningPublicKey(publicKey: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", cryptoBytes(decodeBase64Url(publicKey, 32)), { name: "Ed25519" }, false, ["verify"]);
}

export async function generateIdentity(now = Date.now()): Promise<PrivateIdentity> {
    if (!isProtocolTimestamp(now)) throw new Error("Identity creation time is invalid");
    const [signingKeys, hpkeKeys] = await Promise.all([
        crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>,
        suite.kem.generateKeyPair(),
    ]);
    const [signingPrivateKey, signingPublicKey, hpkePrivateKey, hpkePublicKey] = await Promise.all([
        crypto.subtle.exportKey("pkcs8", signingKeys.privateKey),
        crypto.subtle.exportKey("raw", signingKeys.publicKey),
        suite.kem.serializePrivateKey(hpkeKeys.privateKey),
        suite.kem.serializePublicKey(hpkeKeys.publicKey),
    ]);
    return {
        createdAt: now,
        signingPrivateKey: encodeBase64Url(signingPrivateKey),
        signingPublicKey: encodeBase64Url(signingPublicKey),
        hpkePrivateKey: encodeBase64Url(hpkePrivateKey),
        hpkePublicKey: encodeBase64Url(hpkePublicKey),
    };
}

export async function fingerprintPublicKeys(userId: string, signingPublicKey: string, hpkePublicKey: string): Promise<string> {
    requireSnowflake(userId, "userId");
    const digest = await crypto.subtle.digest("SHA-256", cryptoBytes(concatBytes(
        FINGERPRINT_PREFIX,
        new TextEncoder().encode(`${userId}\0`),
        decodeBase64Url(signingPublicKey, 32),
        decodeBase64Url(hpkePublicKey, 32)
    )));
    return encodeBase64Url(digest);
}

export function formatFingerprint(fingerprint: string): string {
    const bytes = decodeBase64Url(fingerprint, 32);
    return [...bytes]
        .map(byte => byte.toString(16).padStart(2, "0").toUpperCase())
        .join("")
        .match(/.{1,4}/gu)!
        .join(" ");
}

export async function publicIdentity(identity: PrivateIdentity, userId: string): Promise<PublicIdentity> {
    requireSnowflake(userId, "userId");
    assertIdentityEncoding(identity);
    return {
        userId,
        signingPublicKey: identity.signingPublicKey,
        hpkePublicKey: identity.hpkePublicKey,
        fingerprint: await fingerprintPublicKeys(userId, identity.signingPublicKey, identity.hpkePublicKey),
    };
}

export async function createKeyAnnouncement(identity: PrivateIdentity, userId: string): Promise<string> {
    requireSnowflake(userId, "userId");
    assertIdentityEncoding(identity);
    const unsigned: UnsignedKeyAnnouncement = {
        v: PROTOCOL_VERSION,
        t: "k",
        u: userId,
        d: identity.createdAt,
        s: identity.signingPublicKey,
        e: identity.hpkePublicKey,
    };
    const signature = await crypto.subtle.sign("Ed25519", await importSigningPrivateKey(identity), cryptoBytes(canonicalKeyAnnouncement(unsigned)));
    return serializeKeyAnnouncement({ ...unsigned, z: encodeBase64Url(signature) });
}

export async function verifyKeyAnnouncement(content: string, discordAuthorId: string): Promise<PublicIdentity> {
    requireSnowflake(discordAuthorId, "discordAuthorId");
    const announcement = parseKeyAnnouncement(content);
    if (announcement.u !== discordAuthorId) throw new Error("Key announcement does not match its Discord author");
    const unsigned: UnsignedKeyAnnouncement = {
        v: announcement.v,
        t: announcement.t,
        u: announcement.u,
        d: announcement.d,
        s: announcement.s,
        e: announcement.e,
    };
    const valid = await crypto.subtle.verify(
        "Ed25519",
        await importSigningPublicKey(announcement.s),
        cryptoBytes(decodeBase64Url(announcement.z, 64)),
        cryptoBytes(canonicalKeyAnnouncement(unsigned))
    );
    if (!valid) throw new Error("Key announcement signature is invalid");
    return {
        userId: announcement.u,
        signingPublicKey: announcement.s,
        hpkePublicKey: announcement.e,
        fingerprint: await fingerprintPublicKeys(announcement.u, announcement.s, announcement.e),
    };
}

export interface EncryptMessageInput {
    channelId: string;
    identity: PrivateIdentity;
    plaintext: string;
    recipients: PublicIdentity[];
    senderUserId: string;
    now?: number;
    messageId?: string;
    counter: number;
}

export function envelopeFits(input: { channelId: string; counter: number; plaintext: string; recipientUserIds: string[]; senderUserId: string; }): boolean {
    const filler = (length: number) => "A".repeat(length);
    const ciphertextBytes = new TextEncoder().encode(input.plaintext).byteLength + 16;
    const envelope: EncryptedEnvelope = {
        v: PROTOCOL_VERSION, t: "m", i: filler(36), c: input.channelId, s: input.senderUserId, d: Date.now(), q: input.counter,
        k: filler(43),
        r: [...new Set([input.senderUserId, ...input.recipientUserIds])].map(u => ({ u, e: filler(43), x: filler(64) })),
        n: filler(16), x: filler(Math.ceil(ciphertextBytes * 4 / 3)), z: filler(86)
    };
    return ENCRYPTED_MESSAGE_PREFIX.length + JSON.stringify(envelope).length <= MAX_DISCORD_MESSAGE_LENGTH;
}

export async function encryptMessage(input: EncryptMessageInput): Promise<string> {
    const channelId = requireSnowflake(input.channelId, "channelId");
    const senderUserId = requireSnowflake(input.senderUserId, "senderUserId");
    assertIdentityEncoding(input.identity);
    if (typeof input.plaintext !== "string" || input.plaintext.length === 0 || input.plaintext.length > 2_000)
        throw new Error("plaintext must contain 1 to 2,000 characters");
    if (!Number.isSafeInteger(input.counter) || input.counter < 1) throw new Error("counter must be a positive safe integer");
    if (!Array.isArray(input.recipients) || input.recipients.length > MAX_SELECTED_RECIPIENTS)
        throw new Error(`recipients must contain at most ${MAX_SELECTED_RECIPIENTS} verified identities`);
    const now = input.now ?? Date.now();
    if (!isProtocolTimestamp(now)) throw new Error("now must be a valid protocol timestamp");
    const id = input.messageId ?? crypto.randomUUID();
    if (!isEnvelopeId(id)) throw new Error("messageId must be a UUID");

    const self = await publicIdentity(input.identity, senderUserId);
    const recipientMap = new Map<string, PublicIdentity>([[self.userId, self]]);
    for (const recipient of input.recipients) {
        requireSnowflake(recipient.userId, "recipient.userId");
        const expectedFingerprint = await fingerprintPublicKeys(recipient.userId, recipient.signingPublicKey, recipient.hpkePublicKey);
        if (recipient.fingerprint !== expectedFingerprint) throw new Error(`Recipient ${recipient.userId} has an invalid fingerprint`);
        const existing = recipientMap.get(recipient.userId);
        if (existing && existing.fingerprint !== recipient.fingerprint) throw new Error(`Conflicting keys for recipient ${recipient.userId}`);
        recipientMap.set(recipient.userId, recipient);
    }
    const recipients = [...recipientMap.values()].sort((left, right) => left.userId.localeCompare(right.userId));
    const skeletonRecipients: WrappedContentKey[] = recipients.map(recipient => ({ u: recipient.userId, e: "", x: "" }));
    const base = {
        v: PROTOCOL_VERSION,
        t: "m" as const,
        i: id,
        c: channelId,
        s: senderUserId,
        d: now,
        q: input.counter,
        k: self.fingerprint,
        r: skeletonRecipients,
    };
    const header = envelopeHeader(base);
    const contentKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));

    try {
        const wrappedRecipients = await Promise.all(recipients.map(async recipient => {
            const context = hpkeContext(header, recipient.userId);
            const recipientPublicKey = await suite.kem.deserializePublicKey(decodeBase64Url(recipient.hpkePublicKey, 32));
            const wrapped = await suite.seal({ recipientPublicKey, info: context }, contentKeyBytes, context);
            return {
                u: recipient.userId,
                e: encodeBase64Url(wrapped.enc),
                x: encodeBase64Url(wrapped.ct),
            } satisfies WrappedContentKey;
        }));
        const contentKey = await crypto.subtle.importKey("raw", cryptoBytes(contentKeyBytes), { name: "AES-GCM" }, false, ["encrypt"]);
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: cryptoBytes(nonce), additionalData: cryptoBytes(header), tagLength: 128 },
            contentKey,
            cryptoBytes(new TextEncoder().encode(input.plaintext))
        );
        const unsigned: UnsignedEncryptedEnvelope = {
            ...base,
            r: wrappedRecipients,
            n: encodeBase64Url(nonce),
            x: encodeBase64Url(ciphertext),
        };
        const signature = await crypto.subtle.sign(
            "Ed25519",
            await importSigningPrivateKey(input.identity),
            cryptoBytes(canonicalEncryptedEnvelope(unsigned))
        );
        return serializeEncryptedEnvelope({ ...unsigned, z: encodeBase64Url(signature) });
    } finally {
        contentKeyBytes.fill(0);
    }
}

export interface DecryptMessageInput {
    channelId: string;
    content: string;
    discordAuthorId: string;
    identity: PrivateIdentity;
    localUserId: string;
    senderIdentity: PublicIdentity;
}

export async function decryptMessage(input: DecryptMessageInput): Promise<{ envelope: EncryptedEnvelope; plaintext: string; }> {
    const channelId = requireSnowflake(input.channelId, "channelId");
    const discordAuthorId = requireSnowflake(input.discordAuthorId, "discordAuthorId");
    const localUserId = requireSnowflake(input.localUserId, "localUserId");
    assertIdentityEncoding(input.identity);
    const envelope = parseEncryptedEnvelope(input.content);
    if (envelope.c !== channelId) throw new Error("Encrypted message was copied from another channel");
    if (envelope.s !== discordAuthorId || input.senderIdentity.userId !== discordAuthorId)
        throw new Error("Encrypted message sender does not match its Discord author");
    if (envelope.k !== input.senderIdentity.fingerprint) throw new Error("Encrypted message uses an unverified sender key");
    const computedFingerprint = await fingerprintPublicKeys(
        input.senderIdentity.userId,
        input.senderIdentity.signingPublicKey,
        input.senderIdentity.hpkePublicKey
    );
    if (computedFingerprint !== input.senderIdentity.fingerprint) throw new Error("Trusted sender identity is malformed");

    const validSignature = await crypto.subtle.verify(
        "Ed25519",
        await importSigningPublicKey(input.senderIdentity.signingPublicKey),
        cryptoBytes(decodeBase64Url(envelope.z, 64)),
        cryptoBytes(canonicalEncryptedEnvelope(unsignedEnvelope(envelope)))
    );
    if (!validSignature) throw new Error("Encrypted message signature is invalid");

    const recipient = envelope.r.find(entry => entry.u === localUserId);
    if (!recipient) throw new Error("This device is not an encrypted-message recipient");
    const header = envelopeHeader(envelope);
    const context = hpkeContext(header, localUserId);
    const recipientKey = await suite.kem.deserializePrivateKey(decodeBase64Url(input.identity.hpkePrivateKey, 32));
    const contentKeyBytes = new Uint8Array(await suite.open({
        recipientKey,
        enc: decodeBase64Url(recipient.e, 32),
        info: context,
    }, decodeBase64Url(recipient.x), context));
    try {
        if (contentKeyBytes.byteLength !== 32) throw new Error("Invalid decrypted content key");
        const contentKey = await crypto.subtle.importKey("raw", cryptoBytes(contentKeyBytes), { name: "AES-GCM" }, false, ["decrypt"]);
        const plaintext = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: cryptoBytes(decodeBase64Url(envelope.n, 12)),
                additionalData: cryptoBytes(header),
                tagLength: 128,
            },
            contentKey,
            cryptoBytes(decodeBase64Url(envelope.x))
        );
        return { envelope, plaintext: new TextDecoder("utf-8", { fatal: true }).decode(plaintext) };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Encrypted message")) throw error;
        throw new Error("Encrypted message authentication failed");
    } finally {
        contentKeyBytes.fill(0);
    }
}

export function keyAnnouncementFromContent(content: string): KeyAnnouncement {
    return parseKeyAnnouncement(content);
}
