/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent, WebFrameMain } from "electron";

import { MEDIA_TIMEOUT, readMediaResponse } from "./utils/limits";

const ALLOWED_MEDIA_HOSTS = new Set([
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "media.discordapp.net",
    "media.tenor.com",
    "tenor.com",
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
]);

const requests = new WeakMap<WebFrameMain, Map<string, AbortController>>();

export function cancelMedia(event: IpcMainInvokeEvent, id: unknown) {
    if (event.senderFrame && typeof id === "string") requests.get(event.senderFrame)?.get(id)?.abort();
}

export async function fetchMedia(event: IpcMainInvokeEvent, url: unknown, id?: unknown) {
    if (typeof url !== "string" || url.length > 8192) return { error: "Invalid media URL." };
    const frame = event.senderFrame;
    if (id !== undefined && (!frame || typeof id !== "string" || !id.length || id.length > 64)) return { error: "Invalid media request." };
    const active = frame ? requests.get(frame) ?? new Map<string, AbortController>() : undefined;
    if (typeof id === "string" && active?.has(id)) return { error: "The media request is already active." };
    const controller = new AbortController();
    if (frame && active && typeof id === "string") {
        requests.set(frame, active);
        active.set(id, controller);
    }
    const timeout = setTimeout(() => controller.abort(), MEDIA_TIMEOUT);
    try {
        let current = url;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const parsed = URL.parse(current);
            if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !ALLOWED_MEDIA_HOSTS.has(parsed.hostname))
                return { error: "Invalid media URL." };
            const response = await fetch(parsed, { headers: { Accept: "*/*" }, redirect: "manual", signal: controller.signal });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                const location = response.headers.get("location");
                if (!location) return { error: "The media redirect has no destination." };
                current = new URL(location, parsed).href;
                continue;
            }
            const blob = await readMediaResponse(response, controller.signal);
            return { data: await blob.arrayBuffer(), type: blob.type };
        }
        return { error: "The media redirected too many times." };
    } catch {
        return { error: "Could not download the media within the size and time limits." };
    } finally {
        clearTimeout(timeout);
        if (typeof id === "string") active?.delete(id);
        if (frame && !active?.size) requests.delete(frame);
    }
}
