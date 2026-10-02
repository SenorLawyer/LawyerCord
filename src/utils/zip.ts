/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { Queue } from "@utils/Queue";
import { AsyncZipDeflate, Zip, ZipDeflate } from "fflate";

const queue = new Queue();
const CHUNK_BYTES = 64 * 1024;

export function createZipFile(name: string, files: Record<string, Uint8Array>, signal: AbortSignal): Promise<File> {
    if (signal.aborted) return Promise.reject(new DOMException("Upload cancelled.", "AbortError"));
    if (queue.size >= 4) return Promise.reject(new Error("Too many ZIP uploads are waiting. Try again when one finishes."));
    return new Promise((resolve, reject) => {
        const task = () => compressFiles(name, files, signal).then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", cancel));
        const cancel = () => {
            if (!queue.remove(task)) return;
            signal.removeEventListener("abort", cancel);
            reject(new DOMException("Upload cancelled.", "AbortError"));
        };
        signal.addEventListener("abort", cancel, { once: true });
        queue.push(task);
    });
}

async function compressFiles(name: string, files: Record<string, Uint8Array>, signal: AbortSignal): Promise<File> {
    if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let yieldAt = performance.now() + 8;
    let rejectFile: (reason: unknown) => void = () => {};
    let archiveError: Error | undefined;
    const archive = new Zip((error, chunk) => {
        if (error) {
            archiveError = error;
            rejectFile(error);
        } else {
            chunks.push(chunk);
        }
    });
    const cancel = () => {
        archive.terminate();
        rejectFile(new DOMException("Upload cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });

    try {
        for (const [path, data] of Object.entries(files)) {
            if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
            const stream = data.length < CHUNK_BYTES ? new ZipDeflate(path) : new AsyncZipDeflate(path);
            archive.add(stream);
            if (archiveError) throw archiveError;
            const { ondata } = stream;
            const compressed = new Promise<void>((resolve, reject) => {
                rejectFile = reject;
                stream.ondata = (error, chunk, final) => {
                    ondata(error, chunk, final);
                    if (error) reject(error);
                    else if (final) resolve();
                };
            });
            await Promise.all([compressed, (async () => {
                for (let offset = 0; offset < data.length || offset === 0; offset += CHUNK_BYTES) {
                    if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
                    if (archiveError) throw archiveError;
                    const final = offset + CHUNK_BYTES >= data.length;
                    stream.push(data.slice(offset, offset + CHUNK_BYTES), final);
                    if (performance.now() >= yieldAt) {
                        await sleep(0);
                        yieldAt = performance.now() + 8;
                    }
                }
            })()]);
            if ("terminate" in stream) stream.terminate();
        }
        if (signal.aborted) throw new DOMException("Upload cancelled.", "AbortError");
        archive.end();
        if (archiveError) throw archiveError;
        return new File(chunks, name, { type: "application/zip" });
    } finally {
        signal.removeEventListener("abort", cancel);
        archive.terminate();
    }
}
