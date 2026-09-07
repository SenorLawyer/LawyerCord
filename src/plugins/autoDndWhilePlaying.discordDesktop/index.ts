/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RunningGameStore, UserStore } from "@webpack/common";

let savedStatus: { userId: string; value: string; applied: string; } | null = null;

const StatusSettings = getUserSettingLazy<string>("status", "status")!;
const logger = new Logger("AutoDNDWhilePlaying");

const settings = definePluginSettings({
    statusToSet: {
        type: OptionType.SELECT,
        description: "Status to set while playing a game",
        options: [
            {
                label: "Online",
                value: "online",
            },
            {
                label: "Idle",
                value: "idle",
            },
            {
                label: "Do Not Disturb",
                value: "dnd",
                default: true
            },
            {
                label: "Invisible",
                value: "invisible",
            }
        ]
    },
    excludeInvisible: {
        type: OptionType.BOOLEAN,
        description: "Prevent automatic status changes while your status is set to invisible",
        default: false
    },
});

function updateStatus(isPlaying: boolean) {
    const userId = UserStore.getCurrentUser()?.id;
    if (savedStatus?.userId !== userId) savedStatus = null;
    if (!userId) return;
    const status = StatusSettings.getSetting();

    if (isPlaying) {
        if (settings.store.excludeInvisible && status === "invisible") return;
        if (status !== settings.store.statusToSet) {
            savedStatus = { userId, value: status, applied: settings.store.statusToSet };
            return StatusSettings.updateSetting(settings.store.statusToSet);
        }
    } else if (savedStatus) {
        const previousStatus = savedStatus;
        savedStatus = null;
        if (status === previousStatus.applied) return StatusSettings.updateSetting(previousStatus.value);
    }
}

migratePluginSettings("AutoDNDWhilePlaying", "StatusWhilePlaying");
export default definePlugin({
    name: "AutoDNDWhilePlaying",
    description: "Automatically updates your online status (online, idle, dnd) when launching games",
    tags: ["Activity", "Utility"],
    authors: [Devs.thororen],
    isModified: true,
    dependencies: ["UserSettingsAPI"],
    settings,
    async start() {
        try {
            await updateStatus(RunningGameStore.getRunningGames().length > 0);
        } catch (error) {
            logger.error("Could not update your status.", error);
        }
    },
    async stop() {
        const previousStatus = savedStatus;
        savedStatus = null;
        try {
            if (previousStatus && previousStatus.userId === UserStore.getCurrentUser()?.id && StatusSettings.getSetting() === previousStatus.applied)
                await StatusSettings.updateSetting(previousStatus.value);
        } catch (error) {
            logger.error("Could not restore your status.", error);
        }
    },
    flux: {
        LOGOUT() {
            savedStatus = null;
        },
        RUNNING_GAMES_CHANGE({ games }) {
            return updateStatus(games.length > 0);
        }
    }
});
