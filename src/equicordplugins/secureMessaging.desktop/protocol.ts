/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const KEY_ANNOUNCEMENT_PREFIX = "PCEK1:";
export const ENCRYPTED_MESSAGE_PREFIX = "PCEM1:";
export const PROTOCOL_VERSION = 1 as const;
export const MAX_DISCORD_MESSAGE_LENGTH = 2_000;
export const MAX_SELECTED_RECIPIENTS = 24;

const SNOWFLAKE = /^\d{17,20}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_48 = /^[A-Za-z0-9_-]{64}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

export interface PrivateIdentity {
    createdAt: number;
    hpkePrivateKey: string;
    hpkePublicKey: string;
    signingPrivateKey: string;
    signingPublicKey: string;
}

export interface PublicIdentity {
    fingerprint: string;
    hpkePublicKey: string;
    signingPublicKey: string;
    userId: string;
}

export interface UnsignedKeyAnnouncement {
    v: typeof PROTOCOL_VERSION;
    t: "k";
    u: string;
    d: number;
    s: string;
    e: string;
}

export interface KeyAnnouncement extends UnsignedKeyAnnouncement {
    z: string;
}

export interface WrappedContentKey {
    u: string;
    e: string;
    x: string;
}

export interface UnsignedEncryptedEnvelope {
    v: typeof PROTOCOL_VERSION;
    t: "m";
    i: string;
    c: string;
    s: string;
    d: number;
    q: number;
    k: string;
    r: WrappedContentKey[];
    n: string;
    x: string;
}

export interface EncryptedEnvelope extends UnsignedEncryptedEnvelope {
    z: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function isProtocolTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1_700_000_000_000 && (value as number) <= 9_999_999_999_999;
}

export function isEnvelopeId(value: unknown): value is string {
    return typeof value === "string" && UUID.test(value);
}

export function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && SNOWFLAKE.test(value);
}

export function requireSnowflake(value: unknown, field: string): string {
    if (!isSnowflake(value)) throw new Error(`${field} must be a Discord snowflake`);
    return value;
}

export function encodeBase64Url(value: ArrayBufferLike | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string, expectedBytes?: number): Uint8Array {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value");
    if (expectedBytes !== undefined && value.length !== Math.ceil(expectedBytes * 8 / 6))
        throw new Error(`Expected ${expectedBytes} decoded bytes`);
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    let binary: string;
    try {
        binary = atob(padded);
    } catch {
        throw new Error("Invalid base64url value");
    }
    const result = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (expectedBytes !== undefined && result.byteLength !== expectedBytes)
        throw new Error(`Expected ${expectedBytes} decoded bytes`);
    if (encodeBase64Url(result) !== value) throw new Error("Non-canonical base64url value");
    return result;
}

function isCanonicalBase64Url(value: unknown, expectedBytes: number): value is string {
    if (typeof value !== "string") return false;
    try {
        decodeBase64Url(value, expectedBytes);
        return true;
    } catch {
        return false;
    }
}

