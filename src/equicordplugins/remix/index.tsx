/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { PaintbrushIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { extractAndLoadChunksLazy } from "@webpack";
import { ChannelStore, DraftType, FluxDispatcher, Menu, openModalLazy, PendingReplyStore, SelectedChannelStore, UploadHandler, UserStore } from "@webpack/common";

import css from "./styles.css?managed";

const requireCreateStickerModal = extractAndLoadChunksLazy([".CREATE_STICKER_MODAL,", "isDisplayingIndividualStickers"]);
const requireSettingsMenu = extractAndLoadChunksLazy(['type:"USER_SETTINGS_MODAL_OPEN"']);

const validMediaTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
let lifetime: object | undefined;

function openRemix(url?: string) {
    const owner = lifetime;
    const userId = UserStore.getCurrentUser()?.id;
    if (!owner || !userId) return;

    return openModalLazy(async () => {
        await requireCreateStickerModal();
        await requireSettingsMenu();
        if (owner !== lifetime || userId !== UserStore.getCurrentUser()?.id) return () => null;
        const { default: RemixModal } = await import("./RemixModal");
        if (owner !== lifetime || userId !== UserStore.getCurrentUser()?.id) return () => null;
        return modalProps => <RemixModal modalProps={modalProps} close={modalProps.onClose} url={url} />;
    });
}

const UploadContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (children.find(c => c?.props?.id === "vc-remix")) return;

    children.push(<Menu.MenuItem
        id="vc-remix"
        label="Remix"
        action={() => openRemix()}
    />);
};

const MessageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const url = props.itemHref ?? props.itemSrc;
    if (!url) return;
    if (props.attachment && !validMediaTypes.includes(props.attachment.content_type)) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;
    if (group.find(c => c?.props?.id === "vc-remix")) return;

    const index = group.findIndex(c => c?.props?.id === "copy-text");

    group.splice(index + 1, 0, <Menu.MenuItem
        id="vc-remix"
        label="Remix"
        icon={PaintbrushIcon}
        action={() => openRemix(url)}
    />);
};

export function sendRemix(blob: Blob) {
    const currentChannelId = SelectedChannelStore.getChannelId();
    const channel = ChannelStore.getChannel(currentChannelId);
    const reply = PendingReplyStore.getPendingReply(currentChannelId);
    if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", currentChannelId });

    const file = new File([blob], "remix.png", { type: "image/png" });
    UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
}

export default definePlugin({
    name: "RemixRevived",
    performance: { impact: "medium", description: "Uses image canvases and drawing tools while the remix editor is open." },
    description: "Revives Remix and breings it to Desktop",
    tags: ["Customisation", "Fun"],
    authors: [EquicordDevs.MrDiamond, EquicordDevs.meowabyte],
    contextMenus: {
        "channel-attach": UploadContextMenuPatch,
        "message": MessageContextMenuPatch,
    },
    managedStyle: css,
    start() {
        lifetime = {};
    },
    stop() {
        lifetime = undefined;
    },
});
