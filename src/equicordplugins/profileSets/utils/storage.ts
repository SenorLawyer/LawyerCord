/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { Logger } from "@utils/Logger";
import { ProfilePreset } from "@vencord/discord-types";
import { lodash, UserStore } from "@webpack/common";

import { isPresetList } from "./validation";

const logger = new Logger("ProfilePresets");
const LEGACY_PRESETS_KEY = "ProfileDataset";
const MAIN_PRESETS_KEY = "ProfilePresets_v2_Main";
const SERVER_PRESETS_KEY = "ProfilePresets_v2_Server";

export type PresetSection = "main" | "server";

export type PresetStorage = ReturnType<typeof createPresetStorage>;

export function createPresetStorage() {
    let presets: ProfilePreset[] = [];
    let savedPresets: ProfilePreset[] | undefined;
    let activeScopeKey: string | null = null;
    let loadGeneration = 0;
    let pendingSave: Promise<void> | undefined;
    let hasLegacyPresets = false;

    function resetPresets(nextPresets?: ProfilePreset[]) {
        savedPresets = nextPresets;
        presets = nextPresets ?? [];
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

    function unloadPresets() {
        activeScopeKey = null;
        hasLegacyPresets = false;
        loadGeneration++;
        resetPresets();
    }

    async function loadPresets(section: PresetSection) {
        const userId = getCurrentUserId();
        if (!userId) {
            unloadPresets();
            return;
        }

        const key = getPresetsKey(section, userId);
        const generation = ++loadGeneration;
        activeScopeKey = null;
        hasLegacyPresets = false;
        resetPresets();

        try {
            if (pendingSave) await pendingSave;
            if (!isCurrentLoad(generation, userId)) return;
            const [stored, unowned] = await Promise.all([
                DataStore.get(key),
                section === "main" ? DataStore.get(LEGACY_PRESETS_KEY) : undefined
            ]);
            if (!isCurrentLoad(generation, userId)) return;
            hasLegacyPresets = unowned !== undefined;

            if (stored !== undefined) {
                if (!isPresetList(stored)) throw new Error("The saved profile preset list is invalid.");
                activeScopeKey = key;
                resetPresets(stored);
                return;
            }

            if (section === "main") {
                const legacyKey = getLegacyKey(userId);
                const legacyToUse = await DataStore.get(legacyKey);
                if (!isCurrentLoad(generation, userId)) return;

                if (legacyToUse !== undefined) {
                    if (!isPresetList(legacyToUse)) throw new Error("The legacy profile preset list is invalid.");
                    let migrated = legacyToUse;
                    await DataStore.update<ProfilePreset[]>(key, current => {
                        if (current !== undefined) {
                            if (!isPresetList(current)) throw new Error("The saved profile preset list is invalid.");
                            migrated = current;
                        }
                        return migrated;
                    });
                    if (!isCurrentLoad(generation, userId)) return;
                    activeScopeKey = key;
                    resetPresets(migrated);
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

    function isCurrentScope(section: PresetSection) {
        const userId = getCurrentUserId();
        return userId !== null && activeScopeKey === getPresetsKey(section, userId);
    }

    async function savePresetsData(section: PresetSection, nextPresets: ProfilePreset[] = presets) {
        const userId = getCurrentUserId();
        if (!userId) throw new Error("No account is signed in.");
        const key = getPresetsKey(section, userId);
        if (!isCurrentScope(section)) throw new Error("The preset list has not finished loading.");
        if (pendingSave) throw new Error("A preset change is still being saved.");
        const generation = loadGeneration;
        const expected = savedPresets;
        try {
            const write = DataStore.update<ProfilePreset[]>(key, stored => {
                if (!lodash.isEqual(stored, expected))
                    throw new Error("The saved presets changed in another client. Reopen this panel before trying again.");
                return nextPresets;
            });
            pendingSave = write.then(() => undefined, () => undefined);
            await write;
            if (!isCurrentLoad(generation, userId) || activeScopeKey !== key)
                throw new Error("The account or preset list changed while saving.");
            resetPresets(nextPresets);
        } finally {
            pendingSave = undefined;
        }
    }

    return {
        get presets() { return presets; },
        get hasLegacyPresets() { return hasLegacyPresets; },
        readLegacyPresets: () => DataStore.get(LEGACY_PRESETS_KEY),
        loadPresets, unloadPresets, savePresetsData, isCurrentScope
    };
}
