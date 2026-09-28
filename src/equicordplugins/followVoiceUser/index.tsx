/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, User, VoiceState } from "@vencord/discord-types";
import { ChannelActions, Menu, React, RelationshipStore, UserStore, VoiceStateStore } from "@webpack/common";

type TFollowedUserInfo = {
    lastChannelId: string | null;
    userId: string;
} | null;

interface UserContextProps {
    channel: Channel;
    user: User;
    guildId?: string;
}

let followedUserInfo: TFollowedUserInfo = null;

const settings = definePluginSettings({
    onlyWhenInVoice: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Only follow the user when you are in a voice channel"
    },
    leaveWhenUserLeaves: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Leave the voice channel when the user leaves. (That can cause you to sometimes enter infinite leave/join loop)"
    }
});

const UserContextMenuPatch: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId || currentUserId === user.id || !RelationshipStore.isFriend(user.id)) return;

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuCheckboxItem
            id="fvu-follow-user"
            label="Follow User"
            checked={followedUserInfo?.userId === user.id}
            action={() => {
                if (followedUserInfo?.userId === user.id) {
                    followedUserInfo = null;
                    return;
                }

                const currentVoiceState = VoiceStateStore.getVoiceStateForUser(currentUserId);
                const targetChannelId = VoiceStateStore.getVoiceStateForUser(user.id)?.channelId ?? null;
                followedUserInfo = {
                    lastChannelId: targetChannelId,
                    userId: user.id
                };

                if (targetChannelId && (!settings.store.onlyWhenInVoice || currentVoiceState)) {
                    ChannelActions.selectVoiceChannel(targetChannelId);
                }
            }}
        />
    );
};

export default definePlugin({
    name: "FollowVoiceUser",
    description: "Follow a friend in voice chat.",
    tags: ["Voice"],
    authors: [EquicordDevs.TheArmagan],
    settings,
    flux: {
        LOGOUT() {
            followedUserInfo = null;
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            if (!followedUserInfo) return;
            if (!RelationshipStore.isFriend(followedUserInfo.userId)) {
                followedUserInfo = null;
                return;
            }

            const followedState = voiceStates.find(voiceState => voiceState.userId === followedUserInfo?.userId);
            if (!followedState) return;

            const currentUserId = UserStore.getCurrentUser()?.id;
            if (!currentUserId) return;

            if (
                settings.store.onlyWhenInVoice
                && !VoiceStateStore.getVoiceStateForUser(currentUserId)
            ) return;

            if (followedState.channelId && followedState.channelId !== followedUserInfo.lastChannelId) {
                followedUserInfo.lastChannelId = followedState.channelId;
                ChannelActions.selectVoiceChannel(followedState.channelId);
            } else if (!followedState.channelId) {
                followedUserInfo.lastChannelId = null;
                if (settings.store.leaveWhenUserLeaves) {
                    ChannelActions.selectVoiceChannel(null);
                }
            }
        }
    },
    contextMenus: {
        "user-context": UserContextMenuPatch
    },

    stop() {
        followedUserInfo = null;
    }
});
