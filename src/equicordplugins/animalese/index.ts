/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { SelectedChannelStore, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    volume: {
        type: OptionType.SLIDER,
        description: "Volume of the animalese sound",
        default: 0.5,
        markers: [0, 0.1, 0.25, 0.5, 0.6, 0.75, 1],
    },
    speed: {
        type: OptionType.SLIDER,
        description: "Speed of the animalese sound",
        default: 1,
        markers: [0.5, 0.75, 1, 1.25, 1.5],
    },
    pitch: {
        type: OptionType.SLIDER,
        description: "Pitch multiplier",
        default: 1,
        markers: [0.75, 0.8, 0.85, 1, 1.15, 1.25, 1.35, 1.5],
    },
    messageLengthLimit: {
        type: OptionType.NUMBER,
        description: "Maximum length of message to process",
        default: 50,
    },
    processOwnMessages: {
        type: OptionType.BOOLEAN,
        description: "Enable to yap your own messages too",
        default: true,
    },
    soundQuality: {
        type: OptionType.SELECT,
        description: "Quality of sound to use",
        options: [
            {
                label: "High",
                value: "high",
                default: true
            },
            {
                label: "Medium",
                value: "med"
            },
            {
                label: "Low",
                value: "low"
            }
        ],
        onChange: () => {
            if (audioContext) void initSoundBuffers();
            else clearSoundBuffers();
        }
    }
});

let audioContext: AudioContext | null = null;
let loadedSoundQuality: string | null = null;
let soundLoad: { quality: string; controller: AbortController; promise: Promise<void>; } | undefined;
const logger = new Logger("Animalese");
const urlPattern = /https?:\/\/[^\s]+/;
const LETTER_SLOT_SECONDS = 0.09;
const MIN_PLAYBACK_SPEED = 0.1;
const MIN_PITCH_SHIFT = 0.1;

// better than my old hardcoded garbage
const highSounds = Array.from(
    { length: 30 },
    (_, i) => `sound${String(i + 1).padStart(2, "0")}.wav`
);
const soundBuffers: Record<string, AudioBuffer> = {};

const BASE_URL_HIGH = "https://raw.githubusercontent.com/Equicord/Equibored/main/sounds/animalese";

function getAudioContext() {
    return audioContext ??= new AudioContext();
}

function clearSoundBuffers() {
    for (const key of Object.keys(soundBuffers)) {
        delete soundBuffers[key];
    }
    loadedSoundQuality = null;
}

async function initSoundBuffers() {
    const context = getAudioContext();
    const quality = settings.store.soundQuality;
    if (soundLoad?.quality === quality) return soundLoad.promise;
    soundLoad?.controller.abort();
    soundLoad = undefined;
    if (loadedSoundQuality === quality) return;
    const controller = new AbortController();

    const promise = Promise.all(
        highSounds.map(async file => {
            const nameWithoutExt = file.replace(".wav", "");
            const buffer = await loadSound(context, `${BASE_URL_HIGH}/${quality}/${file}`, controller.signal);
            return [nameWithoutExt, buffer] as const;
        })
    ).then(entries => {
        if (controller.signal.aborted || audioContext !== context) return;

        clearSoundBuffers();
        for (const [name, buffer] of entries) {
            soundBuffers[name] = buffer;
        }
        loadedSoundQuality = quality;
    }).catch(error => {
        if (!controller.signal.aborted) logger.error("Failed to load sounds", error);
        controller.abort();
    }).finally(() => {
        if (soundLoad?.promise === promise) soundLoad = undefined;
    });

    soundLoad = { quality, controller, promise };
    return promise;
}

async function loadSound(context: AudioContext, url: string, signal: AbortSignal): Promise<AudioBuffer> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Network response was not OK");
    const arrayBuffer = await response.arrayBuffer();
    return context.decodeAudioData(arrayBuffer);
}

