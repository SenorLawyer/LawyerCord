/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface NormalizedGuildIcons {
    icons: Record<string, Blob>;
    needsWrite: boolean;
}

export async function normalizeStoredGuildIcon(value: unknown): Promise<Blob | null> {
    if (value instanceof Blob) return value.type.startsWith("image/") ? value : null;
    if (typeof value !== "string" || !value.startsWith("data:image/")) return null;

    const blob = await fetch(value).then(response => response.blob()).catch(() => null);
    return blob?.type.startsWith("image/") ? blob : null;
}

export async function normalizeStoredGuildIcons(value: unknown): Promise<NormalizedGuildIcons> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { icons: {}, needsWrite: value != null };
    }

    const icons: Record<string, Blob> = {};
    let needsWrite = false;

    for (const [guildId, storedIcon] of Object.entries(value)) {
        const icon = await normalizeStoredGuildIcon(storedIcon);
        if (icon) icons[guildId] = icon;
        if (!(storedIcon instanceof Blob) || !icon) needsWrite = true;
    }

    return { icons, needsWrite };
}
