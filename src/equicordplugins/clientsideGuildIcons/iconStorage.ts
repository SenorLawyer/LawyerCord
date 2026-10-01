/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function readStoredGuildIcons(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function normalizeStoredGuildIcon(value: unknown): Promise<Blob | null> {
    if (value instanceof Blob) return value.type.startsWith("image/") ? value : null;
    if (typeof value !== "string" || !value.startsWith("data:image/")) return null;

    const blob = await fetch(value).then(response => response.blob()).catch(() => null);
    return blob?.type.startsWith("image/") ? blob : null;
}

export async function normalizeStoredGuildIcons(value: unknown): Promise<Record<string, Blob>> {
    const icons: Record<string, Blob> = {};

    for (const [guildId, storedIcon] of Object.entries(readStoredGuildIcons(value))) {
        const icon = await normalizeStoredGuildIcon(storedIcon);
        if (icon) icons[guildId] = icon;
    }

    return icons;
}
