/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { Logger } from "@utils/Logger";
import { randomUUID } from "crypto";
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { appendFile, mkdir, rm } from "fs/promises";
import { join } from "path";

import { CompressionMode } from "../policy";
import { getBinary } from "./binary";
import { compressFile } from "./encode";

interface Job {
    owner: WebFrameMain;
    sender: WebContents;
    directory: string;
    input: string;
    binary: string;
    name: string;
    type: string;
    size: number;
    limit: number;
    mode: CompressionMode;
    bytes: number;
    status: string;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
    navigate: (_event: unknown, url: string, sameDocument: boolean, mainFrame: boolean) => void;
    pending: Promise<unknown> | null;
    phase: "setup" | "input" | "encoding" | "done";
    data?: Uint8Array;
}

const jobs = new Map<string, Job>();
const logger = new Logger("MediaCompressor");
const error = "Compression failed. Your original file is still attached.";

function get(event: IpcMainInvokeEvent, id: unknown) {
    const job = typeof id === "string" ? jobs.get(id) : undefined;
    return job?.owner === event.senderFrame && !job.controller.signal.aborted ? job : undefined;
}

async function dispose(id: string, job: Job) {
    if (job.controller.signal.aborted) return;
    job.controller.abort();
    clearTimeout(job.timer);
    job.sender.removeListener("destroyed", job.cleanup);
    job.sender.removeListener("render-process-gone", job.cleanup);
    job.sender.removeListener("did-start-navigation", job.navigate);
    await job.pending;
    await rm(job.directory, { recursive: true, force: true }).catch(() => logger.warn("Could not remove temporary compression files."));
    jobs.delete(id);
}

export async function begin(event: IpcMainInvokeEvent, id: unknown, name: unknown, type: unknown, size: unknown, limit: unknown, mode: unknown): Promise<{ available: boolean; error?: string; }> {
    const owner = event.senderFrame;
    if (!owner || typeof id !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)
        || typeof name !== "string" || !name.length || name.length > 1024 || typeof type !== "string" || type.length > 128
        || !(type.startsWith("image/") || type.startsWith("video/") || /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi)$/i.test(name))
        || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3
        || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1024 || limit > 1024 ** 3 || typeof mode !== "string" || !["fast", "normal", "extreme"].includes(mode))
        return { available: false, error: "This attachment cannot be processed by the native encoder." };
    if (jobs.size > 0)
        return { available: false, error: "Another attachment is still being compressed." };
    const directory = join(DATA_DIR, "mediaCompressor", "jobs", randomUUID());
    const cleanup = () => dispose(id, job);
    const navigate = (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => { if (!sameDocument && mainFrame) return cleanup(); };
    const extension = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi)$/i.exec(name)?.[0] ?? ".bin";
    const job: Job = {
        owner, sender: event.sender, directory, input: join(directory, `input${extension.toLowerCase()}`),
        binary: "", name, type, size, limit, mode: mode as CompressionMode, bytes: 0, status: "Preparing the native encoder",
        controller: new AbortController(), timer: setTimeout(cleanup, 5 * 60_000), cleanup, navigate, pending: null, phase: "setup"
    };
    jobs.set(id, job);
    event.sender.once("destroyed", cleanup);
    event.sender.once("render-process-gone", cleanup);
    event.sender.on("did-start-navigation", navigate);
    const result = (async () => {
        try {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            job.binary = await getBinary(job.controller.signal, text => { job.status = text; }) ?? "";
            job.controller.signal.throwIfAborted();
            job.phase = "input";
            job.status = "Reading the attachment";
            return { available: !!job.binary };
        } catch { return { available: false }; }
    })();
    job.pending = result;
    return result;
}

export async function append(event: IpcMainInvokeEvent, id: unknown, data: unknown) {
    const job = get(event, id);
    if (!job || job.phase !== "input" || !(data instanceof Uint8Array) || !data.length || data.length > 4 * 1024 * 1024 || job.bytes + data.length > job.size) return false;
    job.phase = "setup";
    job.pending = appendFile(job.input, data, { mode: 0o600 }).then(() => { job.bytes += data.length; job.phase = "input"; return true; }, () => false);
    return job.pending;
}

export async function finish(event: IpcMainInvokeEvent, id: unknown): Promise<{ error?: string; size?: number; type?: string; extension?: string; }> {
    const job = get(event, id);
    if (!job || job.phase !== "input" || job.bytes !== job.size || !job.binary) return { error };
    job.phase = "encoding";
    clearTimeout(job.timer);
    job.timer = setTimeout(job.cleanup, 40 * 60_000);
    const result = (async () => {
        try {
            const result = await compressFile(job.binary, job.directory, job.input, job.name, job.type, job.limit, job.mode, job.controller.signal, text => { job.status = text; });
            job.controller.signal.throwIfAborted();
            job.data = result.data;
            job.phase = "done";
            job.status = "Reading the compressed attachment";
            clearTimeout(job.timer);
            job.timer = setTimeout(job.cleanup, 60_000);
            return { size: result.size, type: result.type, extension: result.extension };
        } catch { return { error }; }
    })();
    job.pending = result;
    return result;
}

export function status(event: IpcMainInvokeEvent, id: unknown) {
    return get(event, id)?.status ?? null;
}

export function read(event: IpcMainInvokeEvent, id: unknown, offset: unknown) {
    const job = get(event, id);
    if (!job?.data || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= job.data.length) return null;
    return job.data.slice(offset, offset + 4 * 1024 * 1024);
}

export async function release(event: IpcMainInvokeEvent, id: unknown) {
    const job = get(event, id);
    if (job && typeof id === "string") await dispose(id, job);
}
