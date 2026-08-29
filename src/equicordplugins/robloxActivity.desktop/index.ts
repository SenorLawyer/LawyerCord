/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MessageObject } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.RobloxActivity as PluginNative<typeof import("./native")>;
const logger = new Logger("RobloxActivity");
const allowedUsers = new Set(["notlmutsaers", "froggodoggo"]);
const sessionStartedAt = { value: 0 };

let isPlaying = false;
let pollInterval: ReturnType<typeof setInterval> | undefined;
let polling = false;

const settings = definePluginSettings({
    guildId: {
        type: OptionType.STRING,
        description: "Guild where Roblox activity messages are posted.",
        default: "690342051778396403",
    },
    channelId: {
        type: OptionType.STRING,
        description: "Channel where Roblox activity messages are posted.",
        default: "1085873944751521792",
    },
    pollInterval: {
        type: OptionType.SLIDER,
        description: "Seconds between Roblox process checks.",
        markers: [10, 15, 20, 30],
        default: 15,
        restartNeeded: true,
    },
});

interface DiscordEmbed {
    title: string;
    description: string;
    color: number;
    timestamp: string;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
}

function sendEmbed(embed: DiscordEmbed) {
    const channel = ChannelStore.getChannel(settings.store.channelId);
    if (channel?.guild_id && channel.guild_id !== settings.store.guildId) return;

    const data = { content: "", embeds: [embed] } as Partial<MessageObject> & { embeds: DiscordEmbed[] };
    return sendMessage(settings.store.channelId, data);
}

function formatDuration(startedAt: number) {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return [hours && `${hours}h`, minutes && `${minutes}m`, `${remainingSeconds}s`].filter(Boolean).join(" ");
}

async function checkProcess() {
    if (polling) return;
    polling = true;

    try {
        const running = await Native.isRobloxRunning();
        if (running === null) return;
        if (running === isPlaying) return;

        isPlaying = running;
        if (running) {
            sessionStartedAt.value = Date.now();
            await sendEmbed({
                title: "Roblox session started",
                description: "Playing Roblox",
                color: 0x00a2ff,
                timestamp: new Date().toISOString(),
                fields: [
                    { name: "Game", value: "Unknown", inline: true },
                    { name: "Players", value: "Unknown", inline: true },
                    { name: "Game link", value: "Unavailable", inline: true },
                ],
            });
        } else {
            await sendEmbed({
                title: "Roblox session ended",
                description: "Roblox is no longer running.",
                color: 0xff5555,
                timestamp: new Date().toISOString(),
                fields: [{ name: "Session duration", value: formatDuration(sessionStartedAt.value) }],
            });
            sessionStartedAt.value = 0;
        }
    } catch (error) {
        logger.error("Failed to check Roblox activity", error);
    } finally {
        polling = false;
    }
}

export default definePlugin({
    name: "RobloxActivity",
    description: "Posts Roblox session start and end updates to a Discord channel.",
    authors: [EquicordDevs.nobody],
    enabledByDefault: true,
    settings,
    start() {
        const username = UserStore.getCurrentUser()?.username.toLowerCase();
        if (!username || !allowedUsers.has(username)) return;

        void checkProcess();
        pollInterval = setInterval(checkProcess, settings.store.pollInterval * 1000);
    },
    stop() {
        if (pollInterval !== undefined) {
            clearInterval(pollInterval);
            pollInterval = undefined;
        }
        isPlaying = false;
        sessionStartedAt.value = 0;
    },
});
