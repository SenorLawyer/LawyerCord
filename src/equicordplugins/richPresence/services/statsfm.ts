/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { Activity, ActivityButton } from "@vencord/discord-types";
import { ActivityFlags, ActivityType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import { settings } from "../settings";
import { NameFormat } from "../types";
import { SfmResponse, SfmTrackData } from "../types/statsfm";
import { getCachedApplicationAsset } from "./assetCache";

const APPLICATION_ID = "1325126169179197500";
const PLACEHOLDER_ID = "2a96cbd8b46e442fc41c2b86b821562f";
const SOCKET_ID = "RichPresence_SFM";
const API_ERROR_COOLDOWN_MS = 60_000;
const logger = new Logger("RichPresence:StatsFm");
const PresenceStore = findByPropsLazy("getLocalPresence");

let updateInterval: NodeJS.Timeout | undefined;
let isUpdating = false;
let requestController: AbortController | undefined;
let lastApiErrorAt = 0;
let updateGeneration = 0;

async function getAsset(key: string): Promise<string> {
    return getCachedApplicationAsset(APPLICATION_ID, key);
}

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

function reportApiError(message: string, details: unknown) {
    const now = Date.now();
    if (lastApiErrorAt && now - lastApiErrorAt < API_ERROR_COOLDOWN_MS) return;

    lastApiErrorAt = now;
    logger.error(message, details);
}

async function fetchTrackData(signal: AbortSignal): Promise<SfmTrackData | null> {
    const username = settings.store.sfm_username?.trim();
    if (!username) {
        lastApiErrorAt = 0;
        return null;
    }

    try {
        const res = await fetch(`https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/streams/current`, { signal });
        if (!res.ok) throw `${res.status} ${res.statusText}`;

        const json = await res.json() as Partial<SfmResponse>;
        lastApiErrorAt = 0;

        const trackData = json.item?.track;
        if (!trackData || signal.aborted) return null;

        const albums = trackData.albums ?? [];
        const artists = trackData.artists ?? [];
        let albumNames = "";
        for (const album of albums) {
            if (albumNames) albumNames += ", ";
            albumNames += album.name;
        }

        return {
            name: trackData.name || "Unknown",
            albums: albumNames || "Unknown",
            artists: artists[0]?.name ?? "Unknown",
            url: `https://stats.fm/track/${trackData.id}`,
            imageUrl: albums[0]?.image,
        };
    } catch (e) {
        if (!signal.aborted) reportApiError("Failed to query Stats.fm API", e);
        return null;
    }
}

function getLargeImage(track: SfmTrackData): string | undefined {
    if (!settings.store.sfm_alwaysHideArt && track.imageUrl && !track.imageUrl.includes(PLACEHOLDER_ID))
        return track.imageUrl;
    if (settings.store.sfm_missingArt === "placeholder") return "placeholder";
}

async function getActivity(signal: AbortSignal): Promise<Activity | null> {
    if (settings.store.sfm_hideWithExternalRPC) {
        if (PresenceStore.getActivities().some(a => a.application_id !== APPLICATION_ID)) return null;
    }

    if (settings.store.sfm_hideWithSpotify) {
        if (PresenceStore.getActivities().some(a => a.type === ActivityType.LISTENING && a.application_id !== APPLICATION_ID))
            return null;
    }

    const trackData = await fetchTrackData(signal);
    if (!trackData || signal.aborted) return null;

    const largeImage = getLargeImage(trackData);
    const assets = largeImage
        ? {
            large_image: await getAsset(largeImage),
            large_text: trackData.albums || undefined,
            ...(settings.store.sfm_showLogo && {
                small_image: await getAsset("statsfm-large"),
                small_text: "Stats.fm",
            }),
        } : {
            large_image: await getAsset("statsfm-large"),
            large_text: trackData.albums || undefined,
        };

    const buttons: ActivityButton[] = [];
    if (settings.store.sfm_shareUsername)
        buttons.push({ label: "Stats.fm Profile", url: `https://stats.fm/${settings.store.sfm_username}` });
    if (settings.store.sfm_shareSong)
        buttons.push({ label: "View Song", url: trackData.url });

    const statusName = (() => {
        switch (settings.store.sfm_nameFormat) {
            case NameFormat.ArtistFirst: return trackData.artists + " - " + trackData.name;
            case NameFormat.SongFirst: return trackData.name + " - " + trackData.artists;
            case NameFormat.ArtistOnly: return trackData.artists;
            case NameFormat.SongOnly: return trackData.name;
            case NameFormat.AlbumName: return trackData.albums || settings.store.sfm_statusName;
            default: return settings.store.sfm_statusName;
        }
    })();

    return {
        application_id: APPLICATION_ID,
        name: statusName,
        details: trackData.name,
        state: trackData.artists,
        assets,
        buttons: buttons.length ? buttons.map(v => v.label) : undefined,
        metadata: buttons.length ? { button_urls: buttons.map(v => v.url) } : undefined,
        type: settings.store.sfm_useListeningStatus ? ActivityType.LISTENING : ActivityType.PLAYING,
        flags: ActivityFlags.INSTANCE,
    };
}

async function updatePresence() {
    if (isUpdating) return;

    const generation = updateGeneration;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    isUpdating = true;
    try {
        const activity = await getActivity(controller.signal);
        if (generation === updateGeneration && !controller.signal.aborted) setActivity(activity);
    } catch (e) {
        if (!controller.signal.aborted) logger.error("Failed to update presence", e);
        if (generation === updateGeneration) setActivity(null);
    } finally {
        clearTimeout(timeout);
        if (requestController === controller) requestController = undefined;
        if (generation === updateGeneration) isUpdating = false;
    }
}

export function start() {
    if (updateInterval) return;

    updateGeneration++;
    lastApiErrorAt = 0;
    void updatePresence();
    updateInterval = setInterval(updatePresence, 16000);
}

export function stop() {
    updateGeneration++;
    requestController?.abort();
    requestController = undefined;
    clearInterval(updateInterval);
    updateInterval = undefined;
    isUpdating = false;
    lastApiErrorAt = 0;
    setActivity(null);
}
