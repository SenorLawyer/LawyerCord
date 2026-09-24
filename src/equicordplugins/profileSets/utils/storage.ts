/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Logger } from "@utils/Logger";
import { ProfilePreset } from "@vencord/discord-types";
import { UserStore } from "@webpack/common";

const logger = new Logger("ProfilePresets");
const LEGACY_PRESETS_KEY = "ProfileDataset";
const MAIN_PRESETS_KEY = "ProfilePresets_v2_Main";
const SERVER_PRESETS_KEY = "ProfilePresets_v2_Server";

export type PresetSection = "main" | "server";

export type ProfilePresetEx = ProfilePreset & {
    avatarRaw?: string | null;
};

export let presets: ProfilePresetEx[] = [];
export let currentPresetIndex = -1;
let activeScopeKey: string | null = null;
let loadGeneration = 0;

function resetPresets(nextPresets: ProfilePresetEx[] = []) {
    presets = nextPresets;
    currentPresetIndex = -1;
}

function getPresetsKey(section: PresetSection, userId: string) {
    const baseKey = section === "main" ? MAIN_PRESETS_KEY : SERVER_PRESETS_KEY;
    return `${baseKey}:${userId}`;
}

function getLegacyKey(userId: string) {
    return `${LEGACY_PRESETS_KEY}:${userId}:main`;
}

function getCurrentUserId() {
    return UserStore.getCurrentUser()?.id ?? null;
}

function isCurrentLoad(generation: number, userId: string) {
    return generation === loadGeneration && getCurrentUserId() === userId;
}

export async function loadPresets(section: PresetSection) {
    const userId = getCurrentUserId();
    if (!userId) {
        activeScopeKey = null;
        loadGeneration++;
        resetPresets();
        return;
    }

    const key = getPresetsKey(section, userId);
    const generation = ++loadGeneration;
    activeScopeKey = null;
    resetPresets();

    try {
        const stored = await DataStore.get(key);
        if (!isCurrentLoad(generation, userId)) return;

        if (stored && Array.isArray(stored)) {
            activeScopeKey = key;
            resetPresets(stored);
            return;
        }

        if (section === "main") {
            const legacyKey = getLegacyKey(userId);
            const [legacyStored, legacyBaseStored] = await Promise.all([
                DataStore.get(legacyKey),
                DataStore.get(LEGACY_PRESETS_KEY)
            ]);
            if (!isCurrentLoad(generation, userId)) return;

            const legacyToUse = Array.isArray(legacyStored)
                ? legacyStored
                : (Array.isArray(legacyBaseStored) ? legacyBaseStored : null);
            if (legacyToUse) {
                await DataStore.set(key, legacyToUse);
                await DataStore.del(Array.isArray(legacyStored) ? legacyKey : LEGACY_PRESETS_KEY);
                if (!isCurrentLoad(generation, userId)) return;
                activeScopeKey = key;
                resetPresets(legacyToUse);
                return;
            }
        }
        activeScopeKey = key;
        resetPresets();
    } catch (err) {
        if (!isCurrentLoad(generation, userId)) return;

        logger.error("Failed to load presets", err);
        resetPresets();
    }
}

export async function savePresetsData(section: PresetSection) {
    try {
        const userId = getCurrentUserId();
        if (!userId) return;

        const key = getPresetsKey(section, userId);
        if (key !== activeScopeKey) return;
        await DataStore.set(key, presets);
    } catch (err) {
        logger.error("Failed to save presets", err);
    }
}

export function setCurrentPresetIndex(index: number) {
    currentPresetIndex = index;
}

export function addPreset(preset: ProfilePresetEx) {
    presets.push(preset);
}

export function updatePreset(index: number, preset: ProfilePresetEx) {
    if (index >= 0 && index < presets.length) {
        presets[index] = preset;
    }
}

export function removePreset(index: number) {
    if (index >= 0 && index < presets.length) {
        presets.splice(index, 1);
        if (currentPresetIndex === index) {
            currentPresetIndex = -1;
        } else if (currentPresetIndex > index) {
            currentPresetIndex--;
        }
    }
}

export function movePresetInArray(fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || fromIndex >= presets.length || toIndex < 0 || toIndex >= presets.length) return;
    const [preset] = presets.splice(fromIndex, 1);
    presets.splice(toIndex, 0, preset);
}

export function replaceAllPresets(newPresets: ProfilePresetEx[]) {
    presets = newPresets;
}
