/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, MessageActions, MessageStore, UserStore } from "@webpack/common";

const pendingChannels = new Set<string>();

const settings = definePluginSettings({
    timePeriod: {
        type: OptionType.NUMBER,
        description: "The duration of bursts (in seconds).",
        default: 3
    },
    shouldMergeWithAttachment: {
        type: OptionType.BOOLEAN,
        description: "Should the message be merged if the last message has an attachment?",
        default: false
    },
    useSpace: {
        type: OptionType.BOOLEAN,
        description: "Whether to add a space between messages when merging instead of new lines.",
        default: false
    }
});

export default definePlugin({
    name: "MessageBurst",
    performance: { impact: "low", description: "Checks the previous message when sending a new message." },
    description: "Merges messages sent within a time period with your previous sent message if no one else sends a message before you.",
    tags: ["Chat"],
    authors: [EquicordDevs.port22exposed],
    settings,
    async onBeforeMessageSend(channelId, message, options) {
        if (!message.content || options.messageReference || pendingChannels.has(channelId)) return;
        const lastMessage = MessageStore.getLastMessage(channelId);
        const channel = ChannelStore.getChannel(channelId);
        const currentUser = UserStore.getCurrentUser();
        if (!lastMessage || !channel || !currentUser || lastMessage.author.id !== currentUser.id) return;
        if (channel.isGroupDM() && channel.name === lastMessage.content) return;

        const { timePeriod, shouldMergeWithAttachment, useSpace } = settings.store;
        if (lastMessage.attachments.length && !shouldMergeWithAttachment) return;
        if (Date.now() - new Date(lastMessage.timestamp).getTime() > timePeriod * 1000) return;

        pendingChannels.add(channelId);
        try {
            await MessageActions.editMessage(channelId, lastMessage.id, {
                content: lastMessage.content + (useSpace ? " " : "\n") + message.content,
            });
            message.content = "";
        } finally {
            pendingChannels.delete(channelId);
        }
    },
});
