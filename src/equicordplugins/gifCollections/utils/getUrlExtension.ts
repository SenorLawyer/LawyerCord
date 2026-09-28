/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseUrl } from "@utils/misc";

export function getUrlExtension(url: string) {
    const parsed = parseUrl(url.startsWith("//") ? `https:${url}` : url);
    return parsed?.pathname.match(/\.([^./]+)$/)?.[1].toLowerCase();
}
