/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { onChannelDelete, onGuildDelete, onRelationshipRemove, removeFriend, removeGroup, removeGuild } from "./functions";
import settings from "./settings";
import { syncAndRunChecks, syncFriends, syncGroups, syncGuilds } from "./utils";

let startupSyncTimeout: ReturnType<typeof setTimeout> | undefined;

function clearStartupSyncTimeout() {
    if (startupSyncTimeout === undefined) return;

    clearTimeout(startupSyncTimeout);
    startupSyncTimeout = undefined;
}

export default definePlugin({
    name: "RelationshipNotifier",
    description: "Notifies you when a friend, group chat, or server removes you.",
    tags: ["Friends", "Notifications"],
    authors: [Devs.nick],
    settings,

    patches: [
        {
            find: "removeRelationship:(",
            replacement: {
                match: /(removeRelationship:\((\i),\i,\i\)=>)/,
                replace: "$1($self.removeFriend($2),0)||"
            }
        },
        {
            find: "async leaveGuild(",
            replacement: {
                match: /(leaveGuild\((\i)\){)/,
                replace: "$1$self.removeGuild($2);"
            }
        },
        {
            find: "},closePrivateChannel(",
            replacement: {
                match: /(closePrivateChannel\((\i)\){)/,
                replace: "$1$self.removeGroup($2);"
            }
        }
    ],

    flux: {
        GUILD_CREATE: syncGuilds,
        GUILD_DELETE: onGuildDelete,
        CHANNEL_CREATE: syncGroups,
        CHANNEL_DELETE: onChannelDelete,
        RELATIONSHIP_ADD: syncFriends,
        RELATIONSHIP_UPDATE: syncFriends,
        async RELATIONSHIP_REMOVE(e) {
            await Promise.all([onRelationshipRemove(e), syncFriends()]);
        },
        CONNECTION_OPEN: syncAndRunChecks
    },

    start() {
        clearStartupSyncTimeout();
        startupSyncTimeout = setTimeout(() => {
            startupSyncTimeout = undefined;
            void syncAndRunChecks();
        }, 5000);
    },

    stop() {
        clearStartupSyncTimeout();
    },

    removeFriend,
    removeGroup,
    removeGuild
});
