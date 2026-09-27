/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as DataStore from "@api/DataStore";
import { classNameFactory } from "@utils/css";
import { UserStore } from "@webpack/common";

import { ChromeIcon, DiscordIcon, EdgeIcon, FirefoxIcon, IEIcon, MobileIcon, OperaIcon, SafariIcon, UnknownIcon } from "./components/icons";
import { SessionInfo } from "./types";

const getDataKey = () => {
    const currentUserId = UserStore.getCurrentUser()?.id;
    return currentUserId ? `BetterSessions_savedSessions_${currentUserId}` : undefined;
};

export const cl = classNameFactory("vc-betterSessions-");
export const savedSessionsCache: Map<string, { name: string, isNew: boolean; }> = new Map();

export function getDefaultName(clientInfo: SessionInfo["session"]["client_info"]) {
    return `${clientInfo.os} · ${clientInfo.platform}`;
}

export function saveSessionsToDataStore(sessions: typeof savedSessionsCache = savedSessionsCache) {
    const dataKey = getDataKey();
    if (!dataKey) return Promise.resolve();

    const snapshot = structuredClone(sessions);
    return DataStore.update<unknown>(dataKey, current => {
        readSavedSessions(current);
        return snapshot;
    });
}

export async function fetchNamesFromDataStore(shouldApply = () => true) {
    savedSessionsCache.clear();

    const dataKey = getDataKey();
    if (!dataKey) return;

    const record = await DataStore.get<unknown>(dataKey);
    if (!shouldApply()) return;
    const savedSessions = readSavedSessions(record);

    savedSessionsCache.clear();
    savedSessions.forEach((data, idHash) => {
        savedSessionsCache.set(idHash, data);
    });
}

function readSavedSessions(value: unknown): typeof savedSessionsCache {
    if (value === undefined || (Object.prototype.toString.call(value) === "[object Object]" && Object.keys(value as object).length === 0)) return new Map();
    if (!(value instanceof Map)) throw new Error("Saved session names are invalid. The original record has been preserved.");
    const sessions: Map<unknown, unknown> = value;
    for (const [id, data] of sessions) {
        if (typeof id !== "string" || !data || typeof data !== "object"
            || !("name" in data) || typeof data.name !== "string"
            || !("isNew" in data) || typeof data.isNew !== "boolean") {
            throw new Error("Saved session names are invalid. The original record has been preserved.");
        }
    }
    return value;
}

export function GetOsColor(os: string) {
    switch (os) {
        case "Windows Mobile":
        case "Windows":
            return "#55a6ef"; // Light blue
        case "Linux":
            return "#cdcd31"; // Yellow
        case "Android":
            return "#7bc958"; // Green
        case "Mac OS X":
        case "iOS":
            return ""; // Default to white/black (theme-dependent)
        default:
            return "#f3799a"; // Pink
    }
}

export function GetPlatformIcon(platform: string) {
    switch (platform) {
        case "Discord Android":
        case "Discord iOS":
        case "Discord Client":
            return DiscordIcon;
        case "Android Chrome":
        case "Chrome iOS":
        case "Chrome":
            return ChromeIcon;
        case "Edge":
            return EdgeIcon;
        case "Firefox":
            return FirefoxIcon;
        case "Internet Explorer":
            return IEIcon;
        case "Opera Mini":
        case "Opera":
            return OperaIcon;
        case "Mobile Safari":
        case "Safari":
            return SafariIcon;
        case "BlackBerry":
        case "Facebook Mobile":
        case "Android Mobile":
            return MobileIcon;
        default:
            return UnknownIcon;
    }
}
