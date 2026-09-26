/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

let blockedWordPrefixes: string[] = [];

function parseBlockedWords(value: string): string[] {
    const words = new Set<string>();

    for (const rawWord of value.split(",")) {
        const word = rawWord.trim().toLowerCase();
        if (word) words.add(word);
    }

    return Array.from(words);
}

const settings = definePluginSettings(
    {
        blockedWords: {
            type: OptionType.STRING,
            description: "Strings not to capitalise, separated with commas.",
            onChange: value => { blockedWordPrefixes = parseBlockedWords(value); },
            default: "http, https, ok"
        }
    }
);

const presendObject: MessageSendListener = (_, msg) => {
    if (!msg.content) return;

    const sentences = msg.content.split(/(?<=[.!?]+['")\]]*)(\s+)/);
    let content = "";

    for (let i = 0; i < sentences.length; i++) {
        const element = sentences[i];
        if (i % 2 === 1) {
            content += element;
            continue;
        }

        const lowerElement = element.toLowerCase();
        if (!blockedWordPrefixes.some(word => lowerElement.startsWith(word))) {
            content += element.charAt(0).toUpperCase() + element.slice(1);
        } else {
            content += element;
        }
    }

    msg.content = content;
};

export default definePlugin({
    name: "WriteUpperCase",
    description: "Changes the first Letter of each Sentence in Message Inputs to Uppercase",
    tags: ["Appearance", "Customisation", "Chat"],
    authors: [Devs.Samwich, EquicordDevs.KrystalSkull],
    settings,
    onBeforeMessageSend: presendObject,

    start() {
        blockedWordPrefixes = parseBlockedWords(settings.store.blockedWords);
    }
});
