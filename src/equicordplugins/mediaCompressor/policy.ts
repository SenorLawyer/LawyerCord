/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const compressionModes = {
    fast: { label: "Fast", description: "Finish sooner, with less detail. Large videos are resized.", preset: "ultrafast", edge: 1280, quality: 75, effort: 1, ratio: 1 },
    normal: { label: "Normal", description: "Balance speed and detail. Large videos are resized.", preset: "veryfast", edge: 1920, quality: 90, effort: 4, ratio: 1 },
    extreme: { label: "Extreme", description: "Aim for half the available size. Expect less detail and a longer wait.", preset: "fast", edge: 854, quality: 60, effort: 5, ratio: 0.5 }
} as const;
export type CompressionMode = keyof typeof compressionModes;

export function targetSize(limit: number, mode: CompressionMode) {
    return Math.floor(limit * compressionModes[mode].ratio);
}

export function videoBudget(bytes: number, duration: number) {
    const total = Math.floor(bytes * 0.97 * 8 / duration);
    const audio = Math.min(128_000, Math.floor(total * 0.15));
    if (!Number.isFinite(total) || duration <= 0 || total - audio < 32_000)
        throw new Error("This video is too long to fit at a usable quality. Trim it and try again.");
    return { video: total - audio, audio: Math.max(8_000, audio) };
}
