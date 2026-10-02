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

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Constants, FluxDispatcher, GuildStore, RelationshipStore, SnowflakeUtils, UserAffinitiesStore, UserStore } from "@webpack/common";

const settings = definePluginSettings(
    {
        sortByAffinity: {
            type: OptionType.BOOLEAN,
            default: true,
            description: "Whether to sort implicit relationships by their affinity to you.",
            restartNeeded: true
        },
    }
);

const logger = new Logger("ImplicitRelationships");
let fetchGeneration = 0;
let memberChunkCallback: ((event: { chunks?: Array<{ nonce?: string; }>; }) => void) | null = null;
let memberRequestTimeout: ReturnType<typeof setTimeout> | null = null;

function clearPendingMemberRequest() {
    if (memberChunkCallback) {
        FluxDispatcher.unsubscribe("GUILD_MEMBERS_CHUNK_BATCH", memberChunkCallback);
        memberChunkCallback = null;
    }

    if (memberRequestTimeout) {
        clearTimeout(memberRequestTimeout);
        memberRequestTimeout = null;
    }
}

export default definePlugin({
    name: "ImplicitRelationships",
    performance: {
        impact: "medium",
        description: "Sorts implicit relationships and requests member details when the frequent friends view is opened."
    },
    description: "Shows your implicit relationships in the Friends tab.",
    tags: ["Friends", "Servers"],
    authors: [Devs.Dolfies],
    settings,

    patches: [
        // Counts header
        {
            find: "#{intl::FRIENDS_ALL_HEADER}",
            replacement: {
                match: /(?<=toString\(\)\}\);)(?=case (\i\.\i)\.PENDING:)/,
                replace: 'case $1.IMPLICIT:return "Implicit — "+arguments[1];'
            },
        },
        // No friends page
        {
            find: "FriendsEmptyState: Invalid empty state",
            replacement: {
                match: /case (\i\.\i)\.ONLINE:(?=return (\i)\.SECTION_ONLINE)/,
                replace: "case $1.ONLINE:case $1.IMPLICIT:"
            },
        },
        // Sections header
        {
            find: "#{intl::FRIENDS_SECTION_ONLINE}),className:",
            replacement: {
                match: /,{id:(\i\.\i)\.PENDING,show:.{0,350}?className:(\i\.\i)(?=\},\{id:)/,
                replace: ',{id:$1.IMPLICIT,show:true,className:$2,content:"Implicit"}$&'
            }
        },
        // Sections content
        {
            find: '"FriendsStore"',
            replacement: {
                match: /(?<=case (\i\.\i)\.SUGGESTIONS:return \d+===(\i)\.type)/,
                replace: ";case $1.IMPLICIT:return $2.type===5"
            },
        },
        // Piggyback relationship fetch
        {
            find: '"FriendsStore',
            replacement: {
                match: /(\i\.\i)\.fetchRelationships\(\)/,
                // This relationship fetch is actually completely useless, but whatevs
                replace: "$1.fetchRelationships(),$self.fetchImplicitRelationships()"
            },
        },
        // Modify sort -- thanks megu for the patch (from sortFriends)
        {
            find: "getRelationshipCounts(){",
            replacement: {
                predicate: () => settings.store.sortByAffinity,
                match: /(?<=\}\)\.sortBy\()\i=>\i\.comparator(?=\)\.value\(\))/,
                replace: "row => $self.wrapSort(($&), row)"
            }
        },

        // Add support for the nonce parameter to Discord's shitcode
        {
            find: ".REQUEST_GUILD_MEMBERS,",
            replacement: {
                match: /\.REQUEST_GUILD_MEMBERS,{/,
                replace: "$&nonce:arguments[1]?.nonce,"
            }
        },
        {
            find: "GUILD_MEMBERS_REQUEST:",
            replacement: {
                match: /presences:!!(\i)\.presences/,
                replace: "$&,nonce:$1.nonce"
            },
        },
        {
            find: ".not_found",
            replacement: {
                match: /notFound:(\i)\.not_found/,
                replace: "$&,nonce:$1.nonce"
            },
        }
    ],

    wrapSort(comparator: Function, row: any) {
        return row.type === 5
            ? (UserAffinitiesStore.getUserAffinity(row.user.id)?.communicationRank ?? 0)
            : comparator(row);
    },

    async fetchImplicitRelationships() {
        clearPendingMemberRequest();
        const generation = ++fetchGeneration;

        // Implicit relationships are defined as users that you:
        // 1. Have an affinity for
        // 2. Do not have a relationship with
        const userAffinities: Record<string, any>[] = UserAffinitiesStore.getUserAffinities();
        const relationships = RelationshipStore.getMutableRelationships();
        const toRequest: string[] = [];
        let addedImplicitRelationships = false;

        for (const affinity of userAffinities) {
            const userId = affinity.otherUserId;
            if (!userId || RelationshipStore.getRelationshipType(userId)) continue;

            relationships.set(userId, 5);
            addedImplicitRelationships = true;

            if (!UserStore.getUser(userId)) toRequest.push(userId);
        }

        if (addedImplicitRelationships) RelationshipStore.emitChange();
        if (!toRequest.length) return;

        const allGuildIds = Object.keys(GuildStore.getGuilds());
        if (!allGuildIds.length) return;

        const sentNonce = SnowflakeUtils.fromTimestamp(Date.now());
        let count = allGuildIds.length * Math.ceil(toRequest.length / 100);

        // OP 8 Request Guild Members allows 100 user IDs at a time
        // Note: As we are using OP 8 here, implicit relationships who we do not share a guild
        // with will not be fetched; so, if they're not otherwise cached, they will not be shown
        // This should not be a big deal as these should be rare
        const callback = ({ chunks }: { chunks?: Array<{ nonce?: string; }>; }) => {
            if (generation !== fetchGeneration) return;
            if (!chunks?.length) return;

            try {
                let chunkCount = 0;
                for (const chunk of chunks) {
                    if (chunk.nonce === sentNonce) chunkCount++;
                }

                if (chunkCount === 0) return;

                count -= chunkCount;
                RelationshipStore.emitChange();
                if (count <= 0) {
                    clearPendingMemberRequest();
                }
            } catch (e) {
                logger.error("Error in GUILD_MEMBERS_CHUNK_BATCH handler", e);
            }
        };

        memberChunkCallback = callback;
        memberRequestTimeout = setTimeout(() => {
            if (generation === fetchGeneration) clearPendingMemberRequest();
        }, 30000);
        FluxDispatcher.subscribe("GUILD_MEMBERS_CHUNK_BATCH", callback);

        for (let i = 0; i < toRequest.length; i += 100) {
            FluxDispatcher.dispatch({
                type: "GUILD_MEMBERS_REQUEST",
                guildIds: allGuildIds,
                userIds: toRequest.slice(i, i + 100),
                presences: true,
                nonce: sentNonce,
            });
        }
    },

    start() {
        Constants.FriendsSections.IMPLICIT = "IMPLICIT";
    },

    stop() {
        fetchGeneration++;
        clearPendingMemberRequest();
    }
});
