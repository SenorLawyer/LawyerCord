/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { ChannelStore, FluxDispatcher, GuildMemberStore, StreamerModeStore, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

const logger = new Logger("OrbolayBridge");
const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "Local Orbolay server port.",
        default: 6888,
        restartNeeded: true,
        isValid: value => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 || "Enter a port between 1 and 65535."
    },
});

let active = false;
let ws: WebSocket | null = null;
let accountId: string | undefined;
let currentChannel: string | null = null;
let connectTimeout: ReturnType<typeof setTimeout> | undefined;

function clearConnectTimeout() {
    if (connectTimeout === undefined) return;
    clearTimeout(connectTimeout);
    connectTimeout = undefined;
}

function closeWebsocket() {
    clearConnectTimeout();
    const socket = ws;
    ws = null;
    currentChannel = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
}

function send(payload: object) {
    if (ws?.readyState === WebSocket.OPEN && UserStore.getCurrentUser()?.id === accountId)
        ws.send(JSON.stringify(payload));
}

function stateToPayload(guildId: string | undefined, state: VoiceState) {
    const user = UserStore.getUser(state.userId);
    return {
        userId: state.userId,
        username: guildId && GuildMemberStore.getNick(guildId, state.userId) || user?.globalName,
        avatarUrl: user?.avatar,
        channelId: state.channelId,
        deaf: state.deaf || state.selfDeaf,
        mute: state.mute || state.selfMute,
        streaming: state.selfStream,
        speaking: false,
    };
}

function sendChannel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return;
    send({
        cmd: "CHANNEL_JOINED",
        states: Object.values(VoiceStateStore.getVoiceStatesForChannel(channelId)).map(state => stateToPayload(channel.guild_id, state))
    });
    currentChannel = channelId;
}

function incoming(payload: unknown) {
    if (!payload || typeof payload !== "object" || !("cmd" in payload)) return;
    switch (payload.cmd) {
        case "TOGGLE_MUTE":
        case "TOGGLE_DEAF":
            FluxDispatcher.dispatch({
                type: payload.cmd === "TOGGLE_MUTE" ? "AUDIO_TOGGLE_SELF_MUTE" : "AUDIO_TOGGLE_SELF_DEAF",
                syncRemote: true,
                playSoundEffect: true,
                context: "default"
            });
            break;
        case "DISCONNECT":
            FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: null });
            break;
        case "STOP_STREAM": {
            if (!accountId) return;
            const voiceState = VoiceStateStore.getVoiceStateForUser(accountId);
            if (!voiceState?.channelId) return;
            const channel = ChannelStore.getChannel(voiceState.channelId);
            if (!channel) return;
            FluxDispatcher.dispatch({
                type: "STREAM_STOP",
                streamKey: `guild:${channel.guild_id}:${voiceState.channelId}:${accountId}`,
                appContext: "APP"
            });
            break;
        }
        case "NAVIGATE": {
            if (!("guild_id" in payload) || !("channel_id" in payload) || !("message_id" in payload)) return;
            const { guild_id, channel_id, message_id } = payload;
            if (![guild_id, channel_id, message_id].every(id => typeof id === "string" && /^\d{17,20}$/.test(id))) return;
            FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", guildId: guild_id, channelId: channel_id, messageId: message_id });
            break;
        }
    }
}

function createWebsocket() {
    closeWebsocket();
    accountId = UserStore.getCurrentUser()?.id;
    if (!active || !accountId) return;
    const { port } = settings.store;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        logger.warn("Invalid Orbolay server port.");
        return;
    }
    const userId = accountId;
    // Use the configured port locally to open the websocket, but do not include it in REGISTER_CONFIG
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    ws = socket;
    const isCurrent = () => ws === socket && UserStore.getCurrentUser()?.id === userId;
    const failed = () => {
        if (!isCurrent()) return;
        closeWebsocket();
        Toasts.show({ message: "Orbolay could not connect. Is the server running?", type: Toasts.Type.FAILURE, id: Toasts.genId() });
    };
    connectTimeout = setTimeout(failed, 1000);
    socket.onerror = failed;
    socket.onclose = () => {
        if (!isCurrent()) return;
        clearConnectTimeout();
        ws = null;
        currentChannel = null;
    };
    socket.onmessage = event => {
        if (!isCurrent() || socket.readyState !== WebSocket.OPEN || typeof event.data !== "string" || event.data.length > 4096) return;
        let payload: unknown;
        try {
            payload = JSON.parse(event.data);
        } catch {
            logger.warn("Invalid Orbolay message.");
            return;
        }
        incoming(payload);
    };
    socket.onopen = () => {
        if (!isCurrent()) return;
        clearConnectTimeout();
        Toasts.show({ message: "Connected to Orbolay server", type: Toasts.Type.SUCCESS, id: Toasts.genId() });
        send({ cmd: "REGISTER_CONFIG", userId });
        // Let the client know whether we are in streamer mode
        send({ cmd: "STREAMER_MODE", enabled: StreamerModeStore.enabled });
        const voiceState = VoiceStateStore.getVoiceStateForUser(userId);
        if (voiceState?.channelId) sendChannel(voiceState.channelId);
    };
}

function onAccountChange() {
    if (active && UserStore.getCurrentUser()?.id !== accountId) createWebsocket();
}

export default definePlugin({
    name: "OrbolayBridge",
    description: "Bridge plugin to connect Orbolay to Discord.",
    tags: ["Utility", "Voice"],
    authors: [EquicordDevs.SpikeHD],
    settings,
    flux: {
        SPEAKING(event: { userId: string; speakingFlags: number; }) {
            send({ cmd: "VOICE_STATE_UPDATE", state: { userId: event.userId, speaking: event.speakingFlags === 1 } });
        },
        RPC_NOTIFICATION_CREATE(event: { title: string; body: string; icon: string; message: { guild_id?: string; channel_id: string; id: string; }; }) {
            send({ cmd: "MESSAGE_NOTIFICATION", message: {
                title: event.title, body: event.body, icon: event.icon,
                guildId: event.message.guild_id, channelId: event.message.channel_id, messageId: event.message.id
            } });
        },
        VOICE_STATE_UPDATES(event: { voiceStates: VoiceState[]; }) {
            if (ws?.readyState !== WebSocket.OPEN) return;
            for (const state of event.voiceStates) {
                if (state.userId === accountId) {
                    if (state.channelId && state.channelId !== currentChannel) {
                        sendChannel(state.channelId);
                        break;
                    }
                    if (!state.channelId) {
                        send({ cmd: "CHANNEL_LEFT" });
                        currentChannel = null;
                        break;
                    }
                }
                if (currentChannel && (state.channelId === currentChannel || state.oldChannelId === currentChannel))
                    send({ cmd: "VOICE_STATE_UPDATE", state: stateToPayload(state.guildId, state) });
            }
        },
        STREAMER_MODE(event: { value: boolean; }) {
            send({ cmd: "STREAMER_MODE", enabled: event.value });
        },
    },
    start() {
        active = true;
        UserStore.addChangeListener(onAccountChange);
        createWebsocket();
    },
    stop() {
        active = false;
        UserStore.removeChangeListener(onAccountChange);
        closeWebsocket();
        accountId = undefined;
    }
});
