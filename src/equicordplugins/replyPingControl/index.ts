/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, MrDiamond, ant0n, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MessageJSON } from "@vencord/discord-types";
import { MessageStore, UserStore } from "@webpack/common";

const USER_ID_REGEX = /^\d{17,20}$/;

let replyPingWhitelistIds = new Set<string>();
let replyPingBlacklistIds = new Set<string>();

function parseUserIdSet(value: string): Set<string> {
    const ids = new Set<string>();

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (USER_ID_REGEX.test(id)) ids.add(id);
    }

    return ids;
}

function validateUserIdList(value: string) {
    if (!value) return true;

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (!id) continue;
        if (!USER_ID_REGEX.test(id)) return `${id} isn't a valid user id`;
    }

    return true;
}

export const settings = definePluginSettings({
    alwaysPingOnReply: {
        type: OptionType.BOOLEAN,
        description: "Always get pinged when someone replies to your messages",
        default: false,
    },
    replyPingWhitelist: {
        type: OptionType.STRING,
        description: "Comma-separated list of User IDs to always receive reply pings from",
        default: "",
        onChange: value => { replyPingWhitelistIds = parseUserIdSet(value); },
        isValid: validateUserIdList,
        disabled: () => settings.store.alwaysPingOnReply,
    },
    replyPingBlacklist: {
        type: OptionType.STRING,
        description: "Comma-separated list of User IDs to never receive reply pings from",
        default: "",
        onChange: value => { replyPingBlacklistIds = parseUserIdSet(value); },
        isValid: validateUserIdList,
    }
});

export default definePlugin({
    name: "ReplyPingControl",
    performance: { impact: "low", description: "Checks reply authors and mention lists when messages arrive." },
    description: "Control whether to always or never get pinged on message replies, with whitelist and blacklist features",
    tags: ["Chat", "Notifications"],
    authors: [Devs.ant0n, EquicordDevs.MrDiamond, EquicordDevs.keircn],
    settings,

    patches: [{
        find: "_channelMessages",
        replacement: {
            match: /receiveMessage\((\i)\)\{/,
            replace: "$&$self.modifyMentions($1);"
        }
    }],

    modifyMentions(message: MessageJSON) {
        const user = UserStore.getCurrentUser();
        if (!user) return;
        if (message.author.id === user.id) return;

        const repliedMessage = this.getRepliedMessage(message);
        if (!repliedMessage || repliedMessage.author.id !== user.id) return;

        const authorId = message.author.id;
        const mentions = message.mentions ?? [];

        if (replyPingBlacklistIds.has(authorId)) {
            message.mentions = mentions.filter(mention => mention.id !== user.id);
            return;
        }

        if (replyPingWhitelistIds.has(authorId) || settings.store.alwaysPingOnReply) {
            if (!mentions.some(mention => mention.id === user.id)) message.mentions = [...mentions, user as any];
        } else {
            message.mentions = mentions.filter(mention => mention.id !== user.id);
        }
    },

    getRepliedMessage(message: MessageJSON) {
        const ref = message.message_reference;
        return ref && MessageStore.getMessage(ref.channel_id, ref.message_id);
    },

    start() {
        replyPingWhitelistIds = parseUserIdSet(settings.store.replyPingWhitelist);
        replyPingBlacklistIds = parseUserIdSet(settings.store.replyPingBlacklist);
    },

    stop() {
        replyPingWhitelistIds = new Set();
        replyPingBlacklistIds = new Set();
    },
});
