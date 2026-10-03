/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { createRegexEvaluator } from "@utils/regex";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { RelationshipStore, SelectedChannelStore, UserStore } from "@webpack/common";

interface IMessageCreate {
    type: "MESSAGE_CREATE";
    optimistic: boolean;
    channelId: string;
    message: Message;
}

const logger = new Logger("HopOn");
const evaluator = createRegexEvaluator();
let lifetime = new AbortController();
let triggerRegex: string | null = null;

function cancelMatches() {
    evaluator.stopRegexWorker();
    lifetime.abort();
    lifetime = new AbortController();
}

async function matches(pattern: string, content: string, signal: AbortSignal) {
    try {
        return (await evaluator.evaluateRegex(pattern, [content], false, signal)).matches[0];
    } catch (error) {
        if (!signal.aborted) logger.warn("The trigger could not be checked. The URL was not opened.", error);
        return false;
    }
}

function compileTriggerRegex(value = settings.store.regex) {
    cancelMatches();
    try {
        if (value.trim()) new RegExp(value, "i");
        triggerRegex = value.trim() ? value : null;
    } catch (error) {
        triggerRegex = null;
        logger.error("Invalid trigger regex", error);
    }
}

const settings = definePluginSettings({
    regex: {
        type: OptionType.STRING,
        description: "Regex to trigger on. Matches that exceed one second or worker capacity do not open the URL.",
        onChange: compileTriggerRegex,
        isValid(value: string) {
            try {
                if (value.trim()) new RegExp(value, "i");
                return true;
            } catch (error) {
                return error instanceof Error ? error.message : "Invalid regex";
            }
        },
        default: "hop on (?:fortnite|fn)"
    },
    url: {
        type: OptionType.STRING,
        description: "URL to open.",
        onChange: cancelMatches,
        default: "com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true"
    }
});
export default definePlugin({
    name: "HopOn",
    performance: { impact: "medium", description: "Tests a configured regular expression on new messages in the current channel." },
    description: "Hop on! Opens a configurable URL when a message matches a custom regex in the current channel.",
    tags: ["Fun"],
    authors: [Devs.ImLvna],
    settings,
    start() {
        compileTriggerRegex();
    },
    stop() {
        cancelMatches();
        triggerRegex = null;
    },
    flux: {
        CHANNEL_SELECT: cancelMatches,
        CONNECTION_OPEN: cancelMatches,
        LOGOUT: cancelMatches,
        async MESSAGE_CREATE({ optimistic, type, message, channelId }: IMessageCreate) {
            if (optimistic || type !== "MESSAGE_CREATE") return;
            if (message.state === "SENDING") return;
            if (message.author?.id && RelationshipStore.isBlocked(message.author.id)) return;
            if (channelId !== SelectedChannelStore.getChannelId()) return;
            if (!triggerRegex) return;
            const { signal } = lifetime;
            const accountId = UserStore.getCurrentUser()?.id;
            if (!await matches(triggerRegex, message.content ?? "", signal)) return;
            if (signal.aborted || accountId !== UserStore.getCurrentUser()?.id || channelId !== SelectedChannelStore.getChannelId()) return;
            if (message.author?.id && RelationshipStore.isBlocked(message.author.id)) return;

            const url = settings.store.url.trim();
            if (url) VencordNative.native.openExternal(url);
        }
    }
});
