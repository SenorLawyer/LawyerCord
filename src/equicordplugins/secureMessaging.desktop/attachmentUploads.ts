/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";

import {
    attachmentBundleRoot,
    type AttachmentMetadata,
    encodedImageDimensions,
    encryptAttachmentBytes,
    encryptedAttachmentFilename,
    generateAttachmentBundleMaterial,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_COUNT,
    MAX_TOTAL_ATTACHMENT_BYTES,
    type SecureStickerItem,
    serializeSecurePlaintext,
} from "./attachments";

interface MutableCloudUpload extends CloudUpload {
    allowOptimization: boolean;
    setFilename(value: string): void;
}

export interface PreparedEncryptedAttachments {
    apply(): void;
    files: Array<{ filename: string; size: number; }>;
    plaintext: string;
}

function assertUpload(upload: CloudUpload): asserts upload is MutableCloudUpload {
    if (!upload || upload.status !== "NOT_STARTED" || upload.isThumbnail || upload.uploadedFilename || upload.responseUrl ||
        upload.item?.platform !== CloudUploadPlatform.WEB || !(upload.item.file instanceof File) || upload.item.file.size < 1)
        throw new Error("Secure Messaging can only encrypt attachments before Discord starts uploading them");
    if (upload.item.file.size > MAX_ATTACHMENT_BYTES)
        throw new Error("Secure Messaging attachments exceed the 100 MiB per-file safety limit");
}

async function imageDimensions(file: File): Promise<{ height: number; width: number; } | null> {
    if (!file.type.startsWith("image/")) return null;
    const encoded = encodedImageDimensions(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()));
    if (encoded) return encoded;
    if (typeof createImageBitmap !== "function") return null;
    try {
        const bitmap = await createImageBitmap(file);
        try {
            if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 32_768 || bitmap.height > 32_768) return null;
            return { height: bitmap.height, width: bitmap.width };
        } finally {
            bitmap.close();
        }
    } catch {
        return null;
    }
}

async function metadataForUpload(upload: CloudUpload): Promise<AttachmentMetadata> {
    const { file } = upload.item;
    const dimensions = await imageDimensions(file);
    return {
        name: upload.filename || file.name,
        mimeType: file.type || upload.mimeType || "application/octet-stream",
        size: file.size,
        spoiler: upload.spoiler,
        description: upload.description,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        duration: upload.durationSecs ?? null,
    };
}

export async function prepareEncryptedAttachments(
    uploads: CloudUpload[],
    text: string,
    channelId: string,
    senderUserId: string,
    stickers: SecureStickerItem[] = [],
): Promise<PreparedEncryptedAttachments> {
    if (uploads.length < 1 || uploads.length > MAX_ATTACHMENT_COUNT)
        throw new Error(`Secure Messaging supports 1 to ${MAX_ATTACHMENT_COUNT} attachments per message`);
    for (const upload of uploads) assertUpload(upload);
    const totalSize = uploads.reduce((total, upload) => total + upload.item.file.size, 0);
    if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES)
        throw new Error("Secure Messaging attachments exceed the 200 MiB per-message safety limit");

    const { descriptor, keyBytes } = generateAttachmentBundleMaterial(uploads.length);
    const ciphertexts: Uint8Array[] = [];
    try {
        for (let index = 0; index < uploads.length; index++) {
            const upload = uploads[index];
            const plaintext = new Uint8Array(await upload.item.file.arrayBuffer());
            try {
                ciphertexts.push(await encryptAttachmentBytes({
                    bundleId: descriptor.id,
                    channelId,
                    count: uploads.length,
                    data: plaintext,
                    index,
                    masterKey: keyBytes,
                    metadata: await metadataForUpload(upload),
                    senderUserId,
                }));
            } finally {
                plaintext.fill(0);
            }
        }

        const root = await attachmentBundleRoot(descriptor.id, ciphertexts);
        const replacements = ciphertexts.map((ciphertext, index) => {
            const filename = encryptedAttachmentFilename(descriptor.id, index);
            const encryptedFile = new File([Uint8Array.from(ciphertext).buffer], filename, {
                type: "application/octet-stream",
                lastModified: Date.now(),
            });
            return { encryptedFile, filename, upload: uploads[index] as MutableCloudUpload };
        });
        return {
            apply() {
                for (const { encryptedFile, filename, upload } of replacements) {
                    upload.item.file = encryptedFile;
                    upload.setFilename(filename);
                    upload.mimeType = encryptedFile.type;
                    upload.classification = "unknown";
                    upload.isImage = false;
                    upload.isVideo = false;
                    upload.allowOptimization = false;
                    upload.currentSize = encryptedFile.size;
                    upload.preCompressionSize = encryptedFile.size;
                    upload.postCompressionSize = undefined;
                }
            },
            files: replacements.map(({ encryptedFile, filename }) => ({ filename, size: encryptedFile.size })),
            plaintext: serializeSecurePlaintext(text, { ...descriptor, root }, stickers),
        };
    } finally {
        keyBytes.fill(0);
        for (const ciphertext of ciphertexts) ciphertext.fill(0);
    }
}
