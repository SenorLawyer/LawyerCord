/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import "./style.css";

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import TypingTweaksPlugin, { buildSeveralUsers } from "@plugins/typingTweaks";
import { Devs } from "@utils/constants";
import { getIntlMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { GuildMemberStore, RelationshipStore, SelectedChannelStore, Tooltip, TypingStore, UserGuildSettingsStore, UserStore, UserSummaryItem, useStateFromStores } from "@webpack/common";

const ThreeDots = findComponentByCodeLazy("Math.min(1,Math.max(", "dotRadius:");

const enum IndicatorMode {
    Dots = 1 << 0,
    Avatars = 1 << 1
}

function getDisplayName(guildId: string, userId: string) {
    const user = UserStore.getUser(userId);
    return GuildMemberStore.getNick(guildId, userId) ?? (user as any).globalName ?? user.username;
}

function areTypingUsersEqual(old: Record<string, number>, current: Record<string, number>) {
    let oldCount = 0;
    for (const key in old) oldCount++;

    let currentCount = 0;
    for (const key in current) {
        if (old[key] == null) return false;
        currentCount++;
    }

    return oldCount === currentCount;
}

function TypingIndicator({ channelId, guildId }: { channelId: string; guildId: string; }) {
    const typingUsers: Record<string, number> = useStateFromStores(
        [TypingStore],
        () => ({ ...TypingStore.getTypingUsers(channelId) }),
        null,
        areTypingUsersEqual
    );
    const currentChannelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());

    if (!settings.store.includeMutedChannels) {
        const isChannelMuted = UserGuildSettingsStore.isChannelMuted(guildId, channelId);
        if (isChannelMuted) return null;
    }

    if (!settings.store.includeCurrentChannel) {
        if (currentChannelId === channelId) return null;
    }

    const myId = UserStore.getCurrentUser()?.id;

    const typingUsersArray: string[] = [];
    for (const id in typingUsers) {
        if (id === myId) continue;
        if (RelationshipStore.isBlocked(id) && !settings.store.includeBlockedUsers) continue;
        if (RelationshipStore.isIgnored(id) && !settings.store.includeIgnoredUsers) continue;

        typingUsersArray.push(id);
    }

    const [a, b, c] = typingUsersArray;
    let tooltipText: string;

    switch (typingUsersArray.length) {
        case 0: break;
        case 1: {
            tooltipText = getIntlMessage("ONE_USER_TYPING", { a: getDisplayName(guildId, a) });
            break;
        }
        case 2: {
            tooltipText = getIntlMessage("TWO_USERS_TYPING", { a: getDisplayName(guildId, a), b: getDisplayName(guildId, b) });
            break;
        }
        case 3: {
            tooltipText = getIntlMessage("THREE_USERS_TYPING", { a: getDisplayName(guildId, a), b: getDisplayName(guildId, b), c: getDisplayName(guildId, c) });
            break;
        }
        default: {
            tooltipText = isPluginEnabled(TypingTweaksPlugin.name)
                ? buildSeveralUsers({ users: [a, b].map(UserStore.getUser), count: typingUsersArray.length - 2, guildId })
                : getIntlMessage("SEVERAL_USERS_TYPING");
            break;
        }
    }

    if (typingUsersArray.length > 0) {
        return (
            <Tooltip text={tooltipText!}>
                {props => (
                    <div className="vc-typing-indicator" {...props}>
                        {((settings.store.indicatorMode & IndicatorMode.Avatars) === IndicatorMode.Avatars) && (
                            <div
                                onClick={e => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                }}
                                onKeyPress={e => e.stopPropagation()}
                            >
                                <UserSummaryItem
                                    users={typingUsersArray.map(id => UserStore.getUser(id))}
                                    guildId={guildId}
                                    renderIcon={false}
                                    max={3}
                                    showDefaultAvatarsForNullUsers
                                    showUserPopout
                                    size={16}
                                    className="vc-typing-indicator-avatars"
                                />
                            </div>
                        )}
                        {((settings.store.indicatorMode & IndicatorMode.Dots) === IndicatorMode.Dots) && (
                            <div className="vc-typing-indicator-dots">
                                <ThreeDots dotRadius={3} themed={true} />
                            </div>
                        )}
                    </div>
                )}
            </Tooltip>
        );
    }

    return null;
}

const settings = definePluginSettings({
    includeCurrentChannel: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the typing indicator for the currently selected channel",
        default: true
    },
    includeMutedChannels: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the typing indicator for muted channels.",
        default: false
    },
    includeIgnoredUsers: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the typing indicator for ignored users.",
        default: false
    },
    includeBlockedUsers: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the typing indicator for blocked users.",
        default: false
    },
    indicatorMode: {
        type: OptionType.SELECT,
        description: "How should the indicator be displayed?",
        options: [
            { label: "Avatars and animated dots", value: IndicatorMode.Dots | IndicatorMode.Avatars, default: true },
            { label: "Animated dots", value: IndicatorMode.Dots },
            { label: "Avatars", value: IndicatorMode.Avatars },
        ],
    }
});

export default definePlugin({
    name: "TypingIndicator",
    description: "Adds an indicator if someone is typing on a channel.",
    tags: ["Notifications", "Appearance", "Servers"],
    authors: [Devs.Nuckyz, Devs.fawn, Devs.Sqaaakoi],
    isModified: true,
    settings,

    patches: [
        {
            // Normal channel.
            find: "UNREAD_IMPORTANT:",
            replacement: {
                match: /(?<=channel:(\i),name:[^{}]{0,100}\}\)\}\),\i)\.Children\.count\(\i\)>0\?\(0,\i\.jsx\)\("div",\{[^{}]{0,150}\}\):null/,
                replace: "$&,$self.TypingIndicator($1.id,$1.getGuildId())"
            }
        },
        {
            // Thread "spine" that shows in the left.
            find: "M0 15H2c0 1.6569",
            replacement: {
                match: /\(0,\i\.jsx\)\(\i,\{thread:(\i),countInVoice:\i,hasVideo:\i,mentionCount:\i,isMentionLowImportance:\i\}\)/,
                replace: "$&,$self.TypingIndicator($1.id,$1.getGuildId())"
            }
        }
    ],

    TypingIndicator: (channelId: string, guildId: string) => (
        <ErrorBoundary noop>
            <TypingIndicator channelId={channelId} guildId={guildId} />
        </ErrorBoundary>
    ),
});
