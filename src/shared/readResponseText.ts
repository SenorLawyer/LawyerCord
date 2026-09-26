/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return text + decoder.decode();
            bytes += value.byteLength;
            if (bytes > maxBytes) throw new Error("Response exceeds the download size limit.");
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }
}
