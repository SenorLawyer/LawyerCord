/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";

import {
    extractZipArchiveEntry,
    type InspectedZipArchive,
    type InspectedZipEntry,
    inspectZipArchive,
    MAX_ZIP_BYTES
} from "./archive";

const Native = VencordNative?.pluginHelpers?.ZipPreview as PluginNative<typeof import("./native")> | undefined;

export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 2;
const MAX_CONCURRENT_ENTRY_LOADS = 2;
const MAX_QUEUED_ENTRY_LOADS = 4;
export { MAX_ZIP_ENTRIES as MAX_ENTRIES, MAX_ZIP_BYTES } from "./archive";

const CANCELLED_PREVIEW_MESSAGE = "ZIP preview was cancelled.";
const NATIVE_UNAVAILABLE_MESSAGE = "Native helper is unavailable.";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"]);
const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const TEXT_EXTENSIONS = new Set([
    "c",
    "cpp",
    "cs",
    "css",
    "csv",
    "go",
    "h",
    "html",
    "java",
    "js",
    "json",
    "jsx",
    "log",
    "lua",
    "md",
    "php",
    "py",
    "rs",
    "scss",
    "sh",
    "svg",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml"
]);

export type ZipPreviewKind = "image" | "text" | "unsupported";

export interface ZipEntry {
    path: string;
    name: string;
    size: number;
    kind: ZipPreviewKind;
    extension: string;
}

export interface LoadedZipEntry extends ZipEntry {
    data: Uint8Array;
}

export interface ZipPreviewResult {
    entries: ZipEntry[];
}

export type ZipPreviewCacheState =
    | { status: "pending"; promise: Promise<ZipPreviewResult>; }
    | { status: "resolved"; result: ZipPreviewResult; }
    | { status: "rejected"; message: string; };

interface NativeFetchResult {
    success: boolean;
    data?: ArrayBuffer;
    error?: string;
}

interface QueuedEntryLoad {
    operation: () => Promise<Uint8Array>;
    reject: (error: Error) => void;
    resolve: (data: Uint8Array) => void;
}

const zipCache = new Map<string, ZipPreviewCacheState>();
let entrySources = new WeakMap<ZipEntry, { archive: InspectedZipArchive; entry: InspectedZipEntry; }>();
let pendingEntryLoads = new WeakMap<ZipEntry, Promise<Uint8Array>>();
let activeEntryLoads = 0;
const entryLoadQueue: QueuedEntryLoad[] = [];

export function isZipFile(fileName?: string): boolean {
    return typeof fileName === "string" && /\.zip$/i.test(fileName);
}

export function getAttachmentFileName(props: ZipPreviewAttachmentProps): string | undefined {
    return props.fileName ?? props.item?.originalItem?.filename ?? props.item?.originalItem?.title;
}

export function getAttachmentUrl(props: ZipPreviewAttachmentProps): string | undefined {
    return props.url ?? props.item?.downloadUrl ?? props.item?.originalItem?.url ?? props.item?.originalItem?.proxy_url;
}

export function getCachedZip(url: string): ZipPreviewCacheState {
    const cached = zipCache.get(url);
    if (cached) {
        zipCache.delete(url);
        zipCache.set(url, cached);
        return cached;
    }

    const promise = loadZip(url)
        .then(result => {
            if (zipCache.get(url) !== pending) throw new Error(CANCELLED_PREVIEW_MESSAGE);
            zipCache.set(url, { status: "resolved", result });
            trimZipCache();
            return result;
        })
        .catch(error => {
            if (zipCache.get(url) !== pending) throw error;
            const message = error instanceof Error ? error.message : "Failed to preview ZIP.";
            if (message === CANCELLED_PREVIEW_MESSAGE || message === NATIVE_UNAVAILABLE_MESSAGE) zipCache.delete(url);
            else {
                zipCache.set(url, { status: "rejected", message });
                trimZipCache();
            }
            throw error;
        });

    const pending = { status: "pending" as const, promise };
    zipCache.set(url, pending);
    trimZipCache();
    return pending;
}

export function clearZipPreviewCache() {
    zipCache.clear();
    entrySources = new WeakMap();
    pendingEntryLoads = new WeakMap();
    for (const queued of entryLoadQueue.splice(0)) queued.reject(new Error("ZIP preview was closed."));
}

function trimZipCache() {
    if (zipCache.size <= MAX_CACHE_ENTRIES) return;

    for (const [key, state] of zipCache) {
        if (zipCache.size <= MAX_CACHE_ENTRIES) return;
        if (state.status === "pending") continue;
        zipCache.delete(key);
    }
}

export function makeDownload(entry: LoadedZipEntry) {
    const type = entry.kind === "image" ? getImageMimeType(entry.extension) : "text/plain;charset=utf-8";
    saveFile(new File([entry.data as BlobPart], entry.name, { type }));
}

export function createImageObjectUrl(entry: LoadedZipEntry): string {
    return URL.createObjectURL(new Blob([entry.data as BlobPart], { type: getImageMimeType(entry.extension) }));
}

export function readTextEntry(entry: LoadedZipEntry): string {
    return new TextDecoder("utf-8").decode(entry.data);
}

export function getCodeLanguage(entry: ZipEntry): string {
    const languageMap: Record<string, string> = {
        js: "javascript",
        jsx: "jsx",
        md: "markdown",
        py: "python",
        rs: "rust",
        sh: "bash",
        ts: "typescript",
        tsx: "tsx",
        yml: "yaml"
    };

    return languageMap[entry.extension] ?? entry.extension;
}

