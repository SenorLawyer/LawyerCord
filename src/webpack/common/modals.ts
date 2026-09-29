/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useAwaiter } from "@utils/react";
import * as t from "@vencord/discord-types";
import { extractAndLoadChunksLazy, filters, findByCodeLazy, findExportedComponentLazy, mapMangledModuleLazy } from "@webpack";

import { React } from "./react";

const requireModals = extractAndLoadChunksLazy(['id:"remove-friend",', "ConfirmModal:"]);
const ModalComponent = findExportedComponentLazy<t.ModalProps>("Modal");
const ConfirmModalComponent = findExportedComponentLazy<t.ConfirmModalProps>("ConfirmModal");

export const Modal: t.Modal = props => {
    const [ready] = useAwaiter(requireModals);
    return ready ? React.createElement(ModalComponent, props) : null;
};

export const ConfirmModal: t.ConfirmModal = props => {
    const [ready] = useAwaiter(requireModals);
    return ready ? React.createElement(ConfirmModalComponent, props) : null;
};

// Modal key: "Media Viewer Modal"
export const openMediaModal: (props: t.MediaModalProps) => void = findByCodeLazy("hasMediaOptions", "shouldHideMediaOptions");

const ModalAPI: t.ModalAPI = mapMangledModuleLazy(".modalKey?", {
    openModalLazy: filters.byCode(".modalKey?"),
    openModal: filters.byCode(",instant:"),
    closeModal: filters.byCode(".onCloseCallback()"),
    closeAllModals: filters.byCode(".getState();for")
});

export const { openModalLazy, openModal, closeModal, closeAllModals } = ModalAPI;
