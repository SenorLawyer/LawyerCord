/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getCurrentChannel } from "@utils/discord";
import { isObjectEmpty } from "@utils/misc";
import { ChannelStore, GuildMemberCountStore, PermissionsBits, PermissionStore, SelectedChannelStore, Tooltip, useEffect, useStateFromStores, VoiceStateStore } from "@webpack/common";

import { ChannelMemberStore, cl, numberFormat, settings, ThreadMemberListStore } from ".";
import { CircleIcon } from "./CircleIcon";
import { OnlineMemberCountStore } from "./OnlineMemberCountStore";
import { VoiceIcon } from "./VoiceIcon";

const SETTINGS_KEYS: ["voiceActivity"] = ["voiceActivity"];

export function MemberCount({ isTooltip, tooltipGuildId }: { isTooltip?: true; tooltipGuildId?: string; }) {
    const { voiceActivity } = settings.use(SETTINGS_KEYS);
    const includeVoice = voiceActivity && !isTooltip;

    const currentChannel = useStateFromStores(
        [SelectedChannelStore, ChannelStore], () => isTooltip ? undefined : getCurrentChannel(),
        [isTooltip], (a, b) => a?.id === b?.id && a?.guild_id === b?.guild_id
    );

    const guildId = tooltipGuildId ?? currentChannel?.guild_id;

    const voiceActivityCount = useStateFromStores(
        [VoiceStateStore, ChannelStore, PermissionStore],
        () => {
            if (!includeVoice || !guildId) return 0;

            const voiceStates = VoiceStateStore.getVoiceStates(guildId);
            if (!voiceStates) return 0;

            let count = 0;
            for (const userId in voiceStates) {
                const { channelId } = voiceStates[userId];
                if (!channelId) continue;

                const channel = ChannelStore.getChannel(channelId);
                if (channel && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) count++;
            }

            return count;
        },
        [includeVoice, guildId]
    );

    const totalCount = useStateFromStores(
        [GuildMemberCountStore],
        () => guildId ? GuildMemberCountStore.getMemberCount(guildId) : null,
        [guildId]
    );

    let onlineCount = useStateFromStores(
        [OnlineMemberCountStore],
        () => guildId ? OnlineMemberCountStore.getCount(guildId) : null,
        [guildId]
    );

    const memberListOnlineCount = useStateFromStores(
        [ChannelMemberStore],
        () => {
            if (isTooltip || !guildId) return null;

            const { groups } = ChannelMemberStore.getProps(guildId, currentChannel?.id);

            if (groups.length < 1 || groups[0].id === "unknown") return null;

            let count = 0;
            for (const group of groups) {
                if (group.id !== "offline") count += group.count;
            }

            return count;
        },
        [isTooltip, guildId, currentChannel?.id]
    );

    const threadListOnlineCount = useStateFromStores(
        [ThreadMemberListStore],
        () => {
            if (isTooltip) return null;

            const threadGroups = ThreadMemberListStore.getMemberListSections(currentChannel?.id);

            if (threadGroups && !isObjectEmpty(threadGroups)) {
                let count = 0;
                for (const key in threadGroups) {
                    const group = threadGroups[key];
                    if (group.sectionId !== "offline") count += group.userIds.length;
                }
                return count;
            }

            return null;
        },
        [isTooltip, currentChannel?.id]
    );

    if (memberListOnlineCount != null) onlineCount = memberListOnlineCount;
    if (threadListOnlineCount != null) onlineCount = threadListOnlineCount;

    useEffect(() => {
        if (guildId) {
            OnlineMemberCountStore.ensureCount(guildId);
        }
    }, [guildId]);

    if (totalCount == null)
        return null;

    const formattedVoiceCount = numberFormat(voiceActivityCount ?? 0);
    const formattedOnlineCount = onlineCount != null ? numberFormat(onlineCount) : "?";
    const formattedTotalCount = numberFormat(totalCount);

    return (
        <div className={cl("widget", { tooltip: isTooltip, "member-list": !isTooltip })}>
            <Tooltip text={`${formattedOnlineCount} online members`} position="bottom">
                {props => (
                    <div {...props} className={cl("container")}>
                        <CircleIcon className={cl("online-count")} />
                        <span className={cl("online")}>{formattedOnlineCount}</span>
                    </div>
                )}
            </Tooltip>
            <Tooltip text={`${formattedTotalCount} total server members`} position="bottom">
                {props => (
                    <div {...props} className={cl("container")}>
                        <CircleIcon className={cl("total-count")} />
                        <span className={cl("total")}>{formattedTotalCount}</span>
                    </div>
                )}
            </Tooltip>

            {includeVoice && voiceActivityCount > 0 &&
                <Tooltip text={`${formattedVoiceCount} members in voice`} position="bottom">
                    {props => (
                        <div {...props} className={cl("container")}>
                            <VoiceIcon className={cl("voice-icon")} />
                            <span className={cl("voice")}>{formattedVoiceCount}</span>
                        </div>
                    )}
                </Tooltip>
            }
        </div>
    );
}
