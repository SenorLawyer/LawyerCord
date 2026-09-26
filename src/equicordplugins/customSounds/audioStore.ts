/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";

const STORAGE_KEY = "ScattrdCustomSounds";
export const MAX_AUDIO_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_FILE_MIB = MAX_AUDIO_FILE_BYTES / 1024 / 1024;

export interface StoredAudioFile {
    id: string;
    name: string;
    buffer?: ArrayBuffer;
    type: string;
    dataUri?: string;
}

let cachedAudioFiles: Record<string, StoredAudioFile> | null = null;
let audioFilesLoadPromise: Promise<Record<string, StoredAudioFile>> | null = null;

async function loadAudioFiles(): Promise<Record<string, StoredAudioFile>> {
    if (cachedAudioFiles) return cachedAudioFiles;

    audioFilesLoadPromise ??= get<Record<string, StoredAudioFile>>(STORAGE_KEY)
        .then(files => {
            cachedAudioFiles = files ?? {};
            return cachedAudioFiles;
        })
        .finally(() => {
            audioFilesLoadPromise = null;
        });

    return audioFilesLoadPromise;
}

async function persistAudioFiles(files: Record<string, StoredAudioFile>) {
    cachedAudioFiles = files;
    await set(STORAGE_KEY, files);
}

export async function saveAudio(file: File): Promise<string> {
    if (file.size > MAX_AUDIO_FILE_BYTES) {
        throw new Error(`Audio file is larger than ${MAX_AUDIO_FILE_MIB} MiB.`);
    }

    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();

    const dataUri = await generateDataURI(buffer, file.type, file.name);

    const current = { ...await loadAudioFiles() };
    current[id] = {
        id,
        name: file.name,
        type: file.type,
        dataUri
    };
    await persistAudioFiles(current);
    return id;
}

export async function getAllAudio(): Promise<Record<string, StoredAudioFile>> {
    return { ...await loadAudioFiles() };
}

async function generateDataURI(buffer: ArrayBuffer, type: string, name: string): Promise<string> {
    let mimeType = type;
    if (!mimeType || mimeType === "application/octet-stream") {
        switch (name.split(".").pop()?.toLowerCase()) {
            case "ogg": mimeType = "audio/ogg"; break;
            case "wav": mimeType = "audio/wav"; break;
            case "m4a":
            case "mp4": mimeType = "audio/mp4"; break;
            case "flac": mimeType = "audio/flac"; break;
            case "aac": mimeType = "audio/aac"; break;
            case "webm": mimeType = "audio/webm"; break;
            case "wma": mimeType = "audio/x-ms-wma"; break;
            default: mimeType = "audio/mpeg";
        }
    }

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.onabort = () => reject(new Error("Audio file reading was cancelled."));
        reader.readAsDataURL(new Blob([buffer], { type: mimeType }));
    });
}

export async function getAudioDataURI(id: string): Promise<string | undefined> {
    const all = await getAllAudio();
    const entry = all[id];
    if (!entry) return undefined;

    if (entry.dataUri) {
        if (entry.buffer) {
            const current = { ...await loadAudioFiles() };
            if (current[id]?.buffer) {
                const { buffer: _, ...entryWithoutBuffer } = current[id];
                current[id] = entryWithoutBuffer;
                await persistAudioFiles(current);
            }
        }

        return entry.dataUri;
    }

    if (!entry.buffer) return undefined;

    const dataUri = await generateDataURI(entry.buffer, entry.type, entry.name);

    const current = { ...await loadAudioFiles() };
    if (current[id]) {
        const { buffer: _, ...entryWithoutBuffer } = current[id];
        current[id] = { ...entryWithoutBuffer, dataUri };
        await persistAudioFiles(current);
    }

    return dataUri;
}

export async function deleteAudio(id: string): Promise<void> {
    const all = { ...await loadAudioFiles() };
    delete all[id];
    await persistAudioFiles(all);
}
