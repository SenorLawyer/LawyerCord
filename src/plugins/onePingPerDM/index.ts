/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MessageJSON } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, ReadStateStore, UserStore } from "@webpack/common";

const USER_ID_REGEX = /^\d{17,20}$/;
let ignoredUserIds = new Set<string>();

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

const settings = definePluginSettings({
    channelToAffect: {
        type: OptionType.SELECT,
        description: "Select the type of DM for the plugin to affect",
        options: [
            { label: "Both", value: "both_dms", default: true },
            { label: "User DMs", value: "user_dm" },
            { label: "Group DMs", value: "group_dm" },
        ]
    },
    allowMentions: {
        type: OptionType.BOOLEAN,
        description: "Receive audio pings for @mentions",
        default: false,
    },
    allowEveryone: {
        type: OptionType.BOOLEAN,
        description: "Receive audio pings for @everyone and @here in group DMs",
        default: false,
    },
    ignoreUsers: {
        type: OptionType.STRING,
        description: "User IDs (comma + space) whose pings should NEVER be throttled",
        onChange: value => { ignoredUserIds = parseUserIdSet(value); },
        isValid: validateUserIdList,
        default: ""
    },
    alwaysPlaySound: {
        type: OptionType.BOOLEAN,
        description: "Play the message notification sound even when its disabled",
        restartNeeded: true,
        default: false
    }
});

export default definePlugin({
    name: "OnePingPerDM",
    description: "If unread messages are sent by a user in DMs multiple times, you'll only receive one audio ping. Read the messages to reset the limit",
    tags: ["Notifications", "Customisation"],
    authors: [Devs.ProffDea],
    isModified: true,
    settings,
    patches: [
        {
            find: '"NotificationStore"',
            replacement: [
                {
                    match: /\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER\)(?=.*?(\i\.\i\.playNotificationSound\(.{0,5}\)))/,
                    replace: "$&if(!$self.isPrivateChannelRead(arguments[0]?.message))return;else if($self.playSound())return $1;else "
                },
                {
                    match: /sound:(\i\?(\i):void 0,volume:\i,onClick)/,
                    replace: "sound:!$self.isPrivateChannelRead(arguments[0]?.message)?undefined:$self.playSound()?$2:$1"
                }
            ]
        }
    ],
    playSound() {
        return settings.store.alwaysPlaySound;
    },
    isPrivateChannelRead(message?: MessageJSON) {
        if (!message?.author?.id) return true;
        if (ignoredUserIds.has(message.author.id)) return true;

        const currentUser = UserStore.getCurrentUser();
        const channelType = ChannelStore.getChannel(message.channel_id)?.type;
        if (
            (channelType !== ChannelType.DM && channelType !== ChannelType.GROUP_DM) ||
            (channelType === ChannelType.DM && settings.store.channelToAffect === "group_dm") ||
            (channelType === ChannelType.GROUP_DM && settings.store.channelToAffect === "user_dm") ||
            (settings.store.allowMentions && currentUser != null && message.mentions?.some(m => m.id === currentUser.id)) ||
            (settings.store.allowEveryone && message.mention_everyone)
        ) {
            return true;
        }
        return ReadStateStore.getOldestUnreadMessageId(message.channel_id) === message.id;
    },
    start() {
        ignoredUserIds = parseUserIdSet(settings.store.ignoreUsers);
    },
    stop() {
        ignoredUserIds = new Set();
    },
});
