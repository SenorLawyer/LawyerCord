/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { UserStore, VoiceStateStore } from "@webpack/common";

let savedStatus: { userId: string; value: string; applied: string; } | null = null;

const StatusSettings = getUserSettingLazy<string>("status", "status")!;

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

function setStatus(userId: string, inVoiceChannel: boolean, status: string) {
    if (savedStatus?.userId !== userId) savedStatus = null;

    if (inVoiceChannel) {
        if (status !== settings.store.statusToSet) {
            savedStatus = { userId, value: status, applied: settings.store.statusToSet };
            StatusSettings?.updateSetting(settings.store.statusToSet);
        }
        return;
    }

    if (savedStatus) {
        if (status === savedStatus.applied) {
            StatusSettings?.updateSetting(savedStatus.value);
        }
        savedStatus = null;
    }
}

function updateStatusForCurrentVoiceState() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;

    const status = StatusSettings.getSetting();
    const inVoiceChannel = !!VoiceStateStore.getVoiceStateForUser(userId)?.channelId;

    setStatus(userId, inVoiceChannel, status);
}

export default definePlugin({
    name: "StatusWhileActive",
    description: "Automatically updates your online status when in a voice channel.",
    tags: ["Activity", "Customisation", "Voice"],
    authors: [EquicordDevs.smuki],
    dependencies: ["UserSettingsAPI"],
    settings,
    start() {
        updateStatusForCurrentVoiceState();
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

            updateStatusForCurrentVoiceState();
        }
    },

    stop() {
        if (!savedStatus) return;

        if (savedStatus.userId === UserStore.getCurrentUser()?.id && StatusSettings.getSetting() === savedStatus.applied)
            StatusSettings?.updateSetting(savedStatus.value);
        savedStatus = null;
    }
});