async function loadZip(url: string): Promise<ZipPreviewResult> {
    const attachmentPath = getDiscordAttachmentPath(url);

    if (attachmentPath) {
        const nativeResult = await fetchNativeDiscordAttachment(attachmentPath);
        if (nativeResult.success && nativeResult.data) {
            if (nativeResult.data.byteLength > MAX_ZIP_BYTES) throw new Error("ZIP is too large to preview.");
            return parseZipBuffer(nativeResult.data);
        }

        throw new Error(nativeResult.error || "Could not fetch ZIP through native Discord attachment fetch.");
    }

    const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
        void response.body?.cancel();
        throw new Error("Could not fetch ZIP.");
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_BYTES) {
        void response.body?.cancel();
        throw new Error("ZIP is too large to preview.");
    }

    const buffer = await readLimitedResponse(response);

    return parseZipBuffer(buffer);
}

async function readLimitedResponse(response: Response): Promise<ArrayBuffer> {
    if (!response.body) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_ZIP_BYTES) throw new Error("ZIP is too large to preview.");
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_ZIP_BYTES) throw new Error("ZIP is too large to preview.");
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => { });
        throw error;
    }

    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}

async function fetchNativeDiscordAttachment(attachmentPath: string): Promise<NativeFetchResult> {
    if (!Native) return { success: false, error: NATIVE_UNAVAILABLE_MESSAGE };
    if (typeof Native.fetchDiscordAttachment === "function") return Native.fetchDiscordAttachment(attachmentPath);
    return { success: false, error: "Native helper does not support attachment fetch." };
}

export function getDiscordAttachmentPath(url: string): string | null {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:") return null;
        if (!DISCORD_ATTACHMENT_HOSTS.has(parsedUrl.hostname)) return null;
        if (!parsedUrl.pathname.startsWith("/attachments/")) return null;

        const attachmentPath = parsedUrl.pathname.slice("/attachments/".length);
        if (!isValidDiscordAttachmentPath(attachmentPath)) return null;

        return `${attachmentPath}${parsedUrl.search}`;
    } catch {
        return null;
    }
}

function isValidDiscordAttachmentPath(path: string): boolean {
    if (path.includes("\\") || path.includes("..") || path.startsWith("/") || path.startsWith("//")) return false;

    const parts = path.split("/");
    return parts.length >= 3
        && /^\d+$/.test(parts[0])
        && /^\d+$/.test(parts[1])
        && parts.slice(2).every(part => part.length > 0);
}

export function parseZipBuffer(buffer: ArrayBuffer): ZipPreviewResult {
    const archive = inspectZipArchive(buffer);
    const entries = archive.entries
        .map(source => {
            const extension = getExtension(source.path);
            const entry: ZipEntry = {
                path: source.path,
                name: getFileName(source.path),
                size: source.uncompressedSize,
                extension,
                kind: getPreviewKind(extension, source.uncompressedSize)
            };
            entrySources.set(entry, { archive, entry: source });
            return entry;
        })
        .sort((left, right) => left.path.localeCompare(right.path));

    return { entries };
}

export async function loadZipEntry(entry: ZipEntry): Promise<LoadedZipEntry> {
    const source = entrySources.get(entry);
    if (!source) throw new Error("ZIP entry is no longer available.");
    if (entry.kind === "unsupported") throw new Error("ZIP entry cannot be previewed.");

    let pending = pendingEntryLoads.get(entry);
    if (!pending) {
        pending = runBoundedEntryLoad(() => extractZipArchiveEntry(source.archive, source.entry, MAX_PREVIEW_BYTES));
        pendingEntryLoads.set(entry, pending);
        void pending.then(
            () => pendingEntryLoads.delete(entry),
            () => pendingEntryLoads.delete(entry)
        );
    }

    const data = await pending;
    if (entrySources.get(entry) !== source) throw new Error("ZIP preview was closed.");
    return { ...entry, data };
}

function runBoundedEntryLoad(operation: () => Promise<Uint8Array>): Promise<Uint8Array> {
    if (activeEntryLoads < MAX_CONCURRENT_ENTRY_LOADS) return startEntryLoad(operation);
    if (entryLoadQueue.length >= MAX_QUEUED_ENTRY_LOADS) {
        return Promise.reject(new Error("Too many ZIP entries are being opened."));
    }

    return new Promise((resolve, reject) => entryLoadQueue.push({ operation, reject, resolve }));
}

async function startEntryLoad(operation: () => Promise<Uint8Array>): Promise<Uint8Array> {
    activeEntryLoads++;
    try {
        return await operation();
    } finally {
        activeEntryLoads--;
        const next = entryLoadQueue.shift();
        if (next) void startEntryLoad(next.operation).then(next.resolve, next.reject);
    }
}

function getPreviewKind(extension: string, size: number): ZipPreviewKind {
    if (size > MAX_PREVIEW_BYTES) return "unsupported";
    if (IMAGE_EXTENSIONS.has(extension)) return "image";
    if (TEXT_EXTENSIONS.has(extension)) return "text";
    return "unsupported";
}

function getImageMimeType(extension: string): string {
    if (extension === "jpg") return "image/jpeg";
    return `image/${extension}`;
}

function getFileName(path: string): string {
    return path.split("/").at(-1) || path;
}

function getExtension(path: string): string {
    const fileName = getFileName(path);
    const dotIndex = fileName.lastIndexOf(".");
    return dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
}

export interface ZipPreviewAttachmentProps {
    fileName?: string;
    fileSize?: number;
    url?: string;
    item?: {
        downloadUrl?: string;
        originalItem?: {
            filename?: string;
            proxy_url?: string;
            size?: number;
            title?: string;
            url?: string;
        };
    };
}
