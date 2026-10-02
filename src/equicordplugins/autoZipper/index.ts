/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { Queue } from "@utils/Queue";
import definePlugin, { OptionType } from "@utils/types";
import { createZipFile } from "@utils/zip";
import { ChannelStore, DraftType, SelectedChannelStore, showToast, Toasts, UploadHandler, UserStore } from "@webpack/common";

const logger = new Logger("AutoZipper");
const MAX_ZIP_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_FOLDER_FILE_COUNT = 500;

const settings = definePluginSettings({
    extensions: {
        type: OptionType.STRING,
        description: "Comma-separated list of file extensions to auto-zip (e.g., .psd,.blend,.exe,.dmg)",
        default: ".psd,.blend,.exe,.dmg,.app,.apk,.iso",
        onChange: () => parseExtensions()
    }
});

const extensionsToZip = new Set<string>();

function parseExtensions() {
    extensionsToZip.clear();
    for (const rawExt of settings.store.extensions.split(",")) {
        const ext = rawExt.trim().toLowerCase();
        if (ext && !ext.startsWith(".")) {
            extensionsToZip.add("." + ext);
        } else if (ext) {
            extensionsToZip.add(ext);
        }
    }
}

function shouldZipFile(file: File): boolean {
    const extensionIndex = file.name.lastIndexOf(".");
    if (extensionIndex <= 0) return false;

    return extensionsToZip.has(file.name.substring(extensionIndex).toLowerCase());
}

function assertZipInputSize(fileName: string, bytes: number) {
    if (bytes <= MAX_ZIP_INPUT_BYTES) return;

    throw new Error(`${fileName} is too large to zip safely (${Math.ceil(bytes / 1024 / 1024)} MB).`);
}

async function zipFile(file: File, signal: AbortSignal): Promise<File> {
    assertZipInputSize(file.name, file.size);

    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    const baseName = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
    return createZipFile(`${baseName}.zip`, { [file.name]: data }, signal);
}

async function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

async function readDirectoryEntry(entry: FileSystemDirectoryEntry, signal: AbortSignal): Promise<Record<string, Uint8Array>> {
    const files: Record<string, Uint8Array> = Object.create(null);
    let fileCount = 0;
    let totalBytes = 0;

    async function readEntries(dirEntry: FileSystemDirectoryEntry, path = ""): Promise<void> {
        const reader = dirEntry.createReader();

        for (;;) {
            if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
            const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
            if (!entries.length) return;

            for (const childEntry of entries) {
                if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
                const entryPath = path ? `${path}/${childEntry.name}` : childEntry.name;

                if (childEntry.isFile) {
                    const file = await readFileEntry(childEntry as FileSystemFileEntry);
                    if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
                    fileCount++;
                    if (fileCount > MAX_FOLDER_FILE_COUNT) {
                        throw new Error(`${entry.name} contains more than ${MAX_FOLDER_FILE_COUNT} files.`);
                    }

                    totalBytes += file.size;
                    assertZipInputSize(entry.name, totalBytes);

                    const arrayBuffer = await file.arrayBuffer();
                    files[entryPath] = new Uint8Array(arrayBuffer);
                } else if (childEntry.isDirectory) {
                    await readEntries(childEntry as FileSystemDirectoryEntry, entryPath);
                }
            }
        }
    }

    await readEntries(entry);
    return files;
}

function notifyZipFailure(message: string) {
    showToast(message, Toasts.Type.FAILURE);
}

async function processFiles(files: File[], signal: AbortSignal): Promise<File[]> {
    const processedFiles: File[] = [];

    for (const file of files) {
        if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
        if (shouldZipFile(file)) {
            try {
                const zippedFile = await zipFile(file, signal);
                processedFiles.push(zippedFile);
            } catch (error) {
                if (signal.aborted) throw error;
                logger.error(`Failed to zip file ${file.name}:`, error);
                notifyZipFailure(`Failed to zip ${file.name}. Uploading the original file instead.`);
                processedFiles.push(file);
            }
        } else {
            processedFiles.push(file);
        }
    }

    return processedFiles;
}

let interceptingEvents = false;
const pendingUploads = new Set<AbortController>();
const preparationQueue = new Queue();

function uploadProcessedFiles(process: (signal: AbortSignal) => Promise<File[]>) {
    const controller = new AbortController();
    const { signal } = controller;
    const channelId = SelectedChannelStore.getChannelId();
    const userId = UserStore.getCurrentUser()?.id;
    pendingUploads.add(controller);
    preparationQueue.push(async () => {
        try {
            if (signal.aborted || userId !== UserStore.getCurrentUser()?.id) return;
            const files = await process(signal);
            await sleep(10);
            if (signal.aborted || userId !== UserStore.getCurrentUser()?.id) return;
            const channel = ChannelStore.getChannel(channelId);
            if (channel && files.length) await UploadHandler.promptToUpload(files, channel, DraftType.ChannelMessage);
        } catch (error) {
            if (!signal.aborted) {
                logger.error("Failed to prepare upload", error);
                notifyZipFailure("Could not prepare files for upload.");
            }
        } finally {
            pendingUploads.delete(controller);
        }
    });
}

function handleDrop(event: DragEvent) {
    if (!event.dataTransfer) return;

    const items = Array.from(event.dataTransfer.items, item => ({
        entry: item.webkitGetAsEntry(),
        file: item.kind === "file" ? item.getAsFile() : null
    }));
    const hasTargetedItem = items.some(({ entry, file }) => entry?.isDirectory || file != null && shouldZipFile(file));

    if (!hasTargetedItem) return;

    event.preventDefault();
    event.stopPropagation();

    void uploadProcessedFiles(async signal => {
        const files: File[] = [];
        for (const { entry, file } of items) {
            if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
            if (entry?.isDirectory) {
                try {
                    const fileEntries = await readDirectoryEntry(entry as FileSystemDirectoryEntry, signal);
                    files.push(await createZipFile(`${entry.name}.zip`, fileEntries, signal));
                } catch (error) {
                    if (signal.aborted) throw error;
                    logger.error(`Failed to zip folder ${entry.name}:`, error);
                    notifyZipFailure(`Failed to zip folder ${entry.name}.`);
                }
            } else if (file) {
                files.push(...await processFiles([file], signal));
            }
        }
        return files;
    });
}

function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length === 0) return;

    const hasTargetedFile = files.some(shouldZipFile);
    if (!hasTargetedFile) return;

    event.preventDefault();
    event.stopPropagation();

    void uploadProcessedFiles(signal => processFiles(files, signal));
}

export default definePlugin({
    name: "AutoZipper",
    description: "Automatically zips specified file types and folders before uploading to Discord",
    tags: ["Chat", "Organisation"],
    authors: [EquicordDevs.SSnowly],
    settings,

    start() {
        if (interceptingEvents) return;
        interceptingEvents = true;

        parseExtensions();

        document.addEventListener("drop", handleDrop, true);
        document.addEventListener("paste", handlePaste, true);
    },

    stop() {
        for (const controller of pendingUploads) controller.abort();
        pendingUploads.clear();
        document.removeEventListener("drop", handleDrop, true);
        document.removeEventListener("paste", handlePaste, true);
        interceptingEvents = false;
    }
});
