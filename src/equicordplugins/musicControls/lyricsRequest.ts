/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readResponseText } from "@shared/readResponseText";
import { Logger } from "@utils/Logger";

const logger = new Logger("MusicControls");
const requests = new Set<AbortController>();
let active = true;
export let lyricsRequestGeneration = 0;

export function startLyricsRequests() {
    active = true;
}

export function stopLyricsRequests() {
    active = false;
    lyricsRequestGeneration++;
    for (const controller of requests) controller.abort();
}

export async function requestLyrics(url: string, options?: RequestInit): Promise<unknown> {
    if (!active || requests.size >= 8) throw new Error("Lyrics are busy. Try again shortly.");
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok || controller.signal.aborted) {
            await response.body?.cancel();
            if (!controller.signal.aborted && response.status === 404) return null;
            throw new Error("Could not load lyrics.");
        }
        const text = await readResponseText(response, 1024 * 1024);
        if (controller.signal.aborted) throw new Error("Lyrics request was cancelled.");
        return JSON.parse(text);
    } catch (error) {
        if (!controller.signal.aborted) logger.warn("Could not load lyrics.");
        throw error;
    } finally {
        controller.abort();
        clearTimeout(timeout);
        requests.delete(controller);
    }
}
