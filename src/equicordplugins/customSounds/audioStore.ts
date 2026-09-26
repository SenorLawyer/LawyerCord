/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, update } from "@api/DataStore";

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

export async function saveAudio(file: File): Promise<string> {
    if (file.size > MAX_AUDIO_FILE_BYTES) {
        throw new Error(`Audio file is larger than ${MAX_AUDIO_FILE_MIB} MiB.`);
    }

    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();

    const dataUri = await generateDataURI(buffer, file.type, file.name);

    await update<Record<string, StoredAudioFile>>(STORAGE_KEY, files => ({
        ...files,
        [id]: { id, name: file.name, type: file.type, dataUri }
    }));
    return id;
}

export async function getAllAudio(): Promise<Record<string, StoredAudioFile>> {
    return await get<Record<string, StoredAudioFile>>(STORAGE_KEY) ?? {};
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

    if (!entry.buffer) return entry.dataUri;

    const bytes = new Uint8Array(entry.buffer);
    const dataUri = entry.dataUri || await generateDataURI(entry.buffer, entry.type, entry.name);
    let result: string | undefined;
    await update<Record<string, StoredAudioFile>>(STORAGE_KEY, files => {
        const current = files?.[id];
        if (current?.dataUri) {
            result = current.dataUri;
            delete current.buffer;
        } else if (current?.buffer && current.name === entry.name && current.type === entry.type
            && current.buffer.byteLength === bytes.byteLength
            && new Uint8Array(current.buffer).every((byte, index) => byte === bytes[index])) {
            current.dataUri = result = dataUri;
            delete current.buffer;
        }
        return files ?? {};
    });
    return result;
}

export async function deleteAudio(id: string): Promise<void> {
    await update<Record<string, StoredAudioFile>>(STORAGE_KEY, files => {
        if (files) delete files[id];
        return files ?? {};
    });
}
