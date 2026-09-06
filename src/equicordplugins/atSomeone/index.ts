/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, GuildMemberStore } from "@webpack/common";

export default definePlugin({
    name: "AtSomeone",
    authors: [Devs.Joona],
    description: "Mention someone randomly",
    tags: ["Chat", "Fun"],
    patches: [
        {
            find: ".LAUNCHABLE_APPLICATIONS;",
            replacement: [
                {
                    match: /&(\i)\(\)\((\i),\i\(\)\.test\)&&(\i)\.push\(\i\(\)\)/g,
                    replace: "$&,$1()($2,/someone/.test)&&$3.push({text:'@someone',description:'Mention someone randomly'})"
                },
            ],
        },
        {
            find: "inQuote:",
            replacement: {
                match: /\|here/,
                replace: "$&|someone"
            }
        }
    ],
    onBeforeMessageSend(channelId, msg) {
        if (!msg.content.includes("@someone")) return;
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return;
        const users = channel.guild_id
            ? GuildMemberStore.getMembers(channel.guild_id).map(member => member.userId)
            : channel.recipients;
        if (!users.length) return;
        msg.content = msg.content.replace(/@someone/g, () => `<@${users[Math.floor(users.length * Math.random())]}>`);
    }
});
