/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { decodeBase64Url, encodeBase64Url, isSnowflake } from "./protocol";

export const ATTACHMENT_PAYLOAD_PREFIX = "PCEA1:";
export const RICH_CONTENT_PAYLOAD_PREFIX = "PCER1:";
export const ENCRYPTED_ATTACHMENT_EXTENSION = ".pcaf";
export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_STICKER_COUNT = 3;

const ATTACHMENT_VERSION = 1 as const;
const BASE64URL_16 = /^[A-Za-z0-9_-]{22}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const MAX_ATTACHMENT_METADATA_BYTES = 8 * 1024;
export const MAX_ATTACHMENT_CIPHERTEXT_BYTES = MAX_ATTACHMENT_BYTES + MAX_ATTACHMENT_METADATA_BYTES + 20;
export const MAX_TOTAL_ATTACHMENT_CIPHERTEXT_BYTES = MAX_TOTAL_ATTACHMENT_BYTES + MAX_ATTACHMENT_COUNT * (MAX_ATTACHMENT_METADATA_BYTES + 20);
const ATTACHMENT_KDF_PREFIX = new TextEncoder().encode("ProtonnCord/SecureMessaging/v1/attachment-kdf\0");

export interface AttachmentBundleDescriptor {
    count: number;
    id: string;
    key: string;
    root: string;
}

export interface AttachmentMetadata {
    description: string | null;
    duration: number | null;
    height: number | null;
    mimeType: string;
    name: string;
    size: number;
    spoiler: boolean;
    width: number | null;
}

export interface SecurePlaintext {
    attachments: AttachmentBundleDescriptor | null;
    stickers: SecureStickerItem[];
    text: string;
}

export interface SecureStickerItem {
    formatType: number;
    id: string;
    name: string;
}

interface SerializedAttachmentMetadata {
    v: typeof ATTACHMENT_VERSION;
    n: string;
    m: string;
    s: number;
    p: boolean;
    d: string | null;
    w: number | null;
    h: number | null;
    t: number | null;
}

interface SerializedSecurePlaintext {
    v: typeof ATTACHMENT_VERSION;
    m: string;
    a: null | {
        i: string;
        k: string;
        c: number;
        r: string;
    };
}

