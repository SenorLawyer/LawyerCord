/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import workerSource from "file://./encode.worker.ts?minify&bundle";

export function encodeGif(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, delays: number[], signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        let worker: Worker;
        try {
            worker = new Worker(url);
        } catch (error) {
            URL.revokeObjectURL(url);
            reject(error);
            return;
        }
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            worker.terminate();
            URL.revokeObjectURL(url);
        };
        const abort = () => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error("GIF encoding cancelled.")); };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("The GIF took too long to encode. Choose smaller dimensions."));
        }, 30_000);
        signal?.addEventListener("abort", abort, { once: true });
        worker.onmessage = ({ data }: MessageEvent<Uint8Array<ArrayBuffer>>) => {
            cleanup();
            resolve(new Blob([data], { type: "image/gif" }));
        };
        worker.onerror = () => {
            cleanup();
            reject(new Error("The GIF encoder failed."));
        };
        try {
            worker.postMessage({ pixels, width, height, delays }, [pixels.buffer]);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}
