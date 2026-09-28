/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readResponseText } from "@shared/readResponseText";
import { IpcMainInvokeEvent, WebFrameMain } from "electron";

const requests = new WeakMap<WebFrameMain, Map<string, AbortController>>();

async function runRequest<T>(event: IpcMainInvokeEvent, id: unknown, run: (signal: AbortSignal) => Promise<T>, failure: T): Promise<T> {
    if (id === undefined) return run(AbortSignal.timeout(30_000));
    const frame = event.senderFrame;
    if (!frame || typeof id !== "string" || !id.length || id.length > 64) return failure;
    let active = requests.get(frame);
    if (!active) requests.set(frame, active = new Map());
    if (active.has(id)) return failure;
    const controller = new AbortController();
    active.set(id, controller);
    try {
        return await run(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
    } finally {
        active.delete(id);
        if (!active.size) requests.delete(frame);
    }
}

export function cancelTranslateRequest(event: IpcMainInvokeEvent, id: unknown) {
    if (event.senderFrame && typeof id === "string") requests.get(event.senderFrame)?.get(id)?.abort();
}

export async function makeDeeplTranslateRequest(event: IpcMainInvokeEvent, pro: unknown, apiKey: unknown, payload: unknown, requestId?: unknown) {
    if (typeof pro !== "boolean" || typeof apiKey !== "string" || typeof payload !== "string")
        return { status: -1, data: "" };

    if (Buffer.byteLength(payload, "utf8") > 128 * 1024)
        return { status: 413, data: "" };

    const url = pro
        ? "https://api.deepl.com/v2/translate"
        : "https://api-free.deepl.com/v2/translate";

    return runRequest(event, requestId, async signal => {
        try {
            const res = await fetch(url, {
                method: "POST",
                redirect: "error",
                signal,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `DeepL-Auth-Key ${apiKey}`
                },
                body: payload
            });

            if (res.status !== 200) {
                await res.body?.cancel();
                return { status: res.status, data: "" };
            }

            const data = await readResponseText(res, 8 * 1024 * 1024);
            return { status: res.status, data };
        } catch {
            return { status: -1, data: "" };
        }
    }, { status: -1, data: "" });
}

export async function makeKagiTranslateRequest(event: IpcMainInvokeEvent, token: unknown, text: unknown, sourceLang: unknown, targetLang: unknown, requestId?: unknown) {
    if (typeof token !== "string" || typeof text !== "string" || typeof sourceLang !== "string" || typeof targetLang !== "string")
        return { status: -1, data: null };

    const body = JSON.stringify({ text, from: sourceLang, to: targetLang, model: "standard" });
    if (Buffer.byteLength(body, "utf8") > 128 * 1024)
        return { status: 413, data: null };

    const url = "https://translate.kagi.com/api/translate";

    return runRequest(event, requestId, async signal => {
        try {
            const res = await fetch(url, {
                method: "POST",
                redirect: "error",
                signal,
                headers: {
                    "Content-Type": "application/json",
                    "Cookie": `kagi_session=${token}`
                },
                body,
            });

            if (res.status !== 200) {
                await res.body?.cancel();
                return { status: res.status, data: null };
            }

            const data: unknown = JSON.parse(await readResponseText(res, 8 * 1024 * 1024));
            return { status: res.status, data };
        } catch {
            return { status: -1, data: null };
        }
    }, { status: -1, data: null });
}
