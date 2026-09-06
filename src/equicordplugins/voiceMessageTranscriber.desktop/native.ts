/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { isRecognizedAudioContainer } from "./audioValidation";

// we love CORS
export async function fetchAudio(_: IpcMainInvokeEvent, url: unknown): Promise<Uint8Array> {
    const parsed = typeof url === "string" && url.length <= 8192 ? URL.parse(url) : null;
    if (!parsed || parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password
        || (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net"))
        throw new Error("Blocked an untrusted voice-message URL");

    const maxBytes = 25 * 1024 * 1024;
    try {
        const res = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(120_000) });
        if (!res.ok || !res.body || Number(res.headers.get("Content-Length")) > maxBytes) {
            await res.body?.cancel();
            throw new Error("Invalid voice-message response");
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
                    throw new Error("Voice message exceeds the transcription limit");
                }
                chunks.push(value);
            }
        } finally {
            reader.releaseLock();
        }

        const audio = Buffer.concat(chunks, size);
        if (!isRecognizedAudioContainer(audio))
            throw new Error("Invalid audio file");
        return audio;
    } catch {
        throw new Error("Could not download this voice message. Use a valid audio file under 25 MB.");
    }
}
