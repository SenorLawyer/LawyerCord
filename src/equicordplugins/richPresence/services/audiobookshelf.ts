/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { Activity } from "@vencord/discord-types";
import { FluxDispatcher, showToast } from "@webpack/common";

import { settings } from "../settings";
import { AbsMediaData, AbsSession } from "../types/audiobookshelf";
import { getCachedApplicationAsset } from "./assetCache";

const APPLICATION_ID = "1381423044907503636";
const SOCKET_ID = "RichPresence_ABS";
const AUTH_FAILURE_COOLDOWN_MS = 60_000;
const logger = new Logger("RichPresence:AudioBookShelf");

let authToken: string | null = null;
let updateInterval: NodeJS.Timeout | undefined;
let hasShownConfigError = false;
let isUpdating = false;
let lastAuthFailureAt = 0;
let updateGeneration = 0;

async function getAsset(key: string): Promise<string> {
    return getCachedApplicationAsset(APPLICATION_ID, key);
}

function setActivity(activity: Activity | null) {
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
}

async function authenticate(): Promise<boolean> {
    const { abs_serverUrl, abs_username, abs_password } = settings.store;
    if (!abs_serverUrl || !abs_username || !abs_password) {
        if (!hasShownConfigError) {
            logger.warn("AudioBookShelf server URL, username, or password is not set.");
            showToast("AudioBookShelf RPC is not configured.", "failure", { duration: 15000 });
            hasShownConfigError = true;
        }
        lastAuthFailureAt = Date.now();
        return false;
    }

    try {
        const baseUrl = abs_serverUrl.replace(/\/$/, "");
        const res = await fetch(`${baseUrl}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: abs_username, password: abs_password }),
        });

        if (!res.ok) throw `${res.status} ${res.statusText}`;
        const data = await res.json();
        authToken = data.user?.token;
        if (authToken) {
            hasShownConfigError = false;
            lastAuthFailureAt = 0;
        }
        return !!authToken;
    } catch (e) {
        logger.error("Failed to authenticate with AudioBookShelf", e);
        authToken = null;
        lastAuthFailureAt = Date.now();
        return false;
    }
}

async function fetchMediaData(): Promise<AbsMediaData | null> {
    if (!authToken && lastAuthFailureAt && Date.now() - lastAuthFailureAt < AUTH_FAILURE_COOLDOWN_MS) return null;
    if (!authToken && !(await authenticate())) return null;

    try {
        const baseUrl = settings.store.abs_serverUrl!.replace(/\/$/, "");
        const res = await fetch(`${baseUrl}/api/me/listening-sessions`, {
            headers: { "Authorization": `Bearer ${authToken}` },
        });

        if (!res.ok) {
            if (res.status === 401) authToken = null;
            throw `${res.status} ${res.statusText}`;
        }

        const { sessions }: { sessions: AbsSession[]; } = await res.json();
        const activeSession = sessions.find(s => s.updatedAt && !s.isFinished);
        if (!activeSession?.updatedAt || (Date.now() - activeSession.updatedAt) / 1000 > 30) return null;

        const { mediaMetadata: media, mediaType, duration, currentTime, libraryItemId } = activeSession;
        if (!media) return null;

        return {
            name: media.title || "Unknown",
            type: mediaType || "book",
            author: media.author || media.publisher,
            series: media.series?.[0]?.name,
            duration,
            currentTime,
            imageUrl: libraryItemId ? `${baseUrl}/api/items/${libraryItemId}/cover` : undefined,
            isFinished: activeSession.isFinished || false,
        };
    } catch (e) {
        logger.error("Failed to query AudioBookShelf API", e);
        return null;
    }
}

async function getActivity(): Promise<Activity | null> {
    const mediaData = await fetchMediaData();
    if (!mediaData || mediaData.isFinished) return null;

    const largeImage = mediaData.imageUrl;
    const assets = {
        large_image: largeImage ? await getAsset(largeImage) : await getAsset("audiobookshelf"),
        large_text: mediaData.series || mediaData.author || undefined,
    };

    const details = mediaData.name;
    const state = mediaData.series && mediaData.author
        ? `${mediaData.series} \u2022 ${mediaData.author}`
        : mediaData.author || "AudioBook";

    const timestamps = mediaData.currentTime != null && mediaData.duration != null ? {
        start: Date.now() - (mediaData.currentTime * 1000),
        end: Date.now() + ((mediaData.duration - mediaData.currentTime) * 1000),
    } : undefined;

    return {
        application_id: APPLICATION_ID,
        name: "AudioBookShelf",
        details,
        state,
        assets,
        timestamps,
        type: 2,
        flags: 1,
    };
}

async function updatePresence() {
    if (isUpdating) return;

    const generation = updateGeneration;
    isUpdating = true;
    try {
        const activity = await getActivity();
        if (generation === updateGeneration) setActivity(activity);
    } catch (e) {
        logger.error("Failed to update presence", e);
        if (generation === updateGeneration) setActivity(null);
    } finally {
        if (generation === updateGeneration) isUpdating = false;
    }
}

export function start() {
    if (updateInterval) return;

    updateGeneration++;
    authToken = null;
    hasShownConfigError = false;
    lastAuthFailureAt = 0;
    void updatePresence();
    updateInterval = setInterval(updatePresence, 10000);
}

export function stop() {
    updateGeneration++;
    clearInterval(updateInterval);
    updateInterval = undefined;
    isUpdating = false;
    authToken = null;
    lastAuthFailureAt = 0;
    setActivity(null);
}
