/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Menu } from "@webpack/common";

const EmojiUtils = findByPropsLazy("convertNameToSurrogate");

interface Emoji {
    type: string;
    id: string;
    name: string;
}

interface Target {
    dataset: Emoji;
    firstChild?: HTMLImageElement;
}

function isEmojiAnimated(src?: string): boolean {
    if (!src) return false;

    try {
        const url = new URL(src);
        return url.searchParams.get("animated") === "true" || url.pathname.endsWith(".gif");
    } catch {
        return src.includes(".gif");
    }
}

function getEmojiMarkdown(target: Target, copyUnicode: boolean): string {
    const { id: emojiId, name: emojiName } = target.dataset;

    if (!emojiId) {
        return copyUnicode
            ? EmojiUtils.convertNameToSurrogate(emojiName)
            : `:${emojiName}:`;
    }

    const animated = isEmojiAnimated(target.firstChild?.src);
    return `<${animated ? "a" : ""}:${emojiName.replace(/~\d+$/, "")}:${emojiId}>`;
}

const settings = definePluginSettings({
    copyUnicode: {
        type: OptionType.BOOLEAN,
        description: "Copy the raw unicode character instead of :name: for default emojis (👽)",
        default: true,
    },
});

export default definePlugin({
    name: "CopyEmojiMarkdown",
    description: "Allows you to copy emojis as formatted string (<:blobcatcozy:1026533070955872337>)",
    tags: ["Emotes", "Utility"],
    authors: [Devs.HappyEnderman, Devs.Vishnya],
    settings,

    contextMenus: {
        "expression-picker"(children, { target }: { target: Target; }) {
            if (target.dataset.type !== "emoji") return;

            const emojiImageUrl = target.firstChild?.src;

            children.push(
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="vc-copy-emoji-markdown"
                        label="Copy Emoji Markdown"
                        action={() => {
                            copyWithToast(
                                getEmojiMarkdown(target, settings.store.copyUnicode),
                                "Success! Copied emoji markdown."
                            );
                        }}
                    />
                    {emojiImageUrl && (
                        <Menu.MenuItem
                            id="vc-copy-emoji-url"
                            label="Copy Emoji URL"
                            action={() => copyWithToast(emojiImageUrl, "Success! Copied emoji URL.")}
                        />
                    )}
                </Menu.MenuGroup>
            );
        },
    },
});
