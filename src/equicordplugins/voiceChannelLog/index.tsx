/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { ApplicationStore, ChannelStore, Menu, RelationshipStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { LogIcon, OpenLogsButton } from "./components/LogsButton";
import { openVoiceChannelLog } from "./components/VoiceChannelLogModal";
import { addLogEntry, setCallStartTime } from "./logs";
import settings from "./settings";
import { EmbeddedActivityEvent, PreviousVoiceState, SoundEvent, VoiceChannelLogEntry, VoiceState } from "./types";

const ApplicationActions = findByPropsLazy("fetchApplication");

const loggedActivityUsersByApp = new Map<string, Set<string>>();
const previousStates = new Map<string, PreviousVoiceState>();
const existingUsers = new Set<string>();
let sessionGeneration = 0;

let clientOldChannelId: string | undefined;
let clientJoinedAt = 0;

type VoiceStateSnapshotInput = Omit<PreviousVoiceState, "selfStream" | "channelId"> & {
    channelId?: string | null;
    selfStream?: boolean;
};

function getSelectedVoiceChannelId(): string | undefined {
    return SelectedChannelStore?.getVoiceChannelId?.();
}

function isMyChannel(channelId?: string): boolean {
    return !!channelId && getSelectedVoiceChannelId() === channelId;
}

function getCurrentUserId(): string | undefined {
    return UserStore.getCurrentUser()?.id;
}

function shouldLog(userId: string): boolean {
    return !(settings.store.ignoreBlockedUsers && RelationshipStore.isBlocked(userId));
}

function log(entry: Omit<VoiceChannelLogEntry, "timestamp">) {
    addLogEntry({ ...entry, timestamp: new Date() });
}

function getActivityName(appId: string) {
    const app = ApplicationStore.getApplication(appId);
    if (app) return Promise.resolve(app.name);

    return ApplicationActions.fetchApplication(appId)
        .then(fetched => fetched?.name ?? "Unknown activity")
        .catch(() => "Unknown activity");
}

function rememberPreviousState(userId: string, state: VoiceStateSnapshotInput) {
    previousStates.set(userId, {
        mute: state.mute,
        deaf: state.deaf,
        selfVideo: state.selfVideo,
        selfStream: state.selfStream ?? false,
        channelId: state.channelId ?? undefined
    });
}

function clearSessionState() {
    sessionGeneration++;
    previousStates.clear();
    loggedActivityUsersByApp.clear();
    existingUsers.clear();
    clientOldChannelId = undefined;
    clientJoinedAt = 0;
    setCallStartTime(null);
}

const VOICE_CHANNEL_TYPES = new Set([ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE, ChannelType.DM, ChannelType.GROUP_DM]);

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || !VOICE_CHANNEL_TYPES.has(channel.type)) return;
    children.push(
        <Menu.MenuItem
            id="vc-view-voice-channel-logs"
            label="View Voice Channel Logs"
            action={() => openVoiceChannelLog(channel)}
        />
    );
};

