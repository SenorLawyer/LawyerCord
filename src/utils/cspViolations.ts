/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useLayoutEffect } from "@webpack/common";

import { useForceUpdater } from "./react";

const cssRelevantDirectives = ["style-src", "style-src-elem", "img-src", "font-src"] as const;

export const CspBlockedUrls = new Set<string>();
const CspErrorListeners = new Set<() => void>();

document.addEventListener("securitypolicyviolation", ({ effectiveDirective, blockedURI }) => {
    if (!blockedURI || !cssRelevantDirectives.includes(effectiveDirective as any)) return;
    if (CspBlockedUrls.has(blockedURI)) return;

    CspBlockedUrls.add(blockedURI);
    if (CspBlockedUrls.size > 256) {
        const oldest = CspBlockedUrls.values().next().value;
        if (oldest !== undefined) CspBlockedUrls.delete(oldest);
    }

    CspErrorListeners.forEach(listener => listener());
});

export function useCspErrors() {
    const forceUpdate = useForceUpdater();

    useLayoutEffect(() => {
        CspErrorListeners.add(forceUpdate);

        return () => void CspErrorListeners.delete(forceUpdate);
    }, [forceUpdate]);

    return [...CspBlockedUrls] as const;
}
