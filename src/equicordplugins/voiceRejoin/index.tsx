/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { ChannelStore, FluxDispatcher, UserStore, VoiceStateStore } from "@webpack/common";

const DATASTORE_KEY = "VCLastVoiceChannel";
const DATASTORE_SESSION_KEY = "VCLastVoiceChannelSession";
const PERSIST_THROTTLE_MS = 15_000;
const logger = new Logger("VoiceRejoin");

type SavedVoiceChannel = {
    guildId: string | null;
    channelId: string;
    timestamp: number;
};

let reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;
let reconnectGeneration = 0;
let lastPersistedChannelId: string | null = null;
let lastPersistedGuildId: string | null = null;
let lastPersistedSessionState: boolean | null = null;
let lastPersistedAt = 0;

const settings = definePluginSettings({
    rejoinDelay: {
        type: OptionType.SLIDER,
        description: "Set Delay before rejoining voice channel.",
        markers: makeRange(1, 10, 1),
        default: 2,
        stickToMarkers: true,
    },
    rejoinTimeout: {
        type: OptionType.SLIDER,
        description: "Don't attempt to rejoin after this many seconds have passed since disconnecting.",
        markers: makeRange(5, 120, 5),
        default: 30,
        stickToMarkers: true,
    },
    preventReconnectIfCallEnded: {
        type: OptionType.SELECT,
        description: "Do not reconnect if the call has ended or the voice channel is empty or does not exist.",
        options: [
            { label: "None", value: "none", default: false },
            { label: "DMs only", value: "dms", default: false },
            { label: "Servers only", value: "servers", default: false },
            { label: "DMs and Servers", value: "both", default: true },
        ],
    },
    applyOnlyToDms: {
        type: OptionType.BOOLEAN,
        description: "Only apply to DMs.",
        default: false,
    }
});

function cancelReconnectAttempt() {
    reconnectGeneration++;
    if (!reconnectTimeoutId) return;

    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = undefined;
}

function resetPersistCache() {
    lastPersistedChannelId = null;
    lastPersistedGuildId = null;
    lastPersistedSessionState = null;
    lastPersistedAt = 0;
}

function cachePersistedState(saved: SavedVoiceChannel | null, sessionState: boolean) {
    lastPersistedChannelId = saved?.channelId ?? null;
    lastPersistedGuildId = saved?.guildId ?? null;
    lastPersistedSessionState = sessionState;
    lastPersistedAt = saved?.timestamp ?? Date.now();
}

function shouldPersistActiveState(saved: SavedVoiceChannel) {
    return lastPersistedSessionState !== true
        || lastPersistedChannelId !== saved.channelId
        || lastPersistedGuildId !== saved.guildId
        || saved.timestamp - lastPersistedAt >= PERSIST_THROTTLE_MS;
}

async function persistActiveState(state: VoiceState) {
    const { channelId } = state;
    if (!channelId) return;

    const saved: SavedVoiceChannel = {
        guildId: state.guildId ?? null,
        channelId,
        timestamp: Date.now(),
    };

    if (!shouldPersistActiveState(saved)) return;
    const generation = reconnectGeneration;

    await DataStore.setMany([
        [DATASTORE_KEY, saved],
        [DATASTORE_SESSION_KEY, true]
    ]);
    if (generation === reconnectGeneration) cachePersistedState(saved, true);
}

async function persistInactiveState() {
    if (lastPersistedSessionState === false) return;
    const generation = reconnectGeneration;

    await DataStore.set(DATASTORE_SESSION_KEY, false);
    if (generation === reconnectGeneration) cachePersistedState(null, false);
}

async function waitForChannel(channelId: string, generation: number) {
    if (generation !== reconnectGeneration) return;
    let channel = ChannelStore.getChannel(channelId);
    for (let i = 0; i < 20 && !channel; i++) {
        await sleep(250);
        if (generation !== reconnectGeneration) return;
        channel = ChannelStore.getChannel(channelId);
    }
    return channel;
}

