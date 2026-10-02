/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sleep } from "@utils/misc";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { Message, ReactionEmoji } from "@vencord/discord-types";
import { RelationshipStore, SelectedChannelStore, UserStore } from "@webpack/common";

interface IMessageCreate {
    type: "MESSAGE_CREATE";
    optimistic: boolean;
    isPushNotification: boolean;
    channelId: string;
    message: Message;
}

interface IReactionAdd {
    type: "MESSAGE_REACTION_ADD";
    optimistic: boolean;
    channelId: string;
    messageId: string;
    messageAuthorId: string;
    userId: "195136840355807232";
    emoji: ReactionEmoji;
}

interface IVoiceChannelEffectSendEvent {
    type: string;
    emoji?: ReactionEmoji; // Just in case...
    channelId: string;
    userId: string;
    animationType: number;
    animationId: number;
}

let generation = 0;
const bursts = new Set<symbol>();
const activeAudio = new Set<HTMLAudioElement>();

const MOYAI = "🗿";
const MOYAI_URL = "https://github.com/Equicord/Equibored/raw/main/sounds/moyai/moyai.mp3";
const MOYAI_URL_HD = "https://github.com/Equicord/Equibored/raw/main/sounds/moyai/moyai.wav";
const customMoyaiRe = /<a?:\w*moy?ai\w*:\d{17,20}>/gi;

const settings = definePluginSettings({
    volume: {
        description: "Volume of the 🗿🗿🗿",
        type: OptionType.SLIDER,
        markers: makeRange(0, 1, 0.1),
        default: 0.5,
        stickToMarkers: false
    },
    quality: {
        description: "Quality of the 🗿🗿🗿",
        type: OptionType.SELECT,
        options: [
            { label: "Normal", value: "Normal", default: true },
            { label: "HD", value: "HD" }
        ],
    },
    triggerWhenUnfocused: {
        description: "Trigger the 🗿 even when the window is unfocused",
        type: OptionType.BOOLEAN,
        default: true
    },
    ignoreBots: {
        description: "Ignore bots",
        type: OptionType.BOOLEAN,
        default: true
    },
    ignoreBlocked: {
        description: "Ignore blocked users",
        type: OptionType.BOOLEAN,
        default: true
    }
});

export default definePlugin({
    name: "Moyai",
    performance: {
        impact: "medium",
        description: "Plays sound effects for matching messages, reactions and voice effects."
    },
    authors: [Devs.Megu, Devs.Nuckyz],
    description: "Plays a 🗿 sound effect whenever a moyai emoji is sent, reacted, or used as a voice effect in your current channel.",
    tags: ["Fun"],
    settings,

    stop() {
        generation++;
        bursts.clear();
        for (const audio of activeAudio) releaseAudio(audio);
    },

    flux: {
        async MESSAGE_CREATE({ optimistic, type, message, channelId }: IMessageCreate) {
            if (optimistic || type !== "MESSAGE_CREATE") return;
            if (message.state === "SENDING") return;
            if (channelId !== SelectedChannelStore.getChannelId()) return;

            const { content } = message;
            if (!content) return;

            const authorId = message.author?.id;
            if (settings.store.ignoreBots && message.author?.bot) return;
            if (settings.store.ignoreBlocked && authorId && RelationshipStore.isBlocked(authorId)) return;

            const moyaiCount = getMoyaiCount(content);

            if (!moyaiCount || bursts.size >= 4) return;
            const burst = Symbol();
            const current = generation;
            bursts.add(burst);
            try {
                for (let i = 0; i < moyaiCount && current === generation; i++) {
                    boom();
                    await sleep(300);
                }
            } finally {
                bursts.delete(burst);
            }
        },

        MESSAGE_REACTION_ADD({ optimistic, type, channelId, userId, messageAuthorId, emoji }: IReactionAdd) {
            if (optimistic || type !== "MESSAGE_REACTION_ADD") return;
            if (channelId !== SelectedChannelStore.getChannelId()) return;

            const name = emoji.name?.toLowerCase();
            if (!name) return;
            if (name !== MOYAI && !name.includes("moyai") && !name.includes("moai")) return;
            if (settings.store.ignoreBots && UserStore.getUser(userId)?.bot) return;
            if (settings.store.ignoreBlocked && RelationshipStore.isBlocked(messageAuthorId)) return;

            boom();
        },

        VOICE_CHANNEL_EFFECT_SEND({ emoji }: IVoiceChannelEffectSendEvent) {
            if (!emoji?.name) return;
            const name = emoji.name.toLowerCase();
            if (name !== MOYAI && !name.includes("moyai") && !name.includes("moai")) return;

            boom();
        }
    }
});

function countOccurrences(sourceString: string, subString: string) {
    let i = 0;
    let lastIdx = 0;
    while ((lastIdx = sourceString.indexOf(subString, lastIdx) + 1) !== 0)
        i++;

    return i;
}

function countMatches(sourceString: string, pattern: RegExp) {
    if (!pattern.global)
        throw new Error("pattern must be global");

    pattern.lastIndex = 0;
    let i = 0;
    while (pattern.test(sourceString))
        i++;
    pattern.lastIndex = 0;

    return i;
}

function getMoyaiCount(message: string) {
    const count = countOccurrences(message, MOYAI)
        + countMatches(message, customMoyaiRe);

    return Math.min(count, 10);
}

function releaseAudio(audio: HTMLAudioElement) {
    activeAudio.delete(audio);
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
}

function boom() {
    if (activeAudio.size >= 4) return;
    if (!settings.store.triggerWhenUnfocused && !document.hasFocus()) return;
    const audioElement = document.createElement("audio");

    audioElement.src = settings.store.quality === "HD"
        ? MOYAI_URL_HD
        : MOYAI_URL;

    audioElement.volume = settings.store.volume;
    activeAudio.add(audioElement);
    audioElement.onended = audioElement.onerror = () => releaseAudio(audioElement);
    void audioElement.play().catch(() => releaseAudio(audioElement));
}
