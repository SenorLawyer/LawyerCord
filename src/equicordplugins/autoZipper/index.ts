/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, DraftType, SelectedChannelStore, showToast, Toasts, UploadHandler } from "@webpack/common";
import { zipSync } from "fflate";

const logger = new Logger("AutoZipper");
const MAX_ZIP_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_FOLDER_FILE_COUNT = 500;

const settings = definePluginSettings({
    extensions: {
        type: OptionType.STRING,
        description: "Comma-separated list of file extensions to auto-zip (e.g., .psd,.blend,.exe,.dmg)",
        default: ".psd,.blend,.exe,.dmg,.app,.apk,.iso",
        onChange: () => {
            extensionsToZip.clear();
            parseExtensions();
        }
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

async function zipFile(file: File): Promise<File> {
    assertZipInputSize(file.name, file.size);

    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    const zipData = zipSync({
        [file.name]: data
    });

    const baseName = file.name.substring(0, file.name.lastIndexOf(".")) || file.name;
    return new File([zipData as BlobPart], `${baseName}.zip`, { type: "application/zip" });
}

async function zipFolder(folderName: string, fileEntries: Record<string, Uint8Array>): Promise<File> {
    const zipData = zipSync(fileEntries);
    return new File([zipData as BlobPart], `${folderName}.zip`, { type: "application/zip" });
}

async function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

async function readDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<Record<string, Uint8Array>> {
    const files: Record<string, Uint8Array> = {};
    let fileCount = 0;
    let totalBytes = 0;

    async function readEntries(dirEntry: FileSystemDirectoryEntry, path = ""): Promise<void> {
        const reader = dirEntry.createReader();

        for (;;) {
            const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
            if (!entries.length) return;

            for (const childEntry of entries) {
                const entryPath = path ? `${path}/${childEntry.name}` : childEntry.name;

                if (childEntry.isFile) {
                    const file = await readFileEntry(childEntry as FileSystemFileEntry);
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

async function processFiles(files: File[]): Promise<File[]> {
    const processedFiles: File[] = [];

    for (const file of files) {
        if (shouldZipFile(file)) {
            try {
                const zippedFile = await zipFile(file);
                processedFiles.push(zippedFile);
            } catch (error) {
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

function handleDrop(event: DragEvent) {
    if (!event.dataTransfer) return;

    const items = Array.from(event.dataTransfer.items);
    if (items.length === 0) return;

    const hasTargetedItem = items.some(item => {
        const entry = item.webkitGetAsEntry();
        if (entry?.isDirectory) return true;

        const file = item.kind === "file" ? item.getAsFile() : null;
        return file != null && shouldZipFile(file);
    });

    if (!hasTargetedItem) return;

    event.preventDefault();
    event.stopPropagation();

    const processPromises: Array<Promise<File | null>> = [];

    for (const item of items) {
        const entry = item.webkitGetAsEntry();

        if (entry?.isDirectory) {
            const folderPromise = readDirectoryEntry(entry as FileSystemDirectoryEntry)
                .then(fileEntries => zipFolder(entry.name, fileEntries))
                .catch(error => {
                    logger.error(`Failed to zip folder ${entry.name}:`, error);
                    notifyZipFailure(`Failed to zip folder ${entry.name}.`);
                    return null;
                });
            processPromises.push(folderPromise);
        } else if (entry?.isFile) {
            const file = item.getAsFile();
            if (file) {
                if (shouldZipFile(file)) {
                    processPromises.push(
                        zipFile(file).catch(error => {
                            logger.error(`Failed to zip file ${file.name}:`, error);
                            notifyZipFailure(`Failed to zip ${file.name}. Uploading the original file instead.`);
                            return file;
                        })
                    );
                } else {
                    processPromises.push(Promise.resolve(file));
                }
            }
        }
    }

    Promise.all(processPromises).then(processedFiles => {
        const validFiles = processedFiles.filter((file): file is File => file !== null);
        const channelId = SelectedChannelStore.getChannelId();
        const channel = ChannelStore.getChannel(channelId);
        if (channel && validFiles.length > 0) {
            setTimeout(() => UploadHandler.promptToUpload(validFiles, channel, DraftType.ChannelMessage), 10);
        }
    });
}

function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length === 0) return;

    const hasTargetedFile = files.some(shouldZipFile);
    if (!hasTargetedFile) return;

    event.preventDefault();
    event.stopPropagation();

    processFiles(files).then(processedFiles => {
        const channelId = SelectedChannelStore.getChannelId();
        const channel = ChannelStore.getChannel(channelId);
        if (channel && processedFiles.length > 0) {
            setTimeout(() => UploadHandler.promptToUpload(processedFiles, channel, DraftType.ChannelMessage), 10);
        }
    });
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
        document.removeEventListener("drop", handleDrop, true);
        document.removeEventListener("paste", handlePaste, true);
        interceptingEvents = false;
    }
});