function hasOtherUsersInChannel(channelId: string, myUserId: string) {
    const connectedUsers = VoiceStateStore.getVoiceStatesForChannel(channelId) as Record<string, VoiceState> | undefined;
    if (!connectedUsers) return false;

    for (const voiceState of Object.values(connectedUsers)) {
        if (voiceState.userId !== myUserId) return true;
    }

    return false;
}

export default definePlugin({
    name: "VoiceRejoin",
    description: "Rejoins DM/Server call automatically when restarting Discord.",
    tags: ["Servers", "Utility", "Voice"],
    authors: [EquicordDevs.omaw, EquicordDevs.keircn],
    settings,

    flux: {
        LOGOUT() {
            cancelReconnectAttempt();
            resetPersistCache();
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) return;

            const myUserId = currentUser.id;
            let myState: VoiceState | undefined;
            for (const voiceState of voiceStates) {
                if (voiceState.userId !== myUserId) continue;
                myState = voiceState;
                break;
            }
            if (!myState) return;
            cancelReconnectAttempt();

            if (myState.channelId) {
                void persistActiveState(myState)
                    .catch(err => logger.error("Failed to persist last voice channel", err));
            } else {
                void persistInactiveState()
                    .catch(err => logger.error("Failed to persist voice session state", err));
            }
        },

        async CONNECTION_OPEN() {
            cancelReconnectAttempt();
            const scheduledGeneration = reconnectGeneration;

            const wasInVC = await DataStore.get(DATASTORE_SESSION_KEY);
            if (scheduledGeneration !== reconnectGeneration) return;

            if (wasInVC === false) {
                await DataStore.del(DATASTORE_KEY);
                if (scheduledGeneration === reconnectGeneration) resetPersistCache();
                return;
            }

            reconnectTimeoutId = setTimeout(async () => {
                reconnectTimeoutId = undefined;
                if (scheduledGeneration !== reconnectGeneration) return;

                try {
                    const saved = await DataStore.get<SavedVoiceChannel>(DATASTORE_KEY);
                    if (!saved?.channelId) return;

                    const channel = await waitForChannel(saved.channelId, scheduledGeneration);
                    if (scheduledGeneration !== reconnectGeneration) return;

                    if (!channel) {
                        await persistInactiveState();
                        return;
                    }

                    const currentUser = UserStore.getCurrentUser();
                    if (!currentUser) return;

                    const isDM = channel.isDM() || channel.isGroupDM() || channel.isMultiUserDM();
                    const myUserId = currentUser.id;
                    const myVoiceState = VoiceStateStore.getVoiceStateForUser(myUserId);
                    if (myVoiceState?.channelId) return;

                    const preventionMode = settings.store.preventReconnectIfCallEnded;
                    const timeoutMs = settings.store.rejoinTimeout * 1000;

                    if (saved.timestamp && Date.now() - saved.timestamp > timeoutMs) {
                        await persistInactiveState();
                        return;
                    }

                    if (settings.store.applyOnlyToDms && !isDM) {
                        await persistInactiveState();
                        return;
                    }

                    if (preventionMode !== "none") {
                        const shouldPrevent =
                            preventionMode === "both" ||
                            (preventionMode === "dms" && isDM) ||
                            (preventionMode === "servers" && !isDM);

                        if (shouldPrevent) {
                            if (!hasOtherUsersInChannel(saved.channelId, myUserId)) {
                                await persistInactiveState();
                                return;
                            }
                        }
                    }

                    FluxDispatcher.dispatch({
                        type: "VOICE_CHANNEL_SELECT",
                        guildId: saved.guildId,
                        channelId: saved.channelId,
                    });

                    await DataStore.set(DATASTORE_SESSION_KEY, true);
                    if (scheduledGeneration === reconnectGeneration) cachePersistedState(saved, true);
                } catch (err) {
                    logger.error("Failed to run voice rejoin", err);
                }
            }, settings.store.rejoinDelay * 1000);
        },
    },

    stop() {
        cancelReconnectAttempt();
        resetPersistCache();
    },
});
