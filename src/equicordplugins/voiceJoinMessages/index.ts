/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { humanFriendlyJoin } from "@utils/text";
import definePlugin, { OptionType } from "@utils/types";
import { Message, User } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, MessageActions, MessageStore, PermissionsBits, PermissionStore, RelationshipStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

const createBotMessage = findByCodeLazy('username:"Clyde"');
const USER_ID_REGEX = /^\d{17,20}$/;

let allowedFriendIds = new Set<string>();
let ignoredFriendIds = new Set<string>();

const settings = definePluginSettings({
    friendDirectMessages: {
        type: OptionType.BOOLEAN,
        description: "Receive notifications in your friends' DMs when they join a voice channel",
        default: true
    },
    friendDirectMessagesShowMembers: {
        type: OptionType.BOOLEAN,
        description: "Show a list of other members in the voice channel when receiving a DM notification of your friend joining a voice channel",
        default: true
    },
    friendDirectMessagesShowMemberCount: {
        type: OptionType.BOOLEAN,
        description: "Show the count of other members in the voice channel when receiving a DM notification of your friend joining a voice channel",
        default: false
    },
    friendDirectMessagesSelf: {
        type: OptionType.BOOLEAN,
        description: "Recieve notifications in your friends' DMs even if you are in the same voice channel as them",
        default: false
    },
    friendDirectMessagesSilent: {
        type: OptionType.BOOLEAN,
        description: "Join messages in your friends DMs will be silent",
        default: false
    },
    allowedFriends: {
        type: OptionType.STRING,
        description: "Comma or space separated list of friends' user IDs you want to receive join messages from",
        onChange: value => { allowedFriendIds = parseUserIdSet(value); },
        default: ""
    },
    ignoredFriends: {
        type: OptionType.STRING,
        description: "Comma or space separated list of friends' user IDs you do NOT want to receive join messages from",
        onChange: value => { ignoredFriendIds = parseUserIdSet(value); },
        default: ""
    },
    ignoreBlockedUsers: {
        type: OptionType.BOOLEAN,
        description: "Do not send messages about blocked users joining/leaving/moving voice channels",
        default: true
    },
});

interface VoiceState {
    guildId?: string;
    channelId?: string;
    oldChannelId?: string;
    user: User;
    userId: string;
}

function getMessageFlags() {
    let flags = 1 << 6;
    if (settings.store.friendDirectMessagesSilent) flags += 1 << 12;
    return flags;
}

function sendVoiceStatusMessage(channelId: string, content: string, userId: string): Message | null {
    if (!channelId) return null;
    const message: Message = createBotMessage({ channelId, content, embeds: [] });
    message.flags = getMessageFlags();
    message.author = UserStore.getUser(userId);
    // If we try to send a message into an unloaded channel, the client-sided messages get overwritten when the channel gets loaded
    // This might be messy but It Works:tm:
    const messagesLoaded: Promise<any> = MessageStore.hasPresent(channelId) ? new Promise<void>(r => r()) : MessageActions.fetchMessages({ channelId });
    messagesLoaded.then(() => {
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId,
            message,
            optimistic: true,
            sendMessageOptions: {},
            isPushNotification: false
        });
    });
    return message;
}

function parseUserIdSet(value: string): Set<string> {
    const ids = new Set<string>();

    for (const id of value.split(/[,\s]+/)) {
        if (USER_ID_REGEX.test(id)) ids.add(id);
    }

    return ids;
}

function isFriendAllowlisted(friendId: string) {
    if (!RelationshipStore.isFriend(friendId)) return false;
    if (ignoredFriendIds.has(friendId)) return false;
    return allowedFriendIds.size === 0 || allowedFriendIds.has(friendId);
}

export default definePlugin({
    name: "VoiceJoinMessages",
    description: "Receive client-side ephemeral messages when your friends join voice channels",
    tags: ["Servers", "Utility", "Voice"],
    authors: [Devs.Sqaaakoi, Devs.thororen],
    settings,
    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const clientUserId = UserStore.getCurrentUser()?.id;
            if (!clientUserId) return;

            for (const state of voiceStates) {
                const { userId, channelId, oldChannelId } = state;
                if (userId === clientUserId) continue;
                if (settings.store.ignoreBlockedUsers && RelationshipStore.isBlocked(userId)) continue;
                // Ignore events from same channel
                if (oldChannelId === channelId) continue;

                // Friend joined a voice channel
                if (settings.store.friendDirectMessages && (!oldChannelId && channelId) && isFriendAllowlisted(userId)) {
                    const channel = ChannelStore.getChannel(channelId);
                    if (!channel || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) continue;

                    const selfInChannel = SelectedChannelStore.getVoiceChannelId() === channelId;
                    let memberListContent = "";
                    if (settings.store.friendDirectMessagesShowMembers || settings.store.friendDirectMessagesShowMemberCount) {
                        const otherMemberMentions: string[] = [];
                        const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};

                        for (const key in voiceStates) {
                            const voiceState = voiceStates[key];
                            if (!voiceState?.userId || voiceState.userId === userId) continue;

                            const user = UserStore.getUser(voiceState.userId);
                            if (user) otherMemberMentions.push(`<@${user.id}>`);
                        }

                        const otherMembersCount = otherMemberMentions.length;
                        if (otherMembersCount <= 0) {
                            memberListContent += ", nobody else is in the voice channel";
                        } else if (settings.store.friendDirectMessagesShowMemberCount) {
                            memberListContent += ` with ${otherMembersCount} other member${otherMembersCount === 1 ? "" : "s"}`;
                        }
                        if (settings.store.friendDirectMessagesShowMembers && otherMembersCount > 0) {
                            memberListContent += settings.store.friendDirectMessagesShowMemberCount ? ", " : " with ";
                            memberListContent += humanFriendlyJoin(otherMemberMentions);
                        }
                    }
                    const dmChannelId = ChannelStore.getDMFromUserId(userId);
                    if (dmChannelId && (selfInChannel ? settings.store.friendDirectMessagesSelf : true)) sendVoiceStatusMessage(dmChannelId, `Joined voice channel <#${channelId}>${memberListContent}`, userId);
                }
            }
        },
    },

    start() {
        allowedFriendIds = parseUserIdSet(settings.store.allowedFriends);
        ignoredFriendIds = parseUserIdSet(settings.store.ignoredFriends);
    },

    stop() {
        allowedFriendIds = new Set();
        ignoredFriendIds = new Set();
    },
});
