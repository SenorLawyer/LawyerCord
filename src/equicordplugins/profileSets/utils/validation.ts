/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ProfilePreset } from "@vencord/discord-types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isNumbers(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(isNumber);
}

export function isPresetList(value: unknown): value is ProfilePreset[] {
    return Array.isArray(value) && value.every((preset: unknown) => {
        if (!isRecord(preset) || typeof preset.name !== "string" || !isNumber(preset.timestamp)
            || !Number.isFinite(new Date(preset.timestamp).getTime())) return false;
        for (const key of ["avatarDataUrl", "bannerDataUrl", "bio", "globalName", "pronouns", "primaryGuildId"])
            if (preset[key] != null && typeof preset[key] !== "string") return false;
        if (preset.accentColor != null && !isNumber(preset.accentColor)) return false;
        if (preset.themeColors != null && !isNumbers(preset.themeColors)) return false;
        for (const key of ["avatarDecoration", "nameplate"]) {
            const item = preset[key];
            if (item == null) continue;
            if (!isRecord(item) || typeof item.skuId !== "string" || typeof item.asset !== "string") return false;
            if (key === "nameplate") {
                if (item.label !== undefined && typeof item.label !== "string") return false;
                if (item.palette !== undefined && typeof item.palette !== "string") return false;
                if (item.type !== undefined && !isNumber(item.type)) return false;
            }
        }
        const effect = preset.profileEffect;
        if (effect != null) {
            if (!isRecord(effect) || typeof effect.skuId !== "string") return false;
            for (const key of ["title", "description", "accessibilityLabel", "reducedMotionSrc", "thumbnailPreviewSrc", "staticFrameSrc"])
                if (effect[key] !== undefined && typeof effect[key] !== "string") return false;
            if (effect.effects !== undefined && !Array.isArray(effect.effects)) return false;
            if (effect.animationType !== undefined && !isNumber(effect.animationType)) return false;
            if (effect.type !== undefined && !isNumber(effect.type)) return false;
        }
        const status = preset.customStatus;
        if (status != null) {
            if (!isRecord(status)) return false;
            for (const key of ["text", "emojiId", "emojiName", "expiresAtMs"])
                if (status[key] !== undefined && typeof status[key] !== "string") return false;
        }
        const styles = preset.displayNameStyles;
        if (styles != null && (!isRecord(styles) || !isNumbers(styles.colors)
            || !isNumber(styles.font_id) || !isNumber(styles.effect_id)
            || (styles.fontId !== undefined && !isNumber(styles.fontId))
            || (styles.effectId !== undefined && !isNumber(styles.effectId)))) return false;
        return true;
    });
}
