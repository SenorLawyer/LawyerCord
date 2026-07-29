/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const UPDATE_CHANNELS = ["stable", "beta", "nightly"] as const;

export type UpdateChannel = typeof UPDATE_CHANNELS[number];

export function normalizeUpdateChannel(value: unknown): UpdateChannel {
    return typeof value === "string" && UPDATE_CHANNELS.includes(value as UpdateChannel) ? value as UpdateChannel : "stable";
}