interface SerializedRichSecurePlaintext extends SerializedSecurePlaintext {
    s: Array<{
        i: string;
        n: string;
        f: number;
    }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const sortedExpected = [...expected].sort();
    return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function validateSticker(sticker: SecureStickerItem): void {
    if (!isSnowflake(sticker.id) || typeof sticker.name !== "string" || sticker.name.length < 1 ||
        sticker.name.length > 100 || sticker.name.includes("\0") ||
        !Number.isInteger(sticker.formatType) || sticker.formatType < 1 || sticker.formatType > 4)
        throw new Error("Secure sticker item is invalid");
}

function validateStickers(stickers: SecureStickerItem[]): void {
    if (!Array.isArray(stickers) || stickers.length > MAX_STICKER_COUNT) throw new Error("Secure sticker list is invalid");
    const ids = new Set<string>();
    for (const sticker of stickers) {
        validateSticker(sticker);
        if (ids.has(sticker.id)) throw new Error("Secure sticker list contains duplicates");
        ids.add(sticker.id);
    }
}

function concatBytes(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
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

function uint32(value: number): Uint8Array {
    const result = new Uint8Array(4);
    new DataView(result.buffer).setUint32(0, value);
    return result;
}

function canonicalMetadata(metadata: AttachmentMetadata): SerializedAttachmentMetadata {
    validateAttachmentMetadata(metadata);
    return {
        v: ATTACHMENT_VERSION,
        n: metadata.name,
        m: metadata.mimeType,
        s: metadata.size,
        p: metadata.spoiler,
        d: metadata.description,
        w: metadata.width,
        h: metadata.height,
        t: metadata.duration,
    };
}

function attachmentAad(channelId: string, senderUserId: string, bundleId: string, index: number, count: number): Uint8Array {
    if (!isSnowflake(channelId) || !isSnowflake(senderUserId)) throw new Error("Attachment channel or sender is invalid");
    validateBundleId(bundleId);
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isInteger(count) || count < 1 || count > MAX_ATTACHMENT_COUNT)
        throw new Error("Attachment position is invalid");
    return new TextEncoder().encode(JSON.stringify({ v: ATTACHMENT_VERSION, c: channelId, s: senderUserId, b: bundleId, i: index, n: count }));
}

async function attachmentKeyAndNonce(masterKey: Uint8Array, bundleId: string, aad: Uint8Array): Promise<{ key: CryptoKey; nonce: Uint8Array; }> {
    if (masterKey.byteLength !== 32) throw new Error("Attachment bundle key is invalid");
    const material = await crypto.subtle.importKey("raw", cryptoBytes(masterKey), "HKDF", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({
        name: "HKDF",
        hash: "SHA-256",
        salt: cryptoBytes(decodeBase64Url(bundleId, 16)),
        info: cryptoBytes(concatBytes(ATTACHMENT_KDF_PREFIX, aad)),
    }, material, 352));
    const keyBytes = bits.slice(0, 32);
    const nonce = bits.slice(32);
    try {
        return {
            key: await crypto.subtle.importKey("raw", cryptoBytes(keyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
            nonce,
        };
    } finally {
        bits.fill(0);
        keyBytes.fill(0);
    }
}

function validateBundleId(value: string): void {
    if (!BASE64URL_16.test(value)) throw new Error("Attachment bundle ID is invalid");
    decodeBase64Url(value, 16);
}

function validateBundleDescriptor(bundle: AttachmentBundleDescriptor): void {
    validateBundleId(bundle.id);
    if (!Number.isInteger(bundle.count) || bundle.count < 1 || bundle.count > MAX_ATTACHMENT_COUNT)
        throw new Error("Attachment bundle count is invalid");
    if (!BASE64URL_32.test(bundle.key) || !BASE64URL_32.test(bundle.root))
        throw new Error("Attachment bundle key or root is invalid");
    decodeBase64Url(bundle.key, 32);
    decodeBase64Url(bundle.root, 32);
}

function optionalDimension(value: unknown): value is number | null {
    return value === null || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 32_768);
}

function optionalDuration(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 604_800);
}

function validDimensions(width: number, height: number): { height: number; width: number; } | null {
    return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 32_768 && height <= 32_768
        ? { height, width }
        : null;
}

export function encodedImageDimensions(bytes: Uint8Array): { height: number; width: number; } | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a)
        return validDimensions(view.getUint32(16), view.getUint32(20));
    if (bytes.byteLength >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
        return validDimensions(view.getUint16(6, true), view.getUint16(8, true));
    if (bytes.byteLength >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
            const width = 1 + bytes[24] + bytes[25] * 0x100 + bytes[26] * 0x1_0000;
            const height = 1 + bytes[27] + bytes[28] * 0x100 + bytes[29] * 0x1_0000;
            return validDimensions(width, height);
        }
        if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c && bytes[20] === 0x2f) {
            const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
            const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
            return validDimensions(width, height);
        }
        if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20 &&
            bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
            return validDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 8 < bytes.byteLength) {
            if (bytes[offset] !== 0xff) {
                offset++;
                continue;
            }
            while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
            if (offset >= bytes.byteLength) break;
            const marker = bytes[offset++];
            if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (offset + 2 > bytes.byteLength) break;
            const length = view.getUint16(offset);
            if (length < 2 || offset + length > bytes.byteLength) break;
            const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
            if (isStartOfFrame && length >= 7)
                return validDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
            offset += length;
        }
    }
    return null;
}

export function validateAttachmentMetadata(metadata: AttachmentMetadata): void {
    if (typeof metadata.name !== "string" || metadata.name.length < 1 || metadata.name.length > 255 || /[\0-\x1f\\/]/u.test(metadata.name))
        throw new Error("Attachment name is invalid");
    if (typeof metadata.mimeType !== "string" || metadata.mimeType.length > 255 || /[^\x20-\x7e]/u.test(metadata.mimeType))
        throw new Error("Attachment MIME type is invalid");
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_ATTACHMENT_BYTES)
        throw new Error("Attachment size is invalid");
    if (typeof metadata.spoiler !== "boolean" ||
        (metadata.description !== null && (typeof metadata.description !== "string" || metadata.description.length > 1_024 || metadata.description.includes("\0"))) ||
        !optionalDimension(metadata.width) || !optionalDimension(metadata.height) || !optionalDuration(metadata.duration))
        throw new Error("Attachment metadata is invalid");
    if ((metadata.width === null) !== (metadata.height === null)) throw new Error("Attachment dimensions are incomplete");
}

export function generateAttachmentBundleMaterial(count: number): { descriptor: Omit<AttachmentBundleDescriptor, "root">; keyBytes: Uint8Array; } {
    if (!Number.isInteger(count) || count < 1 || count > MAX_ATTACHMENT_COUNT) throw new Error("Attachment count is invalid");
    const idBytes = crypto.getRandomValues(new Uint8Array(16));
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    return {
        descriptor: { count, id: encodeBase64Url(idBytes), key: encodeBase64Url(keyBytes) },
        keyBytes,
    };
}

