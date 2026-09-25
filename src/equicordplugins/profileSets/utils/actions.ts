/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { chooseFile, saveFile } from "@utils/web";
import { ProfilePreset } from "@vencord/discord-types";
import { showToast, Toasts, UserStore } from "@webpack/common";

import { getCurrentProfile } from "./profile";
import { PresetSection, type PresetStorage } from "./storage";
import { isPresetList } from "./validation";

export type ImportDecision = "override" | "merge" | "cancel";
export type PresetActions = ReturnType<typeof createPresetActions>;

export function createPresetActions(storage: PresetStorage, signal?: AbortSignal) {
    async function savePreset(name: string, section: PresetSection, guildId?: string) {
        const userId = UserStore.getCurrentUser()?.id;
        const originalPresets = storage.presets;
        if (!userId) throw new Error("Sign in before saving a profile preset.");
        const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server", signal });
        if (UserStore.getCurrentUser()?.id !== userId || storage.presets !== originalPresets)
            throw new Error("The account or preset list changed while preparing the profile.");

        const newPreset: ProfilePreset = {
            name,
            timestamp: Date.now(),
            ...profile,
        };
        await storage.savePresetsData(section, [...storage.presets, newPreset]);
    }

    async function refreshPreset(preset: ProfilePreset, section: PresetSection, guildId?: string) {
        const userId = UserStore.getCurrentUser()?.id;
        const originalPresets = storage.presets;
        if (!userId || !storage.presets.includes(preset)) throw new Error("The profile preset is no longer available.");
        const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server", signal });
        const index = storage.presets.indexOf(preset);
        if (UserStore.getCurrentUser()?.id !== userId || storage.presets !== originalPresets || index < 0)
            throw new Error("The account or preset list changed while preparing the profile.");
        const updatedPreset = {
            ...preset,
            ...Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)),
            timestamp: Date.now()
        };
        await storage.savePresetsData(section, storage.presets.map((entry, i) => i === index ? updatedPreset : entry));
    }

    async function deletePreset(index: number, section: PresetSection) {
        if (index < 0 || index >= storage.presets.length) return;

        await storage.savePresetsData(section, storage.presets.filter((_, i) => i !== index));
    }

    async function movePreset(fromIndex: number, toIndex: number, section: PresetSection) {
        if (fromIndex < 0 || fromIndex >= storage.presets.length || toIndex < 0 || toIndex >= storage.presets.length) return;

        const reordered = [...storage.presets];
        const [preset] = reordered.splice(fromIndex, 1);
        reordered.splice(toIndex, 0, preset);
        await storage.savePresetsData(section, reordered);
    }

    async function renamePreset(index: number, newName: string, section: PresetSection) {
        if (index < 0 || index >= storage.presets.length || !newName.trim()) return;

        const updatedPreset = { ...storage.presets[index], name: newName.trim() };
        await storage.savePresetsData(section, storage.presets.map((entry, i) => i === index ? updatedPreset : entry));
    }

    function exportPresets(section: PresetSection) {
        if (!storage.isCurrentScope(section)) {
            showToast("Reopen this panel before exporting profile presets.", Toasts.Type.FAILURE);
            return;
        }
        const dataStr = JSON.stringify(storage.presets, null, 2);
        saveFile(new File([dataStr], `profile-presets-${section}-${Date.now()}.json`, { type: "application/json" }));
    }

    async function importPresets(
        forceUpdate: () => void,
        onImportPrompt: (existingCount: number, recoverLegacy?: boolean) => Promise<ImportDecision>,
        section: PresetSection,
        recoverLegacy = false
    ) {
        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) return;
        const originalPresets = storage.presets;
        const checkScope = () => {
            if (UserStore.getCurrentUser()?.id !== userId || storage.presets !== originalPresets)
                throw new Error("The account or preset list changed during import.");
        };
        try {
            let importedPresets: unknown;
            if (recoverLegacy) {
                if (section !== "main") return;
                importedPresets = await storage.readLegacyPresets();
            } else {
                const file = await chooseFile("application/json");
                if (!file) return;
                importedPresets = JSON.parse(await file.text());
            }
            checkScope();

            if (!isPresetList(importedPresets)) throw new Error("Invalid profile preset list.");

            const decision = recoverLegacy || storage.presets.length > 0 ? await onImportPrompt(storage.presets.length, recoverLegacy) : "override";
            if (decision === "cancel") return;
            checkScope();
            await storage.savePresetsData(section, decision === "merge" ? [...storage.presets, ...importedPresets] : importedPresets);
            forceUpdate();
        } catch {
            showToast("Could not import the profile presets. Reopen this panel before trying again.", Toasts.Type.FAILURE);
        }
    }

    return { savePreset, refreshPreset, deletePreset, movePreset, renamePreset, exportPresets, importPresets };
}
