/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 4 * 1024 * 1024;
export const MAX_TOTAL_PIXELS = 32 * 1024 * 1024;
export const MEDIA_TIMEOUT = 30_000;

export function validateDimensions(width: number, height: number) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 65535 || height > 65535 || width * height > MAX_SOURCE_PIXELS)
        throw new Error("Choose smaller media dimensions. Frames must contain at most 4 million pixels.");
}

export async function readMediaResponse(response: Response, signal?: AbortSignal): Promise<Blob> {
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Could not download the media.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
        signal?.throwIfAborted();
        if (Number(response.headers.get("content-length")) > MAX_MEDIA_BYTES)
            throw new Error("Media must be smaller than 50 MB.");
        while (true) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_MEDIA_BYTES) throw new Error("Media must be smaller than 50 MB.");
            chunks.push(new Uint8Array(value));
        }
    } finally {
        signal?.removeEventListener("abort", abort);
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }
    if (!size) throw new Error("The media file is empty.");
    return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
}
