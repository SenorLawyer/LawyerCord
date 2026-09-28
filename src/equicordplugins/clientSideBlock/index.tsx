/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { Devs, EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, GuildRoleStore, React, RelationshipStore } from "@webpack/common";

const ID_REGEX = /^\d{17,20}$/;

let userIdsToBlock = new Set<string>();
let guildBlacklistIds = new Set<string>();
let guildWhitelistIds = new Set<string>();
let idCachesInitialized = false;

function parseIdSet(value: string | undefined): Set<string> {
    const ids = new Set<string>();

    for (const rawId of (value ?? "").split(",")) {
        const id = rawId.trim();
        if (ID_REGEX.test(id)) ids.add(id);
    }

    return ids;
}

function validateIdList(value: string) {
    if (!value) return true;

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (!id) continue;
        if (!ID_REGEX.test(id)) return `${id} isn't a valid Discord id`;
    }

    return true;
}

function refreshIdCaches() {
    userIdsToBlock = parseIdSet(settings.store.usersToBlock);
    guildBlacklistIds = parseIdSet(settings.store.guildBlackList);
    guildWhitelistIds = parseIdSet(settings.store.guildWhiteList);
    idCachesInitialized = true;
}

function ensureIdCaches() {
    if (!idCachesInitialized) refreshIdCaches();
}

const settings = definePluginSettings({
    hideVc: {
        type: OptionType.BOOLEAN,
        description: "Hide voice channels containing blocked users.",
        default: false,
        restartNeeded: true
    },
    usersToBlock: {
        type: OptionType.STRING,
        description: "User IDs separated by commas.",
        onChange: refreshIdCaches,
        isValid: validateIdList,
        default: ""
    },
    hideBlockedUsers: {
        type: OptionType.BOOLEAN,
        description: "Should blocked users should also be hidden everywhere",
        default: true,
        restartNeeded: true
    },
    hideBlockedMessages: {
        type: OptionType.BOOLEAN,
        description: "Should messages from blocked users should be hidden fully (same as the old noblockedmessages plugin)",
        default: true,
        restartNeeded: true
    },
    hideEmptyRoles: {
        type: OptionType.BOOLEAN,
        description: "Should role headers be hidden if all of their members are blocked",
        restartNeeded: true,
        default: true
    },
    blockedReplyDisplay: {
        type: OptionType.SELECT,
        description: "What should display instead of the message when someone replies to someone you have hidden",
        restartNeeded: true,
        options: [
            { value: "displayText", label: "Display text saying a hidden message was replied to", default: true },
            { value: "hideReply", label: "Literally nothing" }
        ]
    },
    guildBlackList: {
        type: OptionType.STRING,
        description: "Guild ids to disable functionality in",
        onChange: refreshIdCaches,
        isValid: validateIdList,
        default: ""
    },
    guildWhiteList: {
        type: OptionType.STRING,
        description: "Guild ids to enable functionality in",
        onChange: refreshIdCaches,
        isValid: validateIdList,
        default: ""
    }
});

function isPluginDisabledForGuild(channelIdOrGuildId: string | undefined, isGuildId: boolean) {
    ensureIdCaches();

    const guildId = isGuildId
        ? channelIdOrGuildId
        : (channelIdOrGuildId ? ChannelStore.getChannel(channelIdOrGuildId)?.guild_id : undefined);
    if (!guildId) return false;

    if (guildBlacklistIds.has(guildId)) return true;
    if (guildWhitelistIds.size && !guildWhitelistIds.has(guildId)) return true;

    return false;
}

function shouldHideUser(userId: string, channelId?: string) {
    ensureIdCaches();

    if (!userId) return false;
    if (channelId && isPluginDisabledForGuild(channelId, false)) return false;
    if (RelationshipStore.isBlocked(userId) && settings.store.hideBlockedUsers) return true;
    return userIdsToBlock.has(userId);
}

interface MemberListProps {
    channel: { id: string; guild_id: string; };
    groups: { id: string; index?: number; count: number; }[];
    rows: ({ user?: { id: string; }; } | null | undefined)[];
}

function isRoleGroupHidden({ channel, groups, rows }: MemberListProps, section: number) {
    const group = groups[section];
    if (!group || group.index === undefined || group.count <= 0) return false;
    if (!GuildRoleStore.getRole(channel.guild_id, group.id)) return false;

    for (let index = group.index + 1; index <= group.index + group.count; index++) {
        const user = rows[index]?.user;
        if (!user || !shouldHideUser(user.id, channel.id)) return false;
    }
    return true;
}

function hiddenReplyComponent() {
    switch (settings.store.blockedReplyDisplay) {
        case "displayText":
            return <Paragraph style={{ marginTop: "0px", marginBottom: "0px" }}>
                <i>
                    ↓ Replying to blocked message
                </i>
            </Paragraph>;
        case "hideReply":
            return null;
    }
}