export function encryptedAttachmentFilename(bundleId: string, index: number): string {
    validateBundleId(bundleId);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ATTACHMENT_COUNT) throw new Error("Attachment index is invalid");
    return `pc-${bundleId}-${index}${ENCRYPTED_ATTACHMENT_EXTENSION}`;
}

export async function encryptAttachmentBytes(input: {
    bundleId: string;
    channelId: string;
    count: number;
    data: Uint8Array;
    index: number;
    masterKey: Uint8Array;
    metadata: AttachmentMetadata;
    senderUserId: string;
}): Promise<Uint8Array> {
    validateAttachmentMetadata(input.metadata);
    if (input.data.byteLength !== input.metadata.size) throw new Error("Attachment byte length does not match its metadata");
    const metadataBytes = new TextEncoder().encode(JSON.stringify(canonicalMetadata(input.metadata)));
    if (metadataBytes.byteLength > MAX_ATTACHMENT_METADATA_BYTES) throw new Error("Attachment metadata is too large");
    const aad = attachmentAad(input.channelId, input.senderUserId, input.bundleId, input.index, input.count);
    const { key, nonce } = await attachmentKeyAndNonce(input.masterKey, input.bundleId, aad);
    const plaintext = concatBytes(uint32(metadataBytes.byteLength), metadataBytes, input.data);
    try {
        const encrypted = await crypto.subtle.encrypt({
            name: "AES-GCM",
            iv: cryptoBytes(nonce),
            additionalData: cryptoBytes(aad),
            tagLength: 128,
        }, key, plaintext.buffer);
        return new Uint8Array(encrypted);
    } finally {
        plaintext.fill(0);
    }
}

export async function decryptAttachmentBytes(input: {
    bundleId: string;
    channelId: string;
    ciphertext: Uint8Array;
    count: number;
    index: number;
    masterKey: Uint8Array;
    senderUserId: string;
}): Promise<{ data: Uint8Array; metadata: AttachmentMetadata; }> {
    if (input.ciphertext.byteLength < 21 || input.ciphertext.byteLength > MAX_ATTACHMENT_CIPHERTEXT_BYTES)
        throw new Error("Encrypted attachment size is invalid");
    const aad = attachmentAad(input.channelId, input.senderUserId, input.bundleId, input.index, input.count);
    const { key, nonce } = await attachmentKeyAndNonce(input.masterKey, input.bundleId, aad);
    let plaintext: Uint8Array;
    try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({
            name: "AES-GCM",
            iv: cryptoBytes(nonce),
            additionalData: cryptoBytes(aad),
            tagLength: 128,
        }, key, cryptoBytes(input.ciphertext)));
    } catch {
        throw new Error("Encrypted attachment authentication failed");
    }
    try {
        if (plaintext.byteLength < 5) throw new Error("Encrypted attachment is malformed");
        const metadataLength = new DataView(plaintext.buffer, plaintext.byteOffset, 4).getUint32(0);
        if (metadataLength < 1 || metadataLength > MAX_ATTACHMENT_METADATA_BYTES || 4 + metadataLength >= plaintext.byteLength)
            throw new Error("Encrypted attachment metadata length is invalid");
        const metadataJson = new TextDecoder("utf-8", { fatal: true }).decode(plaintext.subarray(4, 4 + metadataLength));
        const value = JSON.parse(metadataJson) as unknown;
        if (!isRecord(value) || !hasExactKeys(value, ["v", "n", "m", "s", "p", "d", "w", "h", "t"]) ||
            value.v !== ATTACHMENT_VERSION || typeof value.n !== "string" || typeof value.m !== "string" ||
            typeof value.s !== "number" || typeof value.p !== "boolean" ||
            (value.d !== null && typeof value.d !== "string") || !optionalDimension(value.w) ||
            !optionalDimension(value.h) || !optionalDuration(value.t))
            throw new Error("Encrypted attachment metadata is invalid");
        const metadata: AttachmentMetadata = {
            name: value.n,
            mimeType: value.m,
            size: value.s,
            spoiler: value.p,
            description: value.d,
            width: value.w,
            height: value.h,
            duration: value.t,
        };
        validateAttachmentMetadata(metadata);
        if (JSON.stringify(canonicalMetadata(metadata)) !== metadataJson)
            throw new Error("Encrypted attachment metadata is not canonical");
        const data = plaintext.slice(4 + metadataLength);
        if (data.byteLength !== metadata.size) throw new Error("Encrypted attachment content length is invalid");
        return { data, metadata };
    } finally {
        plaintext.fill(0);
    }
}

