/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Notifications } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { getCurrentChannel } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { MessageJSON } from "@vencord/discord-types";
import { MessageType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildStore, NavigationRouter, RelationshipStore } from "@webpack/common";

interface MessageCreatePayload {
    guildId?: string;
    channelId: string;
    message: MessageJSON;
}

const USER_ID_REGEX = /^\d{17,20}$/;
let notifyUserIds = new Set<string>();

const settings = definePluginSettings({
    users: {
        type: OptionType.STRING,
        description: "Comma separated list of user ids to get message toasts for",
        default: "",
        onChange: value => { notifyUserIds = parseUserIds(value); },
        isValid(value: string) {
            if (value === "") return true;

            for (const rawId of value.split(",")) {
                const id = rawId.trim();
                if (!id) continue;
                if (!USER_ID_REGEX.test(id)) return `${id} isn't a valid user id`;
            }

            return true;
        },
    },
});

function parseUserIds(value: string): Set<string> {
    const userIds = new Set<string>();

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (USER_ID_REGEX.test(id)) userIds.add(id);
    }

    return userIds;
}

export default definePlugin({
    authors: [EquicordDevs.cassie, EquicordDevs.mochienya],
    name: "MessageNotifier",
    performance: { impact: "low", description: "Checks configured author IDs on incoming messages." },
    description: "Get toasts for when chosen users send a message",
    tags: ["Chat", "Notifications"],
    settings,
    flux: {
        MESSAGE_CREATE({ message, channelId, guildId }: MessageCreatePayload) {
            if (message.type !== MessageType.DEFAULT || getCurrentChannel()?.id === channelId) return;
            if (!notifyUserIds.has(message.author.id)) return;

            const channel = ChannelStore.getChannel(channelId);
            if (!channel) return;

            const username = RelationshipStore.getNickname(message.author.id) ?? message.author.globalName ?? message.author.username;
            const guild = guildId ? GuildStore.getGuild(guildId) : null;
            const locationName = guild ? `${guild.name} #${channel.name}` : channel.name ?? "their DMs";

            Notifications.showNotification({
                title: `${username} sent a message`,
                body: `Click to jump to ${locationName}`,
                onClick() {
                    NavigationRouter.transitionTo(`/channels/${guild?.id ?? "@me"}/${channel.id}/${message.id}`);
                },
            });
        },
    },

    start() {
        notifyUserIds = parseUserIds(settings.store.users);
    },

    stop() {
        notifyUserIds = new Set();
    },
});
