/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export let RENDERER_CSS_URL: string;

let resolveMetaReady: Function;
export const metaReady = new Promise<void>(res => resolveMetaReady = res);

if (IS_EXTENSION) {
    const listener = (e: MessageEvent) => {
        if (e.data?.type === "vencord:meta") {
            ({ RENDERER_CSS_URL } = e.data.meta);
            window.removeEventListener("message", listener);
            resolveMetaReady();
        }
    };

    window.addEventListener("message", listener);
}