function generateAnimalese(text: string): AudioBuffer | null {
    const context = getAudioContext();
    const speed = Math.max(settings.store.speed ?? 1, MIN_PLAYBACK_SPEED);
    const pitch = settings.store.pitch ?? 1;

    const soundIndices: string[] = [];
    const text_lower = text.toLowerCase();

    for (let i = 0; i < text_lower.length; i++) {
        const char = text_lower[i];
        if (char === "s" && text_lower[i + 1] === "h") {
            soundIndices.push("sound27");
            i++;
        } else if (char === "t" && text_lower[i + 1] === "h") {
            soundIndices.push("sound28");
            i++;
        } else if (
            char === "h" &&
            (text_lower[i - 1] === "s" || text_lower[i - 1] === "t")
        ) {
            continue;
        } else if (char === "," || char === "?") {
            soundIndices.push("sound30");
        } else if (char === text_lower[i - 1]) {
            continue;
        } else {
            const charCode = char.charCodeAt(0);
            if (charCode < 97 || charCode > 122) continue;

            const index = char.charCodeAt(0) - 96;
            soundIndices.push(`sound${String(index).padStart(2, "0")}`);
        }
    }

    // No valid characters? Just return null
    if (soundIndices.length === 0) {
        return null;
    }

    const baseLetterDuration = Math.floor(context.sampleRate * (LETTER_SLOT_SECONDS / speed));
    const minPitchShift = Math.max(2.8 * pitch, MIN_PITCH_SHIFT);
    const maxSoundFrames = soundIndices.reduce((maxFrames, soundIndex) => {
        const buffer = soundBuffers[soundIndex];
        return buffer ? Math.max(maxFrames, Math.ceil(buffer.length / minPitchShift)) : maxFrames;
    }, 0);
    const frameCount = Math.max(1, ((soundIndices.length - 1) * baseLetterDuration) + maxSoundFrames);

    const outputBuffer = context.createBuffer(
        1,
        frameCount,
        context.sampleRate
    );
    const outputData = outputBuffer.getChannelData(0);

    let offset = 0;

    for (let i = 0; i < soundIndices.length; i++) {
        const buffer = soundBuffers[soundIndices[i]];
        if (!buffer) continue;

        const variation = 0.15;
        let pitchShift = (2.8 * pitch) + (Math.random() * variation);

        const isQuestion = text_lower.endsWith("?");
        if (isQuestion && i >= soundIndices.length * 0.8) {
            const progress =
                (i - soundIndices.length * 0.8) / (soundIndices.length * 0.2);
            pitchShift += progress * 0.1 + 0.1;
        }

        const inputData = buffer.getChannelData(0);
        const inputLength = inputData.length;
        const outputLength = Math.floor(inputLength / pitchShift);

        // copy sound into the slot
        for (let j = 0; j < outputLength; j++) {
            const inputIndex = Math.floor(j * pitchShift);
            const targetIndex = offset + j;
            if (inputIndex < inputLength && targetIndex < outputData.length) {
                outputData[targetIndex] = inputData[inputIndex];
            }
        }

        // instead of stacking lengths, jump forward a *fixed slot* per character
        offset += Math.floor(baseLetterDuration);
    }

    return outputBuffer;
}

function playSound(buffer: AudioBuffer, volume: number) {
    const context = getAudioContext();
    const source = context.createBufferSource();
    const gainNode = context.createGain();

    source.buffer = buffer;
    source.playbackRate.value = settings.store.pitch ?? 1;
    gainNode.gain.value = Math.min(Math.max(volume, 0), 1);

    source.connect(gainNode);
    gainNode.connect(context.destination);

    source.start();
}

export default definePlugin({
    name: "Animalese",
    performance: { impact: "high", description: "Synthesizes and plays audio for messages in the selected channel." },
    description: "Plays animal crossing animalese for every message sent (they yap a lot)",
    tags: ["Customisation", "Fun"],
    authors: [EquicordDevs.ryanamay, EquicordDevs.Mocha],
    settings,

    flux: {
        async MESSAGE_CREATE({ optimistic, type, message, channelId }) {
            if (optimistic || type !== "MESSAGE_CREATE") return;
            if (message.state === "SENDING") return;
            const { content } = message;
            if (!content || message.author?.bot || channelId !== SelectedChannelStore.getChannelId()) return;

            const maxLength = settings.store.messageLengthLimit || 100;
            const processOwnMessages = settings.store.processOwnMessages ?? true;
            const authorId = message.author?.id;

            if (
                urlPattern.test(content)
                || content.length > maxLength
            ) return;

            if (!processOwnMessages) {
                const currentUserId = UserStore.getCurrentUser()?.id;
                if (!currentUserId || authorId === currentUserId) return;
            }

            const context = getAudioContext();
            await initSoundBuffers();
            if (audioContext !== context || loadedSoundQuality !== settings.store.soundQuality) return;
            const buffer = generateAnimalese(content);
            if (buffer) playSound(buffer, settings.store.volume);
        }
    },

    start() {
        void initSoundBuffers();
    },

    stop() {
        soundLoad?.controller.abort();
        soundLoad = undefined;
        if (audioContext) {
            void audioContext.close().catch(error => logger.error("Failed to close audio", error));
            audioContext = null;
        }
        clearSoundBuffers();
    },
});
