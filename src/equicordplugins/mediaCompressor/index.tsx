/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { CloudUpload } from "@vencord/discord-types";
import { filters, mapMangledModuleLazy } from "@webpack";
import { Alerts, closeModal, DraftType, openModal, UploadAttachmentStore } from "@webpack/common";

import { isMedia } from "./compress";
import { CompressionModal } from "./modal";

interface UploadLimits {
    getMaxFileSize(channelId: string): number;
    getMaxTotalAttachmentSize(): number;
}

const UploadTargets: { get: (target: number) => UploadLimits; } = mapMangledModuleLazy("MessageAttachmentUploadTarget", {
    get: filters.byCode("switch(", "default:return new")
});
let controller: AbortController | undefined;
let modalKey: string | undefined;

export interface CompressionItem {
    upload: CloudUpload;
    file: File;
    limit: number;
}

export function getLimits(channelId: string) {
    const target = UploadTargets.get(0);
    const file = target.getMaxFileSize(channelId);
    const total = target.getMaxTotalAttachmentSize();
    if (!Number.isFinite(file) || file <= 0 || !Number.isFinite(total) || total <= 0)
        throw new Error("Discord's upload limit could not be read. Try again after restarting Discord.");
    return { file, total };
}

export function planCompression(uploads: CloudUpload[], limits: { file: number; total: number; }): CompressionItem[] {
    const media = uploads.filter(upload => isMedia(upload.item.file));
    const mediaBytes = media.reduce((sum, upload) => sum + upload.item.file.size, 0);
    const otherBytes = uploads.reduce((sum, upload) => sum + (isMedia(upload.item.file) ? 0 : upload.item.file.size), 0);
    const available = Math.max(0, limits.total - otherBytes);
    return media.map(upload => ({
        upload,
        file: upload.item.file,
        limit: Math.min(limits.file, mediaBytes > available ? Math.floor(available * upload.item.file.size / mediaBytes) : limits.file)
    })).filter(item => item.file.size > item.limit);
}

function cancelCompression() {
    controller?.abort();
    controller = undefined;
    if (modalKey) closeModal(modalKey);
    modalKey = undefined;
}

const beforeSend: MessageSendListener = (channelId, _message, options) => {
    const uploads = options.uploads ?? UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
    if (!uploads.some(upload => isMedia(upload.item.file))) return;
    if (controller) return { cancel: true };
    try {
        const items = planCompression(uploads, getLimits(channelId));
        if (!items.length) return;
        if (items.some(item => item.limit < 1024)) {
            Alerts.show({ title: "Too many attachments", body: "Remove some attachments to leave room for the compressed media." });
            return { cancel: true };
        }
        const pending = new AbortController();
        controller = pending;
        modalKey = openModal(props => <SafeCompressionModal {...props} channelId={channelId} items={items} controller={pending} />, {
            onCloseCallback: () => {
                pending.abort();
                if (controller === pending) { controller = undefined; modalKey = undefined; }
            }
        });
    } catch {
        Alerts.show({ title: "Upload limit unavailable", body: "Discord's upload limit could not be read. Your message has not been sent. Restart Discord and try again." });
    }
    return { cancel: true };
};

const SafeCompressionModal = ErrorBoundary.wrap(CompressionModal, { noop: true });

export default definePlugin({
    name: "MediaCompressor",
    description: "Keep media in your draft and offer local compression when it exceeds Discord's upload limit.",
    authors: [EquicordDevs.SenorLawyer],
    tags: ["Media", "Utility"],
    dependencies: ["MessageEventsAPI"],
    performance: { impact: "low", description: "Compresses one file at a time in a single CPU worker when requested." },
    patches: [
        {
            find: "Unexpected mismatch between files and file metadata",
            group: true,
            replacement: [
                {
                    match: /files:(\i)(?=,guildId:\i\}\)\))/,
                    replace: "files:$1.filter(file=>$self.shouldCheckSize(file,arguments[2]))"
                },
                {
                    match: /(?<=,)(\i)(?=\)\i\.\i\.addFiles\()/,
                    replace: "($1||$self.shouldStage(arguments[0],arguments[2]))"
                }
            ]
        },
        {
            find: "UPLOAD_ATTACHMENT_SET_FILE:",
            group: true,
            replacement: [
                {
                    match: /UPLOAD_ATTACHMENT_(?:ADD_FILES|SET_FILE):function\((\i)\)\{/g,
                    replace: "$&const vcMediaDraft=$1.draftType;"
                },
                {
                    match: /(\i)\.upload\(\)/g,
                    replace: "$self.startDraftUpload($1,vcMediaDraft)"
                }
            ]
        }
    ],
    shouldCheckSize(file: File, draftType: number) {
        return draftType !== DraftType.ChannelMessage || !isMedia(file);
    },
    shouldStage(files: File[], draftType: number) {
        return draftType === DraftType.ChannelMessage && Array.from(files).some(isMedia);
    },
    startDraftUpload(upload: CloudUpload, draftType: number) {
        if (draftType !== DraftType.ChannelMessage || !isMedia(upload.item.file)) void upload.upload();
    },
    start() {
        addMessagePreSendListener(beforeSend, { priority: 2_000_000, cancelOnError: true });
    },
    stop() {
        cancelCompression();
        removeMessagePreSendListener(beforeSend);
    },
    flux: {
        LOGOUT: cancelCompression
    }
});
