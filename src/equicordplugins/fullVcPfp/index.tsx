/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import { getUserAvatarUrl } from "@utils/misc";
import definePlugin from "@utils/types";
import { ChannelRTCStore, ChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import style from "./style.css?managed";

export default definePlugin({
    name: "FullVCPFP",
    description: "Makes avatars take up the entire voice call tile.",
    tags: ["Appearance", "Voice"],
    authors: [EquicordDevs.mochienya],
    managedStyle: style,
    patches: [
        {
            find: "\"data-selenium-video-tile\":",
            replacement: {
                match: /(?<=style:)(?:\i|\{.{0,250}?\})(?=,ref:\i,"data-selenium-video-tile":)/,
                replace: "{...$&,...$self.getVoiceBackgroundStyles(arguments[0])}",
            }
        },
    ],

    getVoiceBackgroundStyles({ participantUserId }: { participantUserId?: string; }) {
        if (!participantUserId) return;

        const user = UserStore.getUser(participantUserId);
        if (!user) return;

        const channelId = VoiceStateStore.getVoiceStateForUser(participantUserId)?.channelId;
        if (!channelId) return;

        const guildId = ChannelStore.getChannel(channelId)?.guild_id;
        const isSpeaking = ChannelRTCStore.getSpeakingParticipants(channelId).some(p => p.user.id === participantUserId && p.speaking);
        const avatarUrl = getUserAvatarUrl(user, guildId, isSpeaking, 1024);

        return {
            "--full-res-avatar": `url(${avatarUrl})`
        };
    },
});
