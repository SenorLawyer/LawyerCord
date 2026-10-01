/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs, EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { saveFile } from "@utils/web";
import { createZipFile } from "@utils/zip";
import type { Guild } from "@vencord/discord-types";
import { StickerFormatType } from "@vencord/discord-types/enums";
import { EmojiStore, IconUtils, Menu, showToast, StickersStore, Toasts } from "@webpack/common";

const StickerExt = [, "png", "apng", "json", "gif"] as const;
const logger = new Logger("GuildPickerDumper");
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
let operation: AbortController | undefined;
let started = false;

const Patch: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild; }) => {
    const group = findGroupChildrenByChildId("privacy", children);

    if (group) {
        group.push(
            <>
                <Menu.MenuItem id="emoji.download" label="Download Emojis" action={() => zipGuildAssets(guild, "emojis")}></Menu.MenuItem>
                <Menu.MenuItem id="sticker.download" label="Download Stickers" action={() => zipGuildAssets(guild, "stickers")}></Menu.MenuItem>
            </>
        );
    }
};

async function zipGuildAssets(guild: Guild, type: "emojis" | "stickers") {
    if (!started) return;
    if (operation) {
        showToast("A server asset export is already running.", Toasts.Type.MESSAGE);
        return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    operation = controller;
    const timeout = setTimeout(() => {
        showToast("Server asset export timed out.", Toasts.Type.FAILURE);
        controller.abort();
    }, 120_000);
    const clearDeadline = () => clearTimeout(timeout);
    signal.addEventListener("abort", clearDeadline, { once: true });
    try {
        const items = type === "emojis" ? EmojiStore.getGuildEmoji(guild.id) : StickersStore.getStickersByGuildId(guild.id);
        if (!items) return;
        const rawEndpoint = window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT;
        const endpoint = new URL(rawEndpoint.includes("://") ? rawEndpoint : `https://${rawEndpoint.replace(/^\/\//, "")}`);
        if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port)
            throw new Error("Invalid media proxy address.");
        const files: Record<string, Uint8Array> = Object.create(null);
        let totalBytes = 0;
        for (const item of items) {
            if (signal.aborted) return;
            let ext: string;
            let url: string;
            if ("format_type" in item) {
                ext = `.${StickerExt[item.format_type]}`;
                const urlExt = item.format_type === StickerFormatType.APNG ? ".png" : ext;
                url = `${endpoint.origin}/stickers/${item.id}${urlExt}?size=4096&lossless=true`;
            } else {
                ext = item.animated ? ".gif" : ".png";
                url = IconUtils.getEmojiURL({ id: item.id, animated: item.animated, size: 512 });
            }
            let response = await fetch(url, { signal, redirect: "error" });
            if ("format_type" in item && item.format_type === StickerFormatType.APNG && (!response.ok || response.headers.get("content-type")?.includes("text"))) {
                await response.body?.cancel();
                response = await fetch(`${endpoint.origin}/stickers/${item.id}.gif?size=4096&lossless=true`, { signal, redirect: "error" });
                ext = ".gif";
            }
            if (!response.ok || !response.body || response.headers.get("content-type")?.includes("text")) {
                await response.body?.cancel();
                throw new Error("Could not download a server asset.");
            }
            if (totalBytes + Number(response.headers.get("content-length")) > MAX_EXPORT_BYTES) {
                await response.body.cancel();
                throw new Error("Server assets exceed the 100 MiB export limit.");
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (signal.aborted) return;
                    if (done) break;
                    size += value.byteLength;
                    totalBytes += value.byteLength;
                    if (totalBytes > MAX_EXPORT_BYTES) throw new Error("Server assets exceed the 100 MiB export limit.");
                    chunks.push(value);
                }
            } finally {
                try {
                    await reader.cancel();
                } finally {
                    reader.releaseLock();
                }
            }
            const data = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.byteLength;
            }
            const name = item.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
            files[`${name}_${item.id}${ext}`] = data;
        }
        const archive = await createZipFile(`${guild.name}-${type}.zip`, files, signal);
        if (!signal.aborted) saveFile(archive);
    } catch (error) {
        if (!signal.aborted) {
            logger.warn("Could not export server assets.");
            showToast(error instanceof Error ? error.message : "Could not export server assets.", Toasts.Type.FAILURE);
        }
    } finally {
        clearDeadline();
        signal.removeEventListener("abort", clearDeadline);
        if (operation === controller) operation = undefined;
    }
}

function cancelExport() {
    operation?.abort();
    operation = undefined;
}

export default definePlugin({
    name: "GuildPickerDumper",
    description: "Context menu to dump and download a server's emojis and stickers.",
    tags: ["Emotes", "Servers", "Utility"],
    authors: [EquicordDevs.Cortex, Devs.Samwich, EquicordDevs.Synth, Devs.thororen],
    contextMenus: {
        "guild-context": Patch,
        "guild-header-popout": Patch
    },
    start() {
        started = true;
    },
    stop() {
        started = false;
        cancelExport();
    },
    flux: {
        CONNECTION_OPEN: cancelExport
    }
});
