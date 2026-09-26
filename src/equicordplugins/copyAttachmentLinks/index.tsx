/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { EquicordDevs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import definePlugin from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

interface MessageContextProps {
    message?: Message;
}

interface CopyableAttachment {
    filename?: string;
    url: string;
}

function getCopyableAttachments(message: Message): CopyableAttachment[] {
    const attachments: CopyableAttachment[] = [];

    for (const attachment of message.attachments ?? []) {
        if (typeof attachment.url === "string" && attachment.url.length > 0) {
            attachments.push({ filename: attachment.filename, url: attachment.url });
        }
    }

    return attachments;
}

function escapeMarkdownLabel(label: string) {
    return label
        .replace(/\\/g, "\\\\")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/[\r\n]+/g, " ")
        .trim() || "attachment";
}

function copyRawUrls(attachments: CopyableAttachment[]) {
    let urls = "";
    for (const attachment of attachments) {
        if (urls) urls += "\n";
        urls += attachment.url;
    }

    copyWithToast(
        urls,
        `Copied ${attachments.length === 1 ? "attachment URL" : `${attachments.length} attachment URLs`}.`
    );
}

function copyMarkdownLinks(attachments: CopyableAttachment[]) {
    let links = "";
    for (let index = 0; index < attachments.length; index++) {
        const attachment = attachments[index];
        if (links) links += "\n";
        links += `[${escapeMarkdownLabel(attachment.filename ?? `attachment-${index + 1}`)}](${attachment.url.replace(/[()]/g, "\\$&")})`;
    }

    copyWithToast(
        links,
        `Copied ${attachments.length === 1 ? "attachment Markdown link" : `${attachments.length} attachment Markdown links`}.`
    );
}

const messageContextPatch: NavContextMenuPatchCallback = (children, { message }: MessageContextProps) => {
    if (!message) return;

    const attachments = getCopyableAttachments(message);
    if (attachments.length === 0) return;

    children.push(
        <Menu.MenuItem
            id="vc-copy-attachment-links"
            label={attachments.length === 1 ? "Copy Attachment Link" : "Copy Attachment Links"}
        >
            <Menu.MenuItem
                id="vc-copy-attachment-links-markdown"
                label="Markdown"
                action={() => copyMarkdownLinks(attachments)}
            />
            <Menu.MenuItem
                id="vc-copy-attachment-links-raw"
                label={attachments.length === 1 ? "Raw URL" : "Raw URLs"}
                action={() => copyRawUrls(attachments)}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "CopyAttachmentLinks",
    description: "Adds message context menu items to copy attachment URLs or Markdown links.",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.nobody],
    contextMenus: {
        "message": messageContextPatch
    }
});
