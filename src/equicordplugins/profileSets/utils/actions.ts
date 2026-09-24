/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isNonNullish } from "@utils/guards";
import { chooseFile, saveFile } from "@utils/web";
import { findStoreLazy } from "@webpack";
import { showToast, Toasts, UserStore } from "@webpack/common";

import { getCurrentProfile } from "./profile";
import { PresetSection, type PresetStorage, type ProfilePresetEx } from "./storage";
import { isPresetList } from "./validation";

const UserProfileSettingsStore = findStoreLazy("UserProfileSettingsStore");

function getFreshPendingAvatar(section: PresetSection, guildId?: string): string | null {
    const pending = (section === "server" && guildId
        ? UserProfileSettingsStore.getPendingChanges?.(guildId)
        : UserProfileSettingsStore.getPendingChanges?.()) ?? {};
    const { pendingAvatar } = pending as Record<string, unknown>;
    if (typeof pendingAvatar === "string") return pendingAvatar || null;
    if (typeof pendingAvatar === "object" && isNonNullish(pendingAvatar)
        && "imageUri" in pendingAvatar && typeof pendingAvatar.imageUri === "string")
        return pendingAvatar.imageUri;
    return null;
}

export type ImportDecision = "override" | "merge" | "cancel";
export type PresetActions = ReturnType<typeof createPresetActions>;

export function createPresetActions(storage: PresetStorage) {
    async function savePreset(name: string, section: PresetSection, guildId?: string) {
        const userId = UserStore.getCurrentUser()?.id;
        const originalPresets = storage.presets;
        if (!userId) throw new Error("Sign in before saving a profile preset.");
        const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server" });
        if (UserStore.getCurrentUser()?.id !== userId || storage.presets !== originalPresets)
            throw new Error("The account or preset list changed while preparing the profile.");
        const freshPendingAvatar = getFreshPendingAvatar(section, guildId);
        const effectiveAvatar = freshPendingAvatar ?? profile.avatarDataUrl ?? null;

        const newPreset: ProfilePresetEx = {
            name,
            timestamp: Date.now(),
            ...profile,
            avatarDataUrl: effectiveAvatar,
        };
        await storage.savePresetsData(section, [...storage.presets, newPreset]);
    }

    async function refreshPreset(preset: ProfilePresetEx, section: PresetSection, guildId?: string) {
        const userId = UserStore.getCurrentUser()?.id;
        const originalPresets = storage.presets;
        if (!userId || !storage.presets.includes(preset)) throw new Error("The profile preset is no longer available.");
        const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server" });
        const index = storage.presets.indexOf(preset);
        if (UserStore.getCurrentUser()?.id !== userId || storage.presets !== originalPresets || index < 0)
            throw new Error("The account or preset list changed while preparing the profile.");
        const updatedPreset = {
            ...preset,
            ...Object.fromEntries(Object.entries(profile).filter(([, value]) => isNonNullish(value))),
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
        const dataStr = JSON.stringify(storage.presets, null, 2);
        saveFile(new File([dataStr], `profile-presets-${section}-${Date.now()}.json`, { type: "application/json" }));
    }

    async function importPresets(
        forceUpdate: () => void,
        onImportPrompt: (existingCount: number) => Promise<ImportDecision>,
        section: PresetSection
    ) {
        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) return;
        const originalPresets = storage.presets;
        const checkScope = () => {
            if (UserStore.getCurrentUser()?.id !== userId || storage.presets !== originalPresets)
                throw new Error("The account or preset list changed during import.");
        };
        try {
            const file = await chooseFile("application/json");
            if (!file) return;

            const text = await file.text();
            checkScope();
            const importedPresets: unknown = JSON.parse(text);

            if (!isPresetList(importedPresets)) throw new Error("Invalid profile preset list.");

            const decision = storage.presets.length > 0 ? await onImportPrompt(storage.presets.length) : "override";
            if (decision === "cancel") return;
            checkScope();
            await storage.savePresetsData(section, decision === "merge" ? [...storage.presets, ...importedPresets] : importedPresets);
            forceUpdate();
        } catch {
            showToast("Could not import the profile presets.", Toasts.Type.FAILURE);
        }
    }

    return { savePreset, refreshPreset, deletePreset, movePreset, renamePreset, exportPresets, importPresets };
}
