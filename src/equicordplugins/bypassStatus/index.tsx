/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { playAudio } from "@api/AudioPlayer";
import { type NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Notifications } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { getCurrentChannel } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { ChannelStore, Menu, MessageStore, NavigationRouter, PresenceStore, UserStore, WindowStore } from "@webpack/common";
import { JSX } from "react";

interface IMessageCreate {
    channelId: string;
    guildId?: string;
    message: Message;
}

const SILENT_PING_FLAG = 1 << 12;
const ID_REGEX = /^\d{17,20}$/;
const CHANNEL_MENTION_REGEX = /<#(\d{17,20})>/g;
const USER_MENTION_REGEX = /<@!?(\d{17,20})>/g;
const logger = new Logger("BypassStatus");

let bypassGuildIds = new Set<string>();
let bypassChannelIds = new Set<string>();
let bypassUserIds = new Set<string>();

function Icon(enabled?: boolean): JSX.Element {
    return <svg
        width="18"
        height="18"
    >
        <circle cx="9" cy="9" r="8" fill={!enabled ? "var(--status-danger)" : "currentColor"} />
        <circle cx="9" cy="9" r="3.75" fill={!enabled ? "white" : "black"} />
    </svg>;
}

function processIds(value: string): string {
    return [...parseIdSet(value)].join(", ");
}

function parseIdSet(value: string): Set<string> {
    const ids = new Set<string>();

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (ID_REGEX.test(id)) ids.add(id);
    }

    return ids;
}

function getBypassIds(name: "guild" | "user" | "channel"): Set<string> {
    switch (name) {
        case "guild":
            return bypassGuildIds;
        case "channel":
            return bypassChannelIds;
        case "user":
            return bypassUserIds;
    }
}

function setBypassIds(name: "guild" | "user" | "channel", ids: Set<string>) {
    switch (name) {
        case "guild":
            bypassGuildIds = ids;
            break;
        case "channel":
            bypassChannelIds = ids;
            break;
        case "user":
            bypassUserIds = ids;
            break;
    }
}

function refreshBypassIdCaches() {
    bypassGuildIds = parseIdSet(settings.store.guilds);
    bypassChannelIds = parseIdSet(settings.store.channels);
    bypassUserIds = parseIdSet(settings.store.users);
}

