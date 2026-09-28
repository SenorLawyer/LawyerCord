/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

interface MessageContextProps {
    message?: Message;
}

const timestampFormats = [
    ["Short Time", "t"],
    ["Long Time", "T"],
    ["Short Date", "d"],
    ["Long Date", "D"],
    ["Full Date", "F"],
    ["Relative Time", "R"],
] as const;

function getMessageUnixTimestamp(message: Message) {
    const timestamp = message.timestamp.getTime();
    if (!Number.isFinite(timestamp)) return null;

    return Math.floor(timestamp / 1000);
}

function copyTimestamp(unixTimestamp: number, format: string) {
    copyToClipboard(`<t:${unixTimestamp}:${format}>`);
}

const messageContextPatch: NavContextMenuPatchCallback = (children, { message }: MessageContextProps) => {
    if (!message) return;

    const unixTimestamp = getMessageUnixTimestamp(message);
    if (unixTimestamp == null) return;

    children.push(
        <Menu.MenuItem
            id="vc-copy-message-timestamp"
            label="Copy Timestamp"
        >
            {timestampFormats.map(([label, format]) => (
                <Menu.MenuItem
                    key={format}
                    id={`vc-copy-message-timestamp-${format}`}
                    label={label}
                    action={() => copyTimestamp(unixTimestamp, format)}
                />
            ))}
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-copy-message-timestamp-unix"
                label="Unix Timestamp"
                action={() => copyToClipboard(String(unixTimestamp))}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "CopyMessageTimestamp",
    description: "Adds message context menu items to copy Discord timestamp markdown.",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.nobody],
    contextMenus: {
        "message": messageContextPatch
    }
});
