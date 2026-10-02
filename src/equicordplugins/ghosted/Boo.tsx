/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Channel } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { ChannelStore, MessageStore, UserStore, useStateFromStores } from "@webpack/common";

import { cl, settings } from ".";
import { IconGhost } from "./IconGhost";

export const GHOST_SETTINGS = ["showIndicator", "showDmIcons", "exemptedChannels", "ignoreGroupDms", "ignoreBots", "maxInactiveTimeMs", "clearedChannels"] satisfies (keyof typeof settings.store)[];

function getGhostOptions() {
    const values = settings.plain;
    return { values, userId: UserStore.getCurrentUser()?.id, exemptions: values.exemptedChannels.split(",").map(id => id.trim()), now: Date.now() };
}

function getGhostState(channel: Channel, { values, userId, exemptions, now }: ReturnType<typeof getGhostOptions>): "question" | "unanswered" | null {
    if (!userId) return null;
    const message = MessageStore.getLastMessage(channel.id);
    if (!message || message.author.id === userId) return null;

    const { ignoreGroupDms, ignoreBots, maxInactiveTimeMs, clearedChannels } = values;
    if (clearedChannels?.[channel.id] === message.id || ignoreGroupDms && channel.isGroupDM() || ignoreBots && message.author.bot) return null;
    if (exemptions.includes(channel.id)) return null;
    if (maxInactiveTimeMs > 0 && now - new Date(message.timestamp).getTime() > maxInactiveTimeMs) return null;

    return message.content.includes("?") ? "question" : "unanswered";
}

export function getGhostedChannels(): string[] {
    const options = getGhostOptions();
    if (!options.userId) return [];
    return ChannelStore.getSortedPrivateChannels().filter(channel => getGhostState(channel, options) !== null).map(channel => channel.id);
}

export function clearChannelFromGhost(channelId: string): void {
    const message = MessageStore.getLastMessage(channelId);
    if (message) settings.store.clearedChannels = { ...settings.store.clearedChannels, [channelId]: message.id };
}

const ChannelWrapperStyles = findCssClassesLazy("muted", "wrapper");

export function Boo({ channel }: { channel: Channel; }) {
    const values = settings.use(GHOST_SETTINGS);
    const state = useStateFromStores([MessageStore, UserStore], () => values.showDmIcons ? getGhostState(channel, getGhostOptions()) : null, [channel, ...GHOST_SETTINGS.map(key => values[key])]);
    if (!values.showDmIcons || state === null) return null;

    return (
        <div className={cl("icon", ChannelWrapperStyles.wrapper)}>
            <IconGhost fill={state === "question" ? "#ff8000" : "currentColor"} />
        </div>
    );
}