export async function attachmentBundleRoot(bundleId: string, ciphertexts: Uint8Array[]): Promise<string> {
    validateBundleId(bundleId);
    if (ciphertexts.length < 1 || ciphertexts.length > MAX_ATTACHMENT_COUNT) throw new Error("Attachment count is invalid");
    const digests = await Promise.all(ciphertexts.map(async ciphertext => new Uint8Array(await crypto.subtle.digest("SHA-256", cryptoBytes(ciphertext)))));
    const root = await crypto.subtle.digest("SHA-256", cryptoBytes(concatBytes(
        new TextEncoder().encode("ProtonnCord/SecureMessaging/v1/attachment-root\0"),
        decodeBase64Url(bundleId, 16),
        uint32(ciphertexts.length),
        ...digests,
    )));
    return encodeBase64Url(root);
}

export function serializeSecurePlaintext(
    text: string,
    attachments: AttachmentBundleDescriptor | null = null,
    stickers: SecureStickerItem[] = [],
): string {
    if (typeof text !== "string" || text.length > 2_000) throw new Error("Secure message text is invalid");
    validateStickers(stickers);
    if (attachments === null && stickers.length === 0 &&
        !text.startsWith(ATTACHMENT_PAYLOAD_PREFIX) && !text.startsWith(RICH_CONTENT_PAYLOAD_PREFIX)) return text;
    if (attachments) validateBundleDescriptor(attachments);
    const value: SerializedSecurePlaintext = {
        v: ATTACHMENT_VERSION,
        m: text,
        a: attachments ? { i: attachments.id, k: attachments.key, c: attachments.count, r: attachments.root } : null,
    };
    if (stickers.length > 0) {
        const richValue: SerializedRichSecurePlaintext = {
            ...value,
            s: stickers.map(sticker => ({ i: sticker.id, n: sticker.name, f: sticker.formatType })),
        };
        return `${RICH_CONTENT_PAYLOAD_PREFIX}${JSON.stringify(richValue)}`;
    }
    return `${ATTACHMENT_PAYLOAD_PREFIX}${JSON.stringify(value)}`;
}

export function parseSecurePlaintext(value: string): SecurePlaintext {
    if (typeof value !== "string") throw new Error("Secure plaintext is invalid");
    const rich = value.startsWith(RICH_CONTENT_PAYLOAD_PREFIX);
    if (!rich && !value.startsWith(ATTACHMENT_PAYLOAD_PREFIX)) return { text: value, attachments: null, stickers: [] };
    const prefix = rich ? RICH_CONTENT_PAYLOAD_PREFIX : ATTACHMENT_PAYLOAD_PREFIX;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value.slice(prefix.length));
    } catch {
        throw new Error("Secure content payload is malformed");
    }
    if (!isRecord(parsed) || !hasExactKeys(parsed, rich ? ["v", "m", "a", "s"] : ["v", "m", "a"]) ||
        parsed.v !== ATTACHMENT_VERSION || typeof parsed.m !== "string")
        throw new Error("Secure content payload is invalid");
    let attachments: AttachmentBundleDescriptor | null = null;
    if (parsed.a !== null) {
        if (!isRecord(parsed.a) || !hasExactKeys(parsed.a, ["i", "k", "c", "r"]) ||
            typeof parsed.a.i !== "string" || typeof parsed.a.k !== "string" ||
            typeof parsed.a.c !== "number" || typeof parsed.a.r !== "string")
            throw new Error("Secure attachment bundle is invalid");
        attachments = { id: parsed.a.i, key: parsed.a.k, count: parsed.a.c, root: parsed.a.r };
        validateBundleDescriptor(attachments);
    }
    const stickers: SecureStickerItem[] = [];
    if (rich) {
        if (!Array.isArray(parsed.s)) throw new Error("Secure sticker list is invalid");
        for (const sticker of parsed.s) {
            if (!isRecord(sticker) || !hasExactKeys(sticker, ["i", "n", "f"]) ||
                typeof sticker.i !== "string" || typeof sticker.n !== "string" || typeof sticker.f !== "number")
                throw new Error("Secure sticker item is invalid");
            stickers.push({ id: sticker.i, name: sticker.n, formatType: sticker.f });
        }
        validateStickers(stickers);
        if (stickers.length === 0) throw new Error("Secure rich content requires a sticker");
    }
    const canonical: SerializedSecurePlaintext | SerializedRichSecurePlaintext = {
        v: ATTACHMENT_VERSION,
        m: parsed.m,
        a: attachments ? { i: attachments.id, k: attachments.key, c: attachments.count, r: attachments.root } : null,
        ...(rich ? { s: stickers.map(sticker => ({ i: sticker.id, n: sticker.name, f: sticker.formatType })) } : {}),
    };
    if (JSON.stringify(canonical) !== value.slice(prefix.length)) throw new Error("Secure content payload is not canonical");
    return { text: parsed.m, attachments, stickers };
}