export default definePlugin({
    name: "VoiceChannelLog",
    description: "Logs voice channel activity including joins, leaves, soundboard, mute, camera, screenshare, and more.",
    tags: ["Servers", "Utility", "Voice"],
    authors: [Devs.Sqaaakoi, Devs.thororen, EquicordDevs.nyx, Devs.Moxxie, EquicordDevs.Fres, Devs.amy],
    dependencies: ["AudioPlayerAPI", "HeaderBarAPI"],
    settings,
    contextMenus: {
        "channel-context": patchChannelContextMenu
    },

    toolboxActions: {
        "Voice Channel Logs"() {
            const channelId = getSelectedVoiceChannelId();
            if (!channelId) return;
            const channel = ChannelStore.getChannel(channelId);
            if (channel) openVoiceChannelLog(channel);
        }
    },

    headerBarButton: {
        icon: LogIcon,
        render: OpenLogsButton
    },

    flux: {
        VOICE_CHANNEL_SELECT({ channelId, currentVoiceChannelId }: { channelId: string | null; currentVoiceChannelId: string | null; }) {
            const leaving = channelId == null && currentVoiceChannelId != null;
            const joining = channelId != null && currentVoiceChannelId == null;
            const oldChannel = currentVoiceChannelId ?? clientOldChannelId;

            if (channelId !== oldChannel) sessionGeneration++;
            clientOldChannelId = channelId ?? undefined;

            if (leaving && oldChannel) {
                const userId = getCurrentUserId();
                if (!userId) return;

                if (settings.store.logJoinLeave) {
                    log({ type: "leave", userId, channelId: oldChannel });
                }
                clearSessionState();
            } else if (joining && channelId && channelId !== oldChannel) {
                const userId = getCurrentUserId();
                if (!userId) return;

                previousStates.clear();
                loggedActivityUsersByApp.clear();
                existingUsers.clear();
                clientJoinedAt = Date.now();
                setCallStartTime(new Date());
                if (settings.store.logJoinLeave) {
                    log({ type: "join", userId, channelId });
                }
            }
        },

        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const clientUserId = getCurrentUserId();
            if (!clientUserId) return;

            const selectedVoiceChannelId = getSelectedVoiceChannelId();
            const suppressJoins = Date.now() - clientJoinedAt < 5000;
            const isSelectedChannel = (channelId?: string | null) => !!channelId && selectedVoiceChannelId === channelId;
            const { logJoinLeave, logMuteDeafen, logVideo, logStream } = settings.store;

            for (const state of voiceStates) {
                const { userId } = state;
                const { channelId, oldChannelId } = state;

                if (userId === clientUserId) continue;
                if (!shouldLog(userId)) continue;

                if (oldChannelId === channelId && !previousStates.has(userId)) {
                    rememberPreviousState(userId, state);
                    continue;
                }

                const prev = previousStates.get(userId);
                const inMyChannel = isSelectedChannel(channelId) || isSelectedChannel(oldChannelId);

                if (oldChannelId !== channelId) {
                    if (!oldChannelId && channelId) {
                        const skipJoin = suppressJoins || existingUsers.delete(userId);
                        if (!skipJoin && logJoinLeave && isSelectedChannel(channelId)) {
                            log({ type: "join", userId, channelId });
                        }
                    } else if (oldChannelId && !channelId) {
                        if (logJoinLeave && isSelectedChannel(oldChannelId)) {
                            log({ type: "leave", userId, channelId: oldChannelId });
                        }
                    } else if (oldChannelId && channelId) {
                        if (logJoinLeave) {
                            if (isSelectedChannel(oldChannelId)) {
                                log({ type: "move", userId, channelId: oldChannelId, oldChannelId, newChannelId: channelId });
                            }
                            if (isSelectedChannel(channelId)) {
                                log({ type: "move", userId, channelId, oldChannelId, newChannelId: channelId });
                            }
                        }
                    }
                }

                if (prev && channelId && inMyChannel) {
                    if (logMuteDeafen) {
                        if (state.mute !== prev.mute) {
                            log({ type: "server_mute", userId, channelId, enabled: state.mute });
                        }
                        if (state.deaf !== prev.deaf) {
                            log({ type: "server_deafen", userId, channelId, enabled: state.deaf });
                        }
                    }

                    if (logVideo && state.selfVideo !== prev.selfVideo) {
                        log({ type: "self_video", userId, channelId, enabled: state.selfVideo });
                    }

                    if (logStream && (state.selfStream ?? false) !== prev.selfStream) {
                        log({ type: "self_stream", userId, channelId, enabled: state.selfStream ?? false });
                    }
                }

                rememberPreviousState(userId, state);

                if (!channelId) {
                    previousStates.delete(userId);
                }
            }
        },

        EMBEDDED_ACTIVITY_UPDATE_V2(event: EmbeddedActivityEvent) {
            if (!settings.store.logActivity) return;

            const channelId = event.location?.channel_id;
            if (!channelId || !isMyChannel(channelId)) return;

            const appId = event.applicationId;
            const currentUserIds = new Set((event.participants ?? []).map(p => p.user_id));
            let loggedUsers = loggedActivityUsersByApp.get(appId);
            if (!loggedUsers) {
                loggedUsers = new Set();
                loggedActivityUsersByApp.set(appId, loggedUsers);
            }

            const joined: string[] = [];
            for (const p of event.participants ?? []) {
                if (!shouldLog(p.user_id)) continue;
                if (loggedUsers.has(p.user_id)) continue;
                loggedUsers.add(p.user_id);
                joined.push(p.user_id);
            }

            const left: string[] = [];
            for (const userId of loggedUsers) {
                if (!currentUserIds.has(userId)) {
                    loggedUsers.delete(userId);
                    left.push(userId);
                }
            }

            if (loggedUsers.size === 0) {
                loggedActivityUsersByApp.delete(appId);
            }

            if (!joined.length && !left.length) return;

            const generation = sessionGeneration;
            const accountId = getCurrentUserId();
            const logWithName = (activityName: string) => {
                if (generation !== sessionGeneration || accountId !== getCurrentUserId() || !isMyChannel(channelId)) return;
                for (const userId of joined)
                    log({ type: "activity", userId, channelId, activityName, applicationId: appId });
                for (const userId of left)
                    log({ type: "activity_stop", userId, channelId, activityName, applicationId: appId });
            };

            void getActivityName(appId).then(logWithName);
        },

        VOICE_CHANNEL_EFFECT_SEND(event: SoundEvent) {
            if (!settings.store.logSoundboard) return;
            if (!event.soundId) return;
            if (!isMyChannel(event.channelId)) return;
            if (!shouldLog(event.userId)) return;

            log({
                type: "soundboard",
                userId: event.userId,
                channelId: event.channelId,
                soundId: event.soundId,
                emoji: event.emoji
            });
        }
    },

    start() {
        clearSessionState();
        const userId = getCurrentUserId();
        if (!userId) return;

        clientOldChannelId = getSelectedVoiceChannelId() ?? undefined;
        if (clientOldChannelId) {
            clientJoinedAt = Date.now();
            setCallStartTime(new Date());
            if (settings.store.logJoinLeave) {
                log({ type: "join", userId, channelId: clientOldChannelId });
            }
            const states = VoiceStateStore.getVoiceStatesForChannel(clientOldChannelId);
            if (!states) return;

            for (const [userId, s] of Object.entries(states)) {
                existingUsers.add(userId);
                rememberPreviousState(userId, s);
            }
        }
    },

    stop() {
        clearSessionState();
    }
});