function isCanonicalVariableBase64Url(value: unknown, minimumBytes: number, maximumCharacters: number): value is string {
    if (typeof value !== "string" || value.length > maximumCharacters || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
    try {
        return decodeBase64Url(value).byteLength >= minimumBytes;
    } catch {
        return false;
    }
}

function parseJsonAfterPrefix(content: string, prefix: string): unknown {
    if (typeof content !== "string" || content.length > MAX_DISCORD_MESSAGE_LENGTH || !content.startsWith(prefix))
        throw new Error("Unsupported secure-message payload");
    try {
        return JSON.parse(content.slice(prefix.length));
    } catch {
        throw new Error("Malformed secure-message JSON");
    }
}

export function isKeyAnnouncement(content: unknown): content is string {
    return typeof content === "string" && content.startsWith(KEY_ANNOUNCEMENT_PREFIX);
}

export function isEncryptedMessage(content: unknown): content is string {
    return typeof content === "string" && content.startsWith(ENCRYPTED_MESSAGE_PREFIX);
}

export function parseKeyAnnouncement(content: string): KeyAnnouncement {
    const value = parseJsonAfterPrefix(content, KEY_ANNOUNCEMENT_PREFIX);
    if (!isRecord(value) || !hasExactKeys(value, ["v", "t", "u", "d", "s", "e", "z"]))
        throw new Error("Malformed key announcement");
    if (value.v !== PROTOCOL_VERSION || value.t !== "k" || !isSnowflake(value.u) || !isProtocolTimestamp(value.d) ||
        typeof value.s !== "string" || !BASE64URL_32.test(value.s) || !isCanonicalBase64Url(value.s, 32) ||
        typeof value.e !== "string" || !BASE64URL_32.test(value.e) || !isCanonicalBase64Url(value.e, 32) ||
        typeof value.z !== "string" || !BASE64URL_64.test(value.z) || !isCanonicalBase64Url(value.z, 64))
        throw new Error("Invalid key announcement fields");
    const announcement = value as unknown as KeyAnnouncement;
    if (JSON.stringify(announcement) !== content.slice(KEY_ANNOUNCEMENT_PREFIX.length))
        throw new Error("Key announcement is not canonically encoded");
    return announcement;
}

export function parseEncryptedEnvelope(content: string): EncryptedEnvelope {
    const value = parseJsonAfterPrefix(content, ENCRYPTED_MESSAGE_PREFIX);
    if (!isRecord(value) || !hasExactKeys(value, ["v", "t", "i", "c", "s", "d", "q", "k", "r", "n", "x", "z"]))
        throw new Error("Malformed encrypted envelope");
    if (value.v !== PROTOCOL_VERSION || value.t !== "m" || !isEnvelopeId(value.i) ||
        !isSnowflake(value.c) || !isSnowflake(value.s) || !isProtocolTimestamp(value.d) ||
        !Number.isSafeInteger(value.q) || (value.q as number) < 1 ||
        typeof value.k !== "string" || !BASE64URL_32.test(value.k) || !isCanonicalBase64Url(value.k, 32) ||
        !isCanonicalBase64Url(value.n, 12) || !isCanonicalVariableBase64Url(value.x, 17, MAX_DISCORD_MESSAGE_LENGTH) ||
        typeof value.z !== "string" || !BASE64URL_64.test(value.z) || !isCanonicalBase64Url(value.z, 64) || !Array.isArray(value.r) ||
        value.r.length < 1 || value.r.length > MAX_SELECTED_RECIPIENTS + 1)
        throw new Error("Invalid encrypted envelope fields");

    const recipients = value.r as unknown[];
    let previousUserId = "";
    for (const recipient of recipients) {
        if (!isRecord(recipient) || !hasExactKeys(recipient, ["u", "e", "x"]) || !isSnowflake(recipient.u) ||
            typeof recipient.e !== "string" || !BASE64URL_32.test(recipient.e) || !isCanonicalBase64Url(recipient.e, 32) ||
            typeof recipient.x !== "string" || !BASE64URL_48.test(recipient.x) || !isCanonicalBase64Url(recipient.x, 48) ||
            recipient.u <= previousUserId)
            throw new Error("Invalid or unsorted encrypted recipient entry");
        previousUserId = recipient.u;
    }
    const envelope = value as unknown as EncryptedEnvelope;
    if (JSON.stringify(envelope) !== content.slice(ENCRYPTED_MESSAGE_PREFIX.length))
        throw new Error("Encrypted envelope is not canonically encoded");
    return envelope;
}

export function canonicalKeyAnnouncement(value: UnsignedKeyAnnouncement): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
        v: value.v,
        t: value.t,
        u: value.u,
        d: value.d,
        s: value.s,
        e: value.e,
    }));
}

export function envelopeHeader(value: Pick<UnsignedEncryptedEnvelope, "v" | "t" | "i" | "c" | "s" | "d" | "q" | "k" | "r">): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
        v: value.v,
        t: value.t,
        i: value.i,
        c: value.c,
        s: value.s,
        d: value.d,
        q: value.q,
        k: value.k,
        r: value.r.map(recipient => recipient.u),
    }));
}

export function canonicalEncryptedEnvelope(value: UnsignedEncryptedEnvelope): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
        v: value.v,
        t: value.t,
        i: value.i,
        c: value.c,
        s: value.s,
        d: value.d,
        q: value.q,
        k: value.k,
        r: value.r.map(recipient => ({ u: recipient.u, e: recipient.e, x: recipient.x })),
        n: value.n,
        x: value.x,
    }));
}

export function serializeKeyAnnouncement(value: KeyAnnouncement): string {
    const serialized = `${KEY_ANNOUNCEMENT_PREFIX}${JSON.stringify(value)}`;
    if (serialized.length > MAX_DISCORD_MESSAGE_LENGTH) throw new Error("Key announcement exceeds Discord's message limit");
    return serialized;
}

export function serializeEncryptedEnvelope(value: EncryptedEnvelope): string {
    const serialized = `${ENCRYPTED_MESSAGE_PREFIX}${JSON.stringify(value)}`;
    if (serialized.length > MAX_DISCORD_MESSAGE_LENGTH)
        throw new Error("Encrypted message exceeds Discord's 2,000 character limit; shorten the text or select fewer recipients");
    return serialized;
}
