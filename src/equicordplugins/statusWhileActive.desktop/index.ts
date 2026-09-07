/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { UserStore, VoiceStateStore } from "@webpack/common";

let savedStatus: { userId: string; value: string; applied: string; } | null = null;

const StatusSettings = getUserSettingLazy<string>("status", "status")!;
const logger = new Logger("StatusWhileActive");

const settings = definePluginSettings({
    statusToSet: {
        type: OptionType.SELECT,
        description: "Status to set while in a voice channel.",
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
    }
});

async function setStatus(userId: string, inVoiceChannel: boolean, status: string) {
    if (savedStatus?.userId !== userId) savedStatus = null;

    if (inVoiceChannel) {
        if (savedStatus) return;
        const previousStatus = savedStatus = { userId, value: status, applied: settings.store.statusToSet };
        if (status === previousStatus.applied) return;
        try {
            await StatusSettings.updateSetting(previousStatus.applied);
        } catch (error) {
            if (savedStatus === previousStatus) savedStatus = null;
            throw error;
        }
        return;
    }

    if (savedStatus) {
        const previousStatus = savedStatus;
        savedStatus = null;
        if (status === previousStatus.applied && previousStatus.value !== previousStatus.applied)
            return StatusSettings?.updateSetting(previousStatus.value);
    }
}

function updateStatusForCurrentVoiceState() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    const status = StatusSettings.getSetting();
    const inVoiceChannel = !!VoiceStateStore.getVoiceStateForUser(userId)?.channelId;

    return setStatus(userId, inVoiceChannel, status);
}

export default definePlugin({
    name: "StatusWhileActive",
    description: "Automatically updates your online status when in a voice channel.",
    tags: ["Activity", "Customisation", "Voice"],
    authors: [EquicordDevs.smuki],
    dependencies: ["UserSettingsAPI"],
    settings,
    async start() {
        try {
            await updateStatusForCurrentVoiceState();
        } catch (error) {
            logger.error("Could not update your status.", error);
        }
    },
    flux: {
        LOGOUT() {
            savedStatus = null;
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const userId = UserStore.getCurrentUser()?.id;
            if (!userId) return;

            const myState = voiceStates.find(state => state.userId === userId);
            if (!myState) return;

            return updateStatusForCurrentVoiceState();
        }
    },

    async stop() {
        const previousStatus = savedStatus;
        savedStatus = null;
        try {
            if (previousStatus && previousStatus.userId === UserStore.getCurrentUser()?.id && StatusSettings.getSetting() === previousStatus.applied && previousStatus.value !== previousStatus.applied)
                await StatusSettings.updateSetting(previousStatus.value);
        } catch (error) {
            logger.error("Could not restore your status.", error);
        }
    }
});
