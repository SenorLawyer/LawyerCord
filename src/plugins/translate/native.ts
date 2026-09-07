/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

export async function makeDeeplTranslateRequest(_: IpcMainInvokeEvent, pro: boolean, apiKey: string, payload: string) {
    const url = pro
        ? "https://api.deepl.com/v2/translate"
        : "https://api-free.deepl.com/v2/translate";

    try {
        const res = await fetch(url, {
            method: "POST",
            redirect: "error",
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

        const data = await res.text();
        return { status: res.status, data };
    } catch {
        return { status: -1, data: "" };
    }
}

export async function makeKagiTranslateRequest(_: IpcMainInvokeEvent, token: string, text: string, sourceLang: string, targetLang: string) {
    const url = "https://translate.kagi.com/api/translate";

    try {
        const res = await fetch(url, {
            method: "POST",
            redirect: "error",
            headers: {
                "Content-Type": "application/json",
                "Cookie": `kagi_session=${token}`
            },
            body: JSON.stringify({
                text,
                from: sourceLang,
                to: targetLang,
                model: "standard"
            }),
        });

        if (res.status !== 200) {
            await res.body?.cancel();
            return { status: res.status, data: null };
        }

        const data = await res.json();
        return { status: res.status, data };
    } catch {
        return { status: -1, data: null };
    }
}
