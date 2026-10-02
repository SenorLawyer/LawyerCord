/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { Constants, Menu, NavigationRouter, RestAPI, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

const logger = new Logger("LastActive");
let generation = 0;
let started = false;

function invalidateRequests() {
    generation++;
}

async function jumpToLastActive(channel: Channel, targetUserId?: string) {
    const accountId = UserStore.getCurrentUser()?.id;
    if (!started || !channel || !accountId) return;
    const request = ++generation;
    const selectedChannel = SelectedChannelStore.getChannelId();
    const userId = targetUserId ?? accountId;
    const isCurrent = () => request === generation && UserStore.getCurrentUser()?.id === accountId && SelectedChannelStore.getChannelId() === selectedChannel;
    try {
        const response = await RestAPI.get({
            url: channel.guild_id ? Constants.Endpoints.SEARCH_GUILD(channel.guild_id) : Constants.Endpoints.SEARCH_CHANNEL(channel.id),
            query: { author_id: userId, ...(channel.guild_id ? { channel_id: channel.id } : {}), sort_by: "timestamp", sort_order: "desc", offset: 0 }
        });
        if (!isCurrent()) return;
        const messages: Array<Array<Message & { hit?: boolean; }>> = response.body.messages ?? [];
        const message = messages.flat().find(message => message.hit !== false && message.author.id === userId && message.channel_id === channel.id);
        if (message) {
            NavigationRouter.transitionTo(`/channels/${channel.guild_id ?? "@me"}/${channel.id}/${message.id}`);
        } else {
            Toasts.show({ type: Toasts.Type.FAILURE, message: response.status === 202 ? "Discord is indexing this search. Try again shortly." : "Couldn't find any recent messages from this user.", id: Toasts.genId() });
        }
    } catch {
        if (!isCurrent()) return;
        logger.error("Message search failed.");
        Toasts.show({ type: Toasts.Type.FAILURE, message: "Failed to find messages. Try again shortly.", id: Toasts.genId() });
    }
}

const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    children.push(
        <Menu.MenuItem
            id="LastActive"
            label={<span style={{ color: "#aa6746" }}>Your Last Message</span>}
            icon={LastActiveIcon}
            action={() => {
                jumpToLastActive(channel);
            }}
        />
    );
};
const UserContextMenuPatch: NavContextMenuPatchCallback = (children, { user, channel }) => {
    if (!channel || !user?.id) return;

    children.push(
        <Menu.MenuItem
            id="LastActive"
            label={<span style={{ color: "#aa6746" }}>User's Last Message</span>}
            icon={UserLastActiveIcon}
            action={() => {
                jumpToLastActive(channel, user.id);
            }}
        />
    );
};

export function UserLastActiveIcon() {
    return (
        <svg
            viewBox="0 0 52 52"
            width="20"
            height="20"
            fill="#aa6746"
        >
            <g>
                <path d="M11.4,21.6L24.9,7.9c0.6-0.6,1.6-0.6,2.2,0l13.5,13.7c0.6,0.6,0.6,1.6,0,2.2L38.4,26
                c-0.6,0.6-1.6,0.6-2.2,0l-9.1-9.4c-0.6-0.6-1.6-0.6-2.2,0l-9.1,9.3c-0.6,0.6-1.6,0.6-2.2,0l-2.2-2.2C10.9,23.1,10.9,22.2,11.4,21.6
                z"/>
                <path d="M11.4,39.7L24.9,26c0.6-0.6,1.6-0.6,2.2,0l13.5,13.7c0.6,0.6,0.6,1.6,0,2.2l-2.2,2.2
                c-0.6,0.6-1.6,0.6-2.2,0l-9.1-9.4c-0.6-0.6-1.6-0.6-2.2,0L15.8,44c-0.6,0.6-1.6,0.6-2.2,0l-2.2-2.2C10.9,41.2,10.9,40.2,11.4,39.7z
                "/>
            </g>
        </svg>
    );
}

export function LastActiveIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="#aa6746"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path fillRule="evenodd" d="M12,2 C17.5228475,2 22,6.4771525 22,12 C22,17.5228475 17.5228475,22 12,22 C6.4771525,22 2,17.5228475 2,12 C2,6.4771525 6.4771525,2 12,2 Z M12,4 C7.581722,4 4,7.581722 4,12 C4,16.418278 7.581722,20 12,20 C16.418278,20 20,16.418278 20,12 C20,7.581722 16.418278,4 12,4 Z M12,6 C12.5128358,6 12.9355072,6.38604019 12.9932723,6.88337887 L13,7 L13,11.5857864 L14.7071068,13.2928932 C15.0976311,13.6834175 15.0976311,14.3165825 14.7071068,14.7071068 C14.3466228,15.0675907 13.7793918,15.0953203 13.3871006,14.7902954 L13.2928932,14.7071068 L11.2928932,12.7071068 C11.1366129,12.5508265 11.0374017,12.3481451 11.0086724,12.131444 L11,12 L11,7 C11,6.44771525 11.4477153,6 12,6 Z" />
        </svg>
    );
}

export default definePlugin({
    name: "LastActive",
    performance: { impact: "low", description: "Searches for a recent message when its menu action is selected." },
    description: "A plugin to jump to last active message from yourself or another user in a channel/server.",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.Crxa],
    start() { started = true; },
    stop() {
        started = false;
        invalidateRequests();
    },
    flux: { LOGOUT: invalidateRequests, CONNECTION_OPEN: invalidateRequests, CHANNEL_SELECT: invalidateRequests },
    contextMenus: {
        "channel-context": ChannelContextMenuPatch,
        "user-context": UserContextMenuPatch,
        "thread-context": ChannelContextMenuPatch
    }
});
