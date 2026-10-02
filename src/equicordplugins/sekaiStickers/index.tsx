/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { openModalLazy, UserStore } from "@webpack/common";

import { kanadeSvg } from "./kanade.svg";

const settings = definePluginSettings({
    AutoCloseModal: {
        type: OptionType.BOOLEAN,
        description: "Auto close modal when done",
        default: true
    }
});

let lifetime: object | undefined;

function openEditor() {
    const owner = lifetime;
    const userId = UserStore.getCurrentUser()?.id;
    if (!owner || !userId) return;
    return openModalLazy(async () => {
        if (owner !== lifetime || userId !== UserStore.getCurrentUser()?.id) return () => null;
        const { default: SekaiStickersModal } = await import("./Components/SekaiStickersModal");
        if (owner !== lifetime || userId !== UserStore.getCurrentUser()?.id) return () => null;
        return modalProps => <SekaiStickersModal modalProps={modalProps} settings={settings} />;
    });
}

const SekaiStickerChatButton = ErrorBoundary.wrap(() => (
    <ChatBarButton onClick={openEditor} tooltip="Sekai Stickers">
        {kanadeSvg()}
    </ChatBarButton>
), { noop: true });

export default definePlugin({
    name: "SekaiStickers",
    description: "Sekai Stickers built in discord originally from github.com/TheOriginalAyaka",
    dependencies: ["ChatInputButtonAPI"],
    tags: ["Chat", "Emotes"],
    authors: [Devs.MaiKokain],
    settings,
    chatBarButton: {
        icon: kanadeSvg,
        render: () => <SekaiStickerChatButton />
    },
    start() {
        lifetime = {};
    },
    stop() {
        lifetime = undefined;
    }
});
