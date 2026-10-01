/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export let RENDERER_CSS_URL: string;

let resolveMetaReady: () => void;
export const metaReady = new Promise<void>(res => resolveMetaReady = res);

if (IS_EXTENSION) {
    const listener = ({ data }: MessageEvent<unknown>) => {
        if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "vencord:meta" || !("meta" in data)) return;
        const { meta } = data;
        if (typeof meta !== "object" || meta === null || !("RENDERER_CSS_URL" in meta)) return;
        const url = meta.RENDERER_CSS_URL;
        if (typeof url !== "string" || !/^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/dist\/LawyerCord\.css$/i.test(url)) return;
        RENDERER_CSS_URL = url;
        window.removeEventListener("message", listener);
        resolveMetaReady();
    };

    window.addEventListener("message", listener);
}
