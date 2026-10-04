/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { CompressionMode } from "./policy";

export async function compressNative(file: File, limit: number, signal: AbortSignal, progress: (status: string) => void, mode: CompressionMode) {
    const native = VencordNative.pluginHelpers.MediaCompressor as PluginNative<typeof import("./native")> | undefined;
    if (!native) return null;
    const id = crypto.randomUUID();
    const abort = () => { void native.release(id); };
    signal.addEventListener("abort", abort, { once: true });
    let polling = false;
    const timer = setInterval(async () => {
        if (polling || signal.aborted) return;
        polling = true;
        try { const status = await native.status(id); if (status && !signal.aborted) progress(status); }
        catch { clearInterval(timer); }
        finally { polling = false; }
    }, 500);
    try {
        progress("Preparing the native encoder");
        const started = await native.begin(id, file.name, file.type, file.size, limit, mode);
        signal.throwIfAborted();
        if (started.error) throw new Error(started.error);
        if (!started.available) return null;
        for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
            signal.throwIfAborted();
            if (!await native.append(id, new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer())))
                throw new Error("The encoder could not read this attachment. Your original file is still attached.");
        }
        signal.throwIfAborted();
        const result = await native.finish(id);
        signal.throwIfAborted();
        if (result.error || !result.size) throw new Error(result.error || "The encoder returned an empty file.");
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        for (let offset = 0; offset < result.size; offset += 4 * 1024 * 1024) {
            signal.throwIfAborted();
            const chunk = await native.read(id, offset);
            if (!chunk) throw new Error("The compressed attachment could not be read.");
            chunks.push(new Uint8Array(chunk));
        }
        return new File(chunks, file.name.replace(/\.[^.]+$/, "") + result.extension, { type: result.type });
    } finally {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
        await native.release(id);
    }
}
