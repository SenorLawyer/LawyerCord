/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import type { CloudUpload, RenderModalProps } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { CloudUploader, DraftType, FluxDispatcher, Humanize, Modal, UploadAttachmentStore, useEffect, UserStore, useState, useStateFromStores } from "@webpack/common";

import { compress } from "./compress";
import { CompressionItem, getLimits } from "./index";

interface CompressionModalProps extends RenderModalProps {
    channelId: string;
    items: CompressionItem[];
    controller: AbortController;
}

export function replaceFiles(channelId: string, items: CompressionItem[], results: File[], userId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (UserStore.getCurrentUser()?.id !== userId) throw new Error("The active account changed. Nothing was replaced.");
    const current = UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
    if (items.some(item => !current.includes(item.upload) || item.upload.item.file !== item.file || item.upload.status !== "NOT_STARTED"))
        throw new Error("The attachments changed while compressing. Nothing was replaced.");
    const limits = getLimits(channelId);
    if (results.some(file => file.size > limits.file)) throw new Error("The upload limit changed. Close this window and try sending again.");
    const files = new Map(items.map((item, i) => [item.upload, results[i]]));
    if (current.reduce((sum, upload) => sum + (files.get(upload) ?? upload.item.file).size, 0) > limits.total)
        throw new Error("The attachments no longer fit together. Remove an attachment and try again.");
    const replacements = new Map<CloudUpload, CloudUpload>();
    for (let i = 0; i < items.length; i++) {
        const { upload } = items[i];
        const file = results[i];
        const replacement = Object.assign(new CloudUploader({ file, platform: CloudUploadPlatform.WEB, origin: upload.origin }, channelId), {
            description: upload.description,
            spoiler: upload.spoiler,
            allowOptimization: false,
            filename: upload.filename.replace(/\.[^.]+$/, "") + file.name.slice(file.name.lastIndexOf("."))
        });
        replacements.set(upload, replacement);
    }
    const uploads = current.map(upload => replacements.get(upload) ?? upload);
    FluxDispatcher.dispatch({ type: "UPLOAD_ATTACHMENT_SET_UPLOADS", channelId, draftType: DraftType.ChannelMessage, uploads });
    for (const { upload } of items) upload.removeFromMsgDraft();
}

export function CompressionModal({ channelId, items, controller, ...props }: CompressionModalProps) {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [error, setError] = useState("");
    const [results, setResults] = useState<File[]>([]);
    const [userId] = useState(() => UserStore.getCurrentUser()?.id);
    const currentUserId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const done = results.length > 0;
    useEffect(() => () => controller.abort(), [controller]);
    useEffect(() => {
        if (currentUserId !== userId) { controller.abort(); props.onClose(); }
    }, [currentUserId, userId, controller]);

    async function run() {
        if (busy || done || !userId || controller.signal.aborted) return;
        setBusy(true);
        setError("");
        try {
            const files: File[] = [];
            for (const item of items) {
                files.push(await compress(item.file, item.limit, controller.signal, text => setStatus(`${files.length + 1} of ${items.length}: ${text}`)));
            }
            replaceFiles(channelId, items, files, userId, controller.signal);
            setResults(files);
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Compression failed. Your original files are still attached.");
        } finally {
            if (!controller.signal.aborted) setBusy(false);
        }
    }

    return <Modal
        {...props}
        title={done ? "Your attachments are ready" : busy ? "Compressing attachments" : "Compress attachments?"}
        notice={error ? { message: error, type: "critical" } : undefined}
        actions={done ? [{ text: "Back to message", variant: "primary", onClick: props.onClose }] : [
            { text: busy ? "Cancel compression" : "Keep originals", variant: "secondary", onClick: () => { controller.abort(); props.onClose(); } },
            { text: busy ? "Compressing" : "Compress", variant: "primary", disabled: busy, onClick: () => void run() }
        ]}
    >
        <Flex flexDirection="column" gap={12}>
            <Paragraph>{done ? "The compressed files have replaced the originals in your draft. Review them, then press Send when you are ready." : "These attachments exceed the available upload size. Compress them locally and keep your message as a draft?"}</Paragraph>
            {items.map((item, i) => <Paragraph key={item.upload.id}>
                {item.upload.filename}: {Humanize.filesize(item.file.size)}. {done ? `Compressed to ${Humanize.filesize(results[i].size)}.` : `Available: ${Humanize.filesize(item.limit)}.`}
            </Paragraph>)}
            {!done && <Paragraph>Images become WebP. Videos and GIFs become MP4. Compression may reduce quality or resolution. Animated formats that cannot be preserved will stay unchanged.</Paragraph>}
            {!done && <Paragraph>Files stay on your device during compression. This can take several minutes. Cancel at any time.</Paragraph>}
            {busy && <div role="status" aria-live="polite"><Paragraph>{status}</Paragraph></div>}
        </Flex>
    </Modal>;
}
