/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ensureSafePath } from "@main/ipcMain";
import { DATA_DIR } from "@main/utils/constants";
import { Logger } from "@utils/Logger";
import { randomUUID } from "crypto";
import { dialog, type IpcMainInvokeEvent } from "electron";
import { createReadStream } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { basename, extname, join, relative, resolve } from "path";
import { buffer } from "stream/consumers";

interface TempEntry {
    tmpDir: string;
    tmpPath: string;
}

interface RawClipAttachment {
    id?: string;
    applicationId?: string;
    applicationName?: string;
    users?: string[];
    version?: number;
}

const pendingTokens = new Map<string, string>();
const tempEntries = new Map<string, TempEntry>();
const CLIP_UPLOAD_DIR = join(DATA_DIR, "clipUpload");
const ALLOWED_EXTENSIONS = new Set([".mp4", ".m4v"]);
const MAX_CLIP_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_METADATA_SIZE = 1024 * 1024;
const logger = new Logger("ClipUpload");
const MIME_TYPES: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
};

const CLIP_FOOTER = Buffer.from([
    0x75, 0x75, 0x69, 0x64,
    0xA1, 0xC8, 0x52, 0x99, 0x33, 0x46, 0x4D, 0xB8, 0x88, 0xF0, 0x83, 0xF5, 0x7A, 0x75, 0xA5, 0xEF,
]);
const CLIP_FOOTER_SIZE = CLIP_FOOTER.length;

function getMimeType(filePath: string): string {
    return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function stripClipFooter(data: Buffer): Buffer {
    const idx = data.indexOf(CLIP_FOOTER);
    return idx === -1 ? data : data.subarray(0, idx);
}

async function readClipFile(filePath: string): Promise<Buffer> {
    const data = await buffer(createReadStream(filePath, { end: MAX_CLIP_SIZE }));
    if (data.length > MAX_CLIP_SIZE) throw new Error("Clip file is too large.");
    return data;
}

async function parseClipMetadata(filePath: string): Promise<RawClipAttachment[] | null> {
    try {
        const buf = await readClipFile(filePath);
        if (buf.length <= CLIP_FOOTER_SIZE) return null;

        const footerIdx = buf.indexOf(CLIP_FOOTER);
        if (footerIdx === -1) return null;

        const metadata = buf.subarray(footerIdx + CLIP_FOOTER_SIZE);
        if (metadata.length > MAX_METADATA_SIZE) return null;
        const parsed: unknown = JSON.parse(metadata.toString("utf-8"));
        const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        return entries.every(isClipAttachment) ? entries : null;
    } catch {
        return null;
    }
}

function isClipAttachment(value: unknown): value is RawClipAttachment {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return ["id", "applicationId", "applicationName"].every(key => record[key] === undefined || typeof record[key] === "string")
        && (record.version === undefined || typeof record.version === "number" && Number.isFinite(record.version))
        && (record.users === undefined || Array.isArray(record.users) && record.users.every((id: unknown) => typeof id === "string"));
}

export async function chooseVideoFile(_: IpcMainInvokeEvent): Promise<{ token: string; name: string; type: string; } | null> {
    try {
        const { filePaths, canceled } = await dialog.showOpenDialog({
            title: "Select clip file",
            filters: [{ name: "MP4 Video", extensions: ["mp4", "m4v"] }],
            properties: ["openFile"],
        });

        if (canceled || filePaths.length === 0) return null;

        const resolvedPath = resolve(filePaths[0]);
        if (!ALLOWED_EXTENSIONS.has(extname(resolvedPath).toLowerCase())) return null;

        const token = randomUUID();
        pendingTokens.set(token, resolvedPath);

        return { token, name: basename(resolvedPath), type: getMimeType(resolvedPath) };
    } catch {
        return null;
    }
}

export async function createTempVideoFile(_: IpcMainInvokeEvent, token: string): Promise<string | null> {
    const originalPath = pendingTokens.get(token);
    if (!originalPath) return null;
    pendingTokens.delete(token);

    try {
        return await createTempVideoFileFromBytes(_, basename(originalPath), stripClipFooter(await readClipFile(originalPath)));
    } catch {
        return null;
    }
}

export function releaseVideoFile(_: IpcMainInvokeEvent, token: unknown): void {
    if (typeof token === "string") pendingTokens.delete(token);
}

export async function createTempVideoFileFromBytes(_: IpcMainInvokeEvent, name: string, data: Uint8Array): Promise<string | null> {
    if (typeof name !== "string" || !(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > MAX_CLIP_SIZE) return null;

    const fileName = basename(name);
    if (fileName !== name || !ALLOWED_EXTENSIONS.has(extname(fileName).toLowerCase())) return null;

    const tmpDir = join(CLIP_UPLOAD_DIR, randomUUID());
    const tmpPath = ensureSafePath(tmpDir, fileName);
    if (!tmpPath) return null;

    try {
        await mkdir(tmpDir, { recursive: true });
        await writeFile(tmpPath, data);

        const tmpToken = randomUUID();
        tempEntries.set(tmpToken, { tmpDir, tmpPath });
        return tmpToken;
    } catch {
        await rm(tmpDir, { force: true, recursive: true }).catch(() => logger.warn("Could not remove temporary clip files."));
        return null;
    }
}

// Note: Exposing the absolute path to the renderer is unavoidable here.
// Discord's MediaEngineStore is a renderer-only module, and its
// updateClipMetadata method requires an absolute filesystem path.
export function getTempVideoFilePath(_: IpcMainInvokeEvent, token: string): string | null {
    return tempEntries.get(token)?.tmpPath ?? null;
}

export async function readVideoFile(_: IpcMainInvokeEvent, token: string): Promise<Uint8Array | null> {
    const entry = tempEntries.get(token);
    if (!entry) return null;

    try {
        const buf = await readClipFile(entry.tmpPath);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
        return null;
    }
}

export async function deleteTempVideoFile(_: IpcMainInvokeEvent, token: string): Promise<void> {
    const entry = tempEntries.get(token);
    if (!entry) return;

    const tmpDir = ensureSafePath(CLIP_UPLOAD_DIR, relative(CLIP_UPLOAD_DIR, entry.tmpDir));
    if (!tmpDir) return;

    try {
        await rm(tmpDir, { force: true, recursive: true });
        tempEntries.delete(token);
    } catch {
        logger.warn("Could not remove temporary clip files.");
    }
}

export async function parseClipFileMetadata(_: IpcMainInvokeEvent, token: string): Promise<RawClipAttachment[] | null> {
    const originalPath = pendingTokens.get(token);
    if (!originalPath) return null;

    return parseClipMetadata(originalPath);
}
