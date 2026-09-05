/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 OpenAsar
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

import { popNotice, showNotice } from "@api/Notices";
import { migratePluginSettings } from "@api/Settings";
import { HeadingSecondary } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin, { ReporterTestable } from "@utils/types";
import { ApplicationAssetUtils, fetchApplicationsRPC, FluxDispatcher, Toasts } from "@webpack/common";

const MAX_CACHE_SIZE = 100;
const assetCache = new Map<string, Promise<string>>();
const applicationCache = new Map<string, Promise<{ name?: string; } | undefined>>();
const logger = new Logger("WebRichPresence");

interface RpcMessage {
    socketId: string;
    pid?: number | null;
    activity: (Record<string, unknown> & {
        name?: string | null;
        application_id?: string | null;
        assets?: (Record<string, unknown> & { large_image?: string | null; small_image?: string | null; }) | null;
    }) | null;
}

const latestActivities = new Map<string, RpcMessage>();

function isRpcMessage(value: unknown): value is RpcMessage {
    if (!isObject(value)) return false;
    const data = value as Record<string, unknown>;
    if (typeof data.socketId !== "string" || !data.socketId) return false;
    if (data.pid != null && (typeof data.pid !== "number" || !Number.isSafeInteger(data.pid) || data.pid < 0)) return false;
    if (data.activity === null) return true;
    if (!isObject(data.activity)) return false;
    const activity = data.activity as Record<string, unknown>;
    if (["application_id", "name"].some(key => activity[key] != null && typeof activity[key] !== "string")) return false;
    if (activity.assets == null) return true;
    if (!isObject(activity.assets)) return false;
    const assets = activity.assets as Record<string, unknown>;
    return ["large_image", "small_image"].every(key => assets[key] == null || typeof assets[key] === "string");
}

function clearActivities() {
    const activities = [...latestActivities];
    latestActivities.clear();
    for (const [socketId, { pid }] of activities)
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId, pid });
}

function pruneOldestCacheEntry(cache: Pick<Map<string, unknown>, "delete" | "keys">) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
}

async function lookupAsset(applicationId: string, key: string): Promise<string> {
    const cacheKey = JSON.stringify([applicationId, key]);
    const cachedAsset = assetCache.get(cacheKey);
    if (cachedAsset) return cachedAsset;

    if (assetCache.size >= MAX_CACHE_SIZE) pruneOldestCacheEntry(assetCache);

    const assetPromise = ApplicationAssetUtils.fetchAssetIds(applicationId, [key])
        .then(assetIds => assetIds[0])
        .catch(error => {
            if (assetCache.get(cacheKey) === assetPromise) assetCache.delete(cacheKey);
            throw error;
        });

    assetCache.set(cacheKey, assetPromise);
    return assetPromise;
}

async function lookupApp(applicationId: string): Promise<{ name?: string; } | undefined> {
    const cachedApplication = applicationCache.get(applicationId);
    if (cachedApplication) return cachedApplication;

    if (applicationCache.size >= MAX_CACHE_SIZE) pruneOldestCacheEntry(applicationCache);

    const socket: { application?: { name?: string; }; } = {};
    const applicationPromise = fetchApplicationsRPC(socket, applicationId)
        .then(() => socket.application)
        .catch(error => {
            if (applicationCache.get(applicationId) === applicationPromise) applicationCache.delete(applicationId);
            throw error;
        });

    applicationCache.set(applicationId, applicationPromise);
    return applicationPromise;
}

function resolveOptional<T>(promise: Promise<T> | undefined): Promise<T | undefined> {
    return promise?.catch(() => undefined) ?? Promise.resolve(undefined);
}

let ws: WebSocket | undefined;
let connectionGeneration = 0;

migratePluginSettings("WebRichPresence", "WebRichPresence (arRPC)");
export default definePlugin({
    name: "WebRichPresence",
    description: "Client plugin for arRPC to enable RPC on Discord Web (experimental)",
    tags: ["Activity", "Utility"],
    authors: [Devs.Ducko],
    reporterTestable: ReporterTestable.None,
    hidden: !IS_EQUIBOP && !IS_VESKTOP && !("legcord" in window),

    settingsAboutComponent: () => (
        <>
            <HeadingSecondary>How to use arRPC</HeadingSecondary>
            <Paragraph>
                <Link href="https://github.com/OpenAsar/arrpc/tree/main#server">Follow the instructions in the GitHub repo</Link> to get the server running, and then enable the plugin.
            </Paragraph>
        </>
    ),

    async handleEvent(e: MessageEvent<unknown>, generation = connectionGeneration) {
        if (generation !== connectionGeneration || typeof e.data !== "string") return;

        let data: unknown;
        try {
            data = JSON.parse(e.data);
        } catch {
            return;
        }
        if (!isRpcMessage(data)) return;

        const { activity } = data;
        const socketId = `arRPC:${data.socketId}`;
        latestActivities.set(socketId, data);
        const isCurrent = () => generation === connectionGeneration && latestActivities.get(socketId) === data;

        if (activity) {
            const { assets, application_id: appId } = activity;
            const [largeImage, smallImage] = await Promise.all([
                resolveOptional(appId && assets?.large_image ? lookupAsset(appId, assets.large_image) : undefined),
                resolveOptional(appId && assets?.small_image ? lookupAsset(appId, assets.small_image) : undefined),
            ]);
            if (!isCurrent()) return;

            if (assets && largeImage) assets.large_image = largeImage;
            if (assets && smallImage) assets.small_image = smallImage;

            const app = await resolveOptional(appId ? lookupApp(appId) : undefined);
            if (!isCurrent()) return;

            activity.name ||= app?.name;
        }

        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId, pid: data.pid });
        if (!activity && isCurrent()) latestActivities.delete(socketId);
    },

    start() {
        const generation = ++connectionGeneration;
        ws?.close();
        ws = undefined;
        clearActivities();

        const onClose = () => {
            if (generation !== connectionGeneration) return;
            ws = undefined;
            clearActivities();
            showNotice("Disconnected from arRPC, is it running?", "Retry", () => {
                if (generation !== connectionGeneration) return;
                popNotice();
                this.start();
            });
        };

        let socket: WebSocket;
        try {
            socket = new WebSocket("ws://127.0.0.1:1337");
        } catch (error) {
            logger.error("Failed to connect to arRPC", error);
            onClose();
            return;
        }
        ws = socket;
        socket.onmessage = event => void this.handleEvent(event, generation).catch(error => logger.error("Failed to update activity", error));
        socket.onclose = onClose;
        socket.onopen = () => {
            if (generation !== connectionGeneration) return;
            Toasts.show({
                message: "Connected to arRPC",
                type: Toasts.Type.SUCCESS,
                id: Toasts.genId(),
                options: {
                    duration: 1000,
                    position: Toasts.Position.BOTTOM
                }
            });
        };
    },

    stop() {
        connectionGeneration++;
        clearActivities(); // clear status
        ws?.close(); // close WebSocket
        ws = undefined;
        assetCache.clear();
        applicationCache.clear();
    }
});
