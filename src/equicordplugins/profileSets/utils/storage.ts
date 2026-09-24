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
let activeScopeKey: string | null = null;
let loadGeneration = 0;
let pendingSave: Promise<void> | undefined;

function resetPresets(nextPresets: ProfilePresetEx[] = []) {
    presets = nextPresets;
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
        if (pendingSave) await pendingSave;
        if (!isCurrentLoad(generation, userId)) return;
        const stored = await DataStore.get(key);
        if (!isCurrentLoad(generation, userId)) return;

        if (stored !== undefined) {
            if (!Array.isArray(stored)) throw new Error("The saved profile preset list is invalid.");
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
        throw err;
    }
}

export async function savePresetsData(section: PresetSection, nextPresets: ProfilePresetEx[] = presets) {
    const userId = getCurrentUserId();
    if (!userId) throw new Error("No account is signed in.");
    const key = getPresetsKey(section, userId);
    if (key !== activeScopeKey) throw new Error("The preset list has not finished loading.");
    if (pendingSave) throw new Error("A preset change is still being saved.");
    const generation = loadGeneration;
    try {
        const write = DataStore.set(key, nextPresets);
        pendingSave = write.then(() => undefined, () => undefined);
        await write;
        if (!isCurrentLoad(generation, userId) || activeScopeKey !== key)
            throw new Error("The account or preset list changed while saving.");
        presets = nextPresets;
    } finally {
        pendingSave = undefined;
    }
}
