/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

export const cl = classNameFactory("vc-more-stickers-");
export const clPicker = (className: string, ...args: any[]) => cl("picker-" + className, ...args);

const CORS_PROXY = "https://cors.keiran0.workers.dev?url=";

function corsUrl(url: string | URL) {
    return CORS_PROXY + encodeURIComponent(url.toString());
}

export function corsFetch(url: string | URL, init?: RequestInit | undefined) {
    return fetch(corsUrl(url), init);
}
