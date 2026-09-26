/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";

const allowedHosts = new Set([
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "media.discordapp.net"
]);

// Discord has very strict CORS rules for which types of assets can be fetched from where (CDN/Media proxy),
// and most binary file types are prohibited by both. This function serves as a simple bypass.
export async function fetchAttachment(_: IpcMainInvokeEvent, attachment: unknown) {
    const failure = { success: false as const, error: "Could not download this attachment." };
    if (!attachment || typeof attachment !== "object"
        || !("url" in attachment) || typeof attachment.url !== "string" || attachment.url.length > 8192
        || !("filename" in attachment) || typeof attachment.filename !== "string"
        || !attachment.filename.length || attachment.filename.length > 1024 || attachment.filename.includes("\0")) return failure;

    const contentType = "content_type" in attachment ? attachment.content_type : undefined;
    if (contentType !== undefined && (typeof contentType !== "string" || contentType.length > 256)) return failure;
    const url = URL.parse(attachment.url);
    if (!url || url.protocol !== "https:" || url.port || url.username || url.password || !allowedHosts.has(url.hostname)) return failure;

    const maxBytes = 500 * 1024 * 1024;
    try {
        const res = await fetch(url, { headers: { Accept: "*/*" }, redirect: "error", signal: AbortSignal.timeout(120_000) });
        if (!res.ok || !res.body || Number(res.headers.get("content-length")) > maxBytes) {
            await res.body?.cancel();
            return failure;
        }

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) {
                    await reader.cancel();
                    return failure;
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        return {
            success: true as const,
            type: res.headers.get("content-type") || contentType || "application/octet-stream",
            data: Buffer.concat(chunks, size),
            filename: attachment.filename
        };
    } catch {
        return failure;
    }
}
