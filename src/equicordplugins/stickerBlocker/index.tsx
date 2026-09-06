/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import { Button, Menu } from "@webpack/common";
import React, { ReactNode } from "react";

const CodeContainerClasses = findCssClassesLazy("markup", "codeContainer");
const MessageContentClasses = findCssClassesLazy("messageContent", "messageContentTrailingIcon");
let blockedStickerIds = new Set<string>();

const settings = definePluginSettings({
    showGif: {
        type: OptionType.BOOLEAN,
        description: "Whether to show a snazzy cat gif",
        default: true,
        restartNeeded: true
    },
    showMessage: {
        type: OptionType.BOOLEAN,
        description: "Whether to show a message detailing which id was blocked",
        default: false,
        restartNeeded: true
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Whether to show a button to unblock the gif",
        default: true,
        restartNeeded: true
    },
    blockedStickers: {
        type: OptionType.STRING,
        description: "The list of blocked sticker IDs (don't edit unless you know what you're doing)",
        onChange: value => { blockedStickerIds = parseStickerIds(value); },
        default: ""
    }
});

function parseStickerIds(value: string | null | undefined): Set<string> {
    if (!value) return new Set();

    const ids = new Set<string>();
    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (id) ids.add(id);
    }

    return ids;
}

function updateBlockedStickers(nextBlockedStickerIds: Set<string>) {
    blockedStickerIds = nextBlockedStickerIds;
    settings.store.blockedStickers = [...nextBlockedStickerIds].join(", ");
}

function blockedComponentRender(sticker) {
    const { showGif, showMessage, showButton } = settings.store;
    const elements = [] as ReactNode[];

    if (showGif) {
        elements.push(
            <img key="gif" src="https://equicord.org/assets/plugins/stickerBlocker/blocked.gif" style={{ width: "160px", borderRadius: "20px" }} />
        );
    }

    if (showMessage) {
        elements.push(
            <div key="message" id="vc-blocked-sticker" className={classes(CodeContainerClasses.markup, MessageContentClasses.messageContent)}><span>Blocked Sticker. ID: {sticker.id}, NAME: {sticker.name}</span></div>
        );
    }

    if (showButton) {
        elements.push(
            <Button key="button" onClick={() => toggleBlock(sticker.id)} color={Button.Colors.RED}>Unblock {(showMessage) ? "" : sticker.name}</Button>
        );
    }

    return <>{elements}</>;
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const { favoriteableId, favoriteableType } = props ?? {};

    if (!favoriteableId) return;

    const menuItem = (() => {
        switch (favoriteableType) {
            case "sticker":
                const sticker = props.message.stickerItems.find(s => s.id === favoriteableId);
                if (sticker?.format_type === 3 /* LOTTIE */) return;

                return buildMenuItem(favoriteableId);
        }
    })();

    if (menuItem)
        findGroupChildrenByChildId("copy-link", children)?.push(menuItem);
};

const expressionPickerPatch: NavContextMenuPatchCallback = (children, props: { target: HTMLElement; }) => {
    const { id, type } = props?.target?.dataset ?? {};
    if (!id) return;

    if (type === "sticker" && !props.target.className?.includes("lottieCanvas")) {
        children.push(buildMenuItem(id));
    }
};

function buildMenuItem(name) {
    return (
        <Menu.MenuItem
            id="add-sticker-block"
            key="add-sticker-block"
            label={(isStickerBlocked(name)) ? "Unblock Sticker" : "Block Sticker"}
            action={() => toggleBlock(name)}
        />
    );
}

function toggleBlock(name) {
    const nextBlockedStickerIds = new Set(blockedStickerIds);
    const excepted = nextBlockedStickerIds.has(name);

    if (excepted) {
        nextBlockedStickerIds.delete(name);
    } else {
        nextBlockedStickerIds.add(name);
    }

    updateBlockedStickers(nextBlockedStickerIds);
}

function isStickerBlocked(name) {
    return blockedStickerIds.has(name);
}

export default definePlugin({
    name: "StickerBlocker",
    description: "Allows you to block stickers from being displayed.",
    tags: ["Chat", "Emotes", "Utility"],
    authors: [Devs.Samwich],
    patches: [
        {
            find: ".STICKERS_CONSTANTS_STICKER_DIMENSION)",
            replacement: {
                match: /}\),\(\i\?\?(\i)\)\.name\]\}\);/,
                replace: "$& if($self.isBlocked($1.id)) return($self.blockedComponent($1));"
            }
        }
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "expression-picker": expressionPickerPatch,
    },
    start() {
        blockedStickerIds = parseStickerIds(settings.store.blockedStickers);
    },
    isBlocked(stickerId) {
        return blockedStickerIds.has(stickerId);
    },
    blockedComponent: ErrorBoundary.wrap(blockedComponentRender, { fallback: () => <p style={{ color: "red" }}>Failed to render :(</p> }),
    settings,
});