interface NowPlayingCard {
    party: {
        id: string;
        partiedMembers: { id: string; }[];
        guildContext?: { id: string; } | null;
    };
}

function filterActiveNowCards<T extends NowPlayingCard>(cards: T[]): T[] {
    const { hideVc } = settings.store;
    return cards.filter(({ party }) => {
        const channelId = party.id.startsWith("channel-") ? party.id.slice(8) : undefined;
        if (channelId && !hideVc) return true;
        if (isPluginDisabledForGuild(party.guildContext?.id, true)) return true;
        return !party.partiedMembers.some(member => shouldHideUser(member.id, channelId));
    });
}

export default definePlugin({
    name: "ClientSideBlock",
    description: "Allows you to locally hide almost all content from any user",
    tags: ["Utility"],
    searchTerms: ["blocked", "block", "hide", "hidden", "noblockedmessages"],
    authors: [Devs.Samwich, EquicordDevs.KamiRu],
    settings,
    start() {
        refreshIdCaches();
    },
    stop() {
        userIdsToBlock = new Set();
        guildBlacklistIds = new Set();
        guildWhitelistIds = new Set();
        idCachesInitialized = false;
    },
    filterActiveNowCards,
    shouldHideUser,
    shouldHideDm(channel: Channel) {
        const userId = channel.getRecipientId();
        return channel.isDM() && !channel.isSystemDM() && userId !== undefined && shouldHideUser(userId);
    },
    hiddenReplyComponent,
    isRoleGroupHidden,
    patches: [
        // message
        {
            find: ".NITRO_NOTIFICATION,[",
            replacement: {
                match: /\i\(\)\(\i\.type.{0,40}Message must not be a thread starter message/,
                replace: "if($self.shouldHideUser(arguments[0].message.author.id, arguments[0].message.channel_id)) return null;$&"
            }
        },
        // friends list (should work with all tabs)
        {
            find: "peopleListItemRef.current.componentWillLeave",
            replacement: {
                match: /return \i===\i\.\i\.FRIEND_ANNIVERSARY/,
                replace: "if($self.shouldHideUser(this.props.user.id)) return null;$&"
            }
        },
        // member list
        {
            find: "this.updateMaxContentFeedRowSeen()",
            replacement: [
                {
                    match: /BOOST_GEM_ICON.{0,10}\);/,
                    replace: "$&if($self.shouldHideUser(arguments[0].user.id,arguments[0].channel.id)) return null;"
                },
                // stop the role header from displaying if all users with that role are hidden (wip sorta)
                {
                    match: /renderSection=(\i)=>\{/,
                    replace: "$&if($self.isRoleGroupHidden(this.props,$1.section)) return null;",
                    predicate: () => settings.store.hideEmptyRoles
                },
            ]
        },
        // "1 blocked message"
        {
            find: "#{intl::BLOCKED_MESSAGE_COUNT}}",
            replacement: {
                match: /1:\i\.content.length;/,
                replace: "$&return null;"
            },
            predicate: () => settings.store.hideBlockedMessages
        },
        // replies
        {
            find: ".GUILD_APPLICATION_PREMIUM_SUBSCRIPTION||",
            replacement: [
                {
                    match: /(?=let \i,\{repliedAuthor:)/,
                    replace: "if(arguments[0]?.referencedMessage?.message && $self.shouldHideUser(arguments[0].referencedMessage.message.author.id, arguments[0].baseMessage.messageReference.channel_id)) { return $self.hiddenReplyComponent(); }"
                }
            ]
        },
        // dm list
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /return \i\.isMultiUserDM\(\)\?/,
                replace: "if($self.shouldHideDm(arguments[0].channel)) return null;$&"
            }
        },
        // thank nick (644298972420374528) for these patches :3

        // filter relationships
        {
            find: "getFriendIDs(){",
            replacement: {
                match: /\?\?\[\]\)\),\i\.friends/,
                replace: "$&.filter(id => !$self.shouldHideUser(id))"
            }
        },
        // active now list
        {
            find: "ACTIVE_NOW_COLUMN)",
            replacement: {
                match: /(\i)\.map(?=\(\i=>\{let\{party:\i\}=\i;return)/,
                replace: "$self.filterActiveNowCards($1).map"
            }
        },
        // mutual friends list in user profile
        {
            find: "}getMutualFriends(",
            replacement: {
                match: /(getMutualFriends\(\i\){)return (\i\.get\(\i\))/,
                replace: "$1if($2) return $2.filter(u => !$self.shouldHideUser(u.key))"
            }
        },
    ]
});
