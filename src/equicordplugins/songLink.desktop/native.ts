/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";
import { readResponseText } from "@shared/readResponseText";
import type { IpcMainInvokeEvent } from "electron";

type SongLinkResult = {
    info?: { title: string; artist: string; };
    links: Record<string, { url: string; nativeUri?: string; }>;
};

const requests = new Map<string, Promise<SongLinkResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getTrackData(_: IpcMainInvokeEvent, trackURL: unknown): Promise<SongLinkResult> {
    if (typeof trackURL !== "string" || trackURL.length > 4096) throw "Invalid music link.";
    let track: URL;
    try {
        track = new URL(trackURL);
    } catch {
        throw "Invalid music link.";
    }
    if (!["https:", "http:"].includes(track.protocol) || track.username || track.password) throw "Invalid music link.";
    const country = RendererSettings.store.plugins?.SongLink?.userCountry;
    const url = new URL("https://api.song.link/v1-alpha.1/links");
    url.searchParams.set("url", trackURL);
    url.searchParams.set("userCountry", typeof country === "string" && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : "US");
    const key = url.toString();
    const existing = requests.get(key);
    if (existing) return existing;
    if (requests.size >= 8) throw "Too many song links are loading. Try again shortly.";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const request = (async (): Promise<SongLinkResult> => {
        try {
            const response = await fetch(key, { signal: controller.signal, redirect: "error" });
            if (!response.ok || controller.signal.aborted) {
                await response.body?.cancel();
                throw "Could not load the song link.";
            }
            const raw: unknown = JSON.parse(await readResponseText(response, 1024 * 1024));
            if (controller.signal.aborted || !isRecord(raw) || !isRecord(raw.entitiesByUniqueId) || !isRecord(raw.linksByPlatform))
                throw "Invalid song link response.";
            const entry = Object.entries(raw.entitiesByUniqueId).find(([name]) => !name.includes("YOUTUBE"))?.[1];
            const info = isRecord(entry) && typeof entry.title === "string" && typeof entry.artistName === "string"
                ? { title: entry.title, artist: entry.artistName }
                : undefined;
            const links: SongLinkResult["links"] = {};
            for (const [name, value] of Object.entries(raw.linksByPlatform)) {
                if (!isRecord(value) || typeof value.url !== "string") continue;
                links[name] = { url: value.url, ...(typeof value.nativeAppUriDesktop === "string" ? { nativeUri: value.nativeAppUriDesktop } : {}) };
            }
            return { info, links };
        } catch {
            throw "Could not load the song link.";
        } finally {
            controller.abort();
            clearTimeout(timeout);
            requests.delete(key);
        }
    })();
    requests.set(key, request);
    return request;
}
