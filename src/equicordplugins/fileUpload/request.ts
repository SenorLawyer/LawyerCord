/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAX_FILE_BYTES = 2 * 1024 ** 3;
export const MAX_RESPONSE_BYTES = 1024 ** 2;

export function isUploadUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 8192) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
    } catch {
        return false;
    }
}

export async function readResponseBody(response: Response, maximum: number, signal: AbortSignal): Promise<Blob> {
    if (Number(response.headers.get("content-length")) > maximum) {
        await response.body?.cancel();
        throw new Error("The response exceeds the size limit.");
    }
    if (!response.body) return new Blob();
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        signal.throwIfAborted();
        for (;;) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maximum) {
                await reader.cancel();
                throw new Error("The response exceeds the size limit.");
            }
            chunks.push(value);
        }
        return new Blob(chunks, { type: response.headers.get("content-type") || "" });
    } finally {
        signal.removeEventListener("abort", cancel);
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }
}