async function showNotification(message: Message, guildId: string | undefined): Promise<void> {
    try {
        const channel = ChannelStore.getChannel(message.channel_id);

        const content = message.content.replace(CHANNEL_MENTION_REGEX, (_, channelId: string) => {
            return `#${ChannelStore.getChannel(channelId)?.name ?? "unknown-channel"}`;
        }).replace(USER_MENTION_REGEX, (_, userId: string) => {
            const user = UserStore.getUser(userId) as any;
            return `@${user?.globalName ?? user?.username ?? "unknown-user"}`;
        });

        const author = UserStore.getUser(message.author.id) as any;
        const authorName = (message.author as any).globalName ?? author?.globalName ?? author?.username ?? message.author.username;

        await Notifications.showNotification({
            title: `${authorName} ${guildId ? `(#${channel?.name ?? "unknown-channel"}, ${ChannelStore.getChannel(channel?.parent_id)?.name ?? "unknown-category"})` : ""}`,
            body: content,
            icon: author?.getAvatarURL(undefined, undefined, false),
            onClick: function (): void {
                NavigationRouter.transitionTo(`/channels/${guildId ?? "@me"}/${message.channel_id}/${message.id}`);
            }
        });

        if (settings.store.notificationSound) {
            playAudio("message1");
        }
    } catch (error) {
        logger.error("Failed to notify user: ", error);
    }
}

function ContextCallback(name: "guild" | "user" | "channel"): NavContextMenuPatchCallback {
    return (children, props) => {
        const type = props[name];
        if (!type) return;
        const enabled = getBypassIds(name).has(type.id);
        if (name === "user" && type.id === UserStore.getCurrentUser()?.id) return;
        children.splice(-1, 0, (
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id={`status-${name}-bypass`}
                    label={`${enabled ? "Remove" : "Add"} Status Bypass`}
                    icon={() => Icon(enabled)}
                    action={() => {
                        const bypasses = new Set(getBypassIds(name));
                        if (enabled) bypasses.delete(type.id);
                        else bypasses.add(type.id);

                        setBypassIds(name, bypasses);
                        settings.store[`${name}s`] = [...bypasses].join(", ");
                    }}
                />
            </Menu.MenuGroup>
        ));
    };
}

const settings = definePluginSettings({
    guilds: {
        type: OptionType.STRING,
        description: "Guilds to let bypass (notified when pinged anywhere in guild)",
        default: "",
        placeholder: "Separate with commas",
        onChange: value => {
            settings.store.guilds = processIds(value);
            bypassGuildIds = parseIdSet(value);
        }
    },
    channels: {
        type: OptionType.STRING,
        description: "Channels to let bypass (notified when pinged in that channel)",
        default: "",
        placeholder: "Separate with commas",
        onChange: value => {
            settings.store.channels = processIds(value);
            bypassChannelIds = parseIdSet(value);
        }
    },
    users: {
        type: OptionType.STRING,
        description: "Users to let bypass (notified for all messages sent in DMs)",
        default: "",
        placeholder: "Separate with commas",
        onChange: value => {
            settings.store.users = processIds(value);
            bypassUserIds = parseIdSet(value);
        }
    },
    allowOutsideOfDms: {
        type: OptionType.BOOLEAN,
        description: "Allow selected users to bypass status outside of DMs too (acts like a channel/guild bypass, but it's for all messages sent by the selected users)"
    },
    notificationSound: {
        type: OptionType.BOOLEAN,
        description: "Whether the notification sound should be played",
        default: true,
    },
    respectSilentPings: {
        type: OptionType.BOOLEAN,
        description: "Respect silent pings (@silent / suppress notifications)",
        default: true
    },
    statusToUse: {
        type: OptionType.SELECT,
        description: "Status to use for whitelist",
        options: [
            {
                label: "Online",
                value: "online",
            },
            {
                label: "Idle",
                value: "idle",
            },
            {
                label: "Do Not Disturb",
                value: "dnd",
                default: true
            },
            {
                label: "Invisible",
                value: "invisible",
            }
        ]
    }
});

export default definePlugin({
    name: "BypassStatus",
    description: "Still get notifications from specific sources when in do not disturb mode. Right-click on users/channels/guilds to set them to bypass do not disturb mode.",
    tags: ["Activity", "Customisation", "Notifications", "Servers"],
    authors: [Devs.Inbestigator],
    dependencies: ["AudioPlayerAPI"],
    flux: {
        async MESSAGE_CREATE({ message, guildId, channelId }: IMessageCreate): Promise<void> {
            try {
                const currentUser = UserStore.getCurrentUser();
                if (!currentUser) return;

                const userStatus = await PresenceStore.getStatus(currentUser.id);
                const currentChannelId = getCurrentChannel()?.id ?? "0";
                if (message.state === "SENDING" || message.content === "" || message.author.id === currentUser.id || (channelId === currentChannelId && WindowStore.isFocused()) || userStatus !== settings.store.statusToUse) {
                    return;
                }
                if (settings.store.respectSilentPings && (message.flags & SILENT_PING_FLAG)) { return; }
                const mentioned = MessageStore.getMessage(channelId, message.id)?.mentioned;
                if (((guildId != null && bypassGuildIds.has(guildId)) || bypassChannelIds.has(channelId)) && mentioned) {
                    await showNotification(message, guildId);
                } else if (bypassUserIds.has(message.author.id)) {
                    if (ChannelStore.getChannel(channelId)?.isDM() || (mentioned && settings.store.allowOutsideOfDms === true)) {
                        await showNotification(message, guildId);
                    }
                }
            } catch (error) {
                logger.error("Failed to handle message: ", error);
            }
        }
    },
    start() {
        refreshBypassIdCaches();
    },
    stop() {
        bypassGuildIds = new Set();
        bypassChannelIds = new Set();
        bypassUserIds = new Set();
    },
    settings,
    contextMenus: {
        "guild-context": ContextCallback("guild"),
        "channel-context": ContextCallback("channel"),
        "user-context": ContextCallback("user"),
    }
});
