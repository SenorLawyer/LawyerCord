/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

interface ChannelContextProps {
    channel?: Channel;
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: ChannelContextProps) => {
    if (!channel?.id) return;

    children.push(
        <Menu.MenuItem
            id="vc-copy-channel-mention"
            label="Copy Channel Mention"
            action={() => copyToClipboard(`<#${channel.id}>`)}
        />
    );
};

export default definePlugin({
    name: "CopyChannelMention",
    performance: { impact: "low", description: "Adds a copy action when channel menus open." },
    description: "Adds a context menu item to copy a channel or thread mention.",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.nobody],
    contextMenus: {
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch
    }
});
