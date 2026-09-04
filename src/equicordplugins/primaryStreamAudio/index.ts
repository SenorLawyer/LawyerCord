/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelRTCStore, SelectedChannelStore } from "@webpack/common";

import { getEffectiveVolume, MIN_VIDEO_AREA, type PrimaryStreamAudioStores, type StreamAudioData, UPDATE_INTERVAL_MS } from "./logic";

let updateInterval: number | undefined;
const trackedAudio = new Set<StreamAudioData>();

const stores: PrimaryStreamAudioStores = {
    channelRTCStore: ChannelRTCStore,
    selectedChannelStore: SelectedChannelStore,
};

function mediaStreamsMatch(a?: MediaStream | null, b?: MediaStream | null) {
    if (!a || !b) return false;
    if (a === b || a.id === b.id) return true;

    const trackIds = new Set(a.getTracks().map(track => track.id));
    return b.getTracks().some(track => trackIds.has(track.id));
}

function visibleVideoArea(video: HTMLVideoElement) {
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 0;

    const style = getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return 0;

    return rect.width * rect.height;
}

type DomStreamAudioState = { primaryAudio: StreamAudioData | null; streamAudio: Set<StreamAudioData>; };

function getDomStreamAudioState(): DomStreamAudioState {
    let primary: { area: number; data: StreamAudioData; } | null = null;
    const streamAudio = new Set<StreamAudioData>();

    for (const video of document.querySelectorAll("video")) {
        const area = visibleVideoArea(video);
        if (area < MIN_VIDEO_AREA) continue;

        const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
        if (!stream) continue;

        for (const data of trackedAudio) {
            if (!mediaStreamsMatch(stream, data.stream)) continue;
            streamAudio.add(data);
            if (!primary || area > primary.area) primary = { area, data };
        }
    }

    return {
        primaryAudio: primary?.data ?? null,
        streamAudio
    };
}

function streamEnded(stream: MediaStream) {
    return !stream.active || stream.getTracks().every(track => track.readyState === "ended");
}

function pruneTrackedAudio() {
    for (const data of trackedAudio) {
        const element = data.audioElement;
        if (data.stream && streamEnded(data.stream)) {
            trackedAudio.delete(data);
            continue;
        }

        if (element && !element.isConnected && element.paused && element.readyState === 0) {
            trackedAudio.delete(data);
        }
    }
}

function applyAudioState(data: StreamAudioData, domState: DomStreamAudioState) {
    const volume = getEffectiveVolume(data, trackedAudio, stores, domState);

    if (data.gainNode) {
        if (data.audioElement) data.audioElement.volume = 0;
        data.gainNode.gain.value = volume;
        return;
    }

    if (data.audioElement) data.audioElement.volume = Math.min(volume, 1);
}

function updateTrackedAudio() {
    pruneTrackedAudio();
    if (!trackedAudio.size) return;
    // Reading the DOM state measures every video element, which forces a layout. Once per tick
    // is enough: setting a gain or volume cannot move anything on the page.
    const domState = getDomStreamAudioState();
    for (const data of trackedAudio) applyAudioState(data, domState);
}

function scheduleUpdateTrackedAudio() {
    queueMicrotask(updateTrackedAudio);
}

export default definePlugin({
    name: "PrimaryStreamAudio",
    description: "Only plays audio from the currently focused/big screenshare stream.",
    tags: ["Media", "Voice", "Utility"],
    authors: [EquicordDevs.nobody],
    enabledByDefault: true,

    patches: [
        {
            find: "streamSourceNode",
            replacement: [
                {
                    match: /updateAudioElement\(\)\{/,
                    replace: "$&$self.trackStreamAudio(this);"
                },
                {
                    match: /(\.volume=)this\._volume\/100;/,
                    replace: "$1$self.getAudioElementVolume(this);$self.trackStreamAudio(this);",
                    noWarn: true
                }
            ]
        }
    ],

    start() {
        updateInterval = window.setInterval(updateTrackedAudio, UPDATE_INTERVAL_MS);
    },

    stop() {
        if (updateInterval != null) {
            window.clearInterval(updateInterval);
            updateInterval = undefined;
        }

        for (const data of trackedAudio) {
            const volume = data._mute ? 0 : Math.max(0, (data._volume ?? 100) / 100);
            if (data.gainNode) {
                if (data.audioElement) data.audioElement.volume = 0;
                data.gainNode.gain.value = volume;
            } else if (data.audioElement) {
                data.audioElement.volume = Math.min(volume, 1);
            }
        }

        trackedAudio.clear();
    },

    trackStreamAudio(data: StreamAudioData) {
        trackedAudio.add(data);
        scheduleUpdateTrackedAudio();
    },

    getAudioElementVolume(data: StreamAudioData) {
        trackedAudio.add(data);
        return Math.min(getEffectiveVolume(data, trackedAudio, stores, getDomStreamAudioState()), 1);
    },

    flux: {
        CHANNEL_RTC_SELECT_PARTICIPANT: scheduleUpdateTrackedAudio,
        STREAM_CREATE: scheduleUpdateTrackedAudio,
        STREAM_DELETE: scheduleUpdateTrackedAudio,
        STREAM_STOP: scheduleUpdateTrackedAudio,
        STREAM_UPDATE: scheduleUpdateTrackedAudio,
        STREAM_WATCH: scheduleUpdateTrackedAudio,
        VOICE_CHANNEL_SELECT: scheduleUpdateTrackedAudio,
        AUDIO_SET_LOCAL_VOLUME: scheduleUpdateTrackedAudio,
        AUDIO_TOGGLE_LOCAL_MUTE: scheduleUpdateTrackedAudio,
    },
});
