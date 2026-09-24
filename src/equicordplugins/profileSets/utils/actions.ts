/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isNonNullish } from "@utils/guards";
import { saveFile } from "@utils/web";
import { findStoreLazy } from "@webpack";
import { showToast, Toasts, UserStore } from "@webpack/common";

import { getCurrentProfile } from "./profile";
import { addPreset, movePresetInArray, presets, PresetSection, type ProfilePresetEx, removePreset, replaceAllPresets, savePresetsData, updatePreset } from "./storage";

const UserProfileSettingsStore = findStoreLazy("UserProfileSettingsStore");

function isImageInput(value: unknown): value is string | { imageUri: string; } {
    if (typeof value === "string") return value.length > 0;
    return typeof value === "object" && isNonNullish(value) && "imageUri" in value && typeof (value as { imageUri: unknown }).imageUri === "string";
}

function getFreshPendingAvatar(section: PresetSection, guildId?: string): string | null {
    const pending = (section === "server" && guildId
        ? UserProfileSettingsStore.getPendingChanges?.(guildId)
        : UserProfileSettingsStore.getPendingChanges?.()) ?? {};
    const pendingObj = pending as Record<string, unknown>;
    const selected = [pendingObj.pendingAvatar].find(isImageInput);
    if (!selected) return null;
    return typeof selected === "string" ? selected : selected.imageUri;
}

export async function savePreset(name: string, section: PresetSection, guildId?: string) {
    const userId = UserStore.getCurrentUser()?.id;
    const originalPresets = presets;
    if (!userId) throw new Error("Sign in before saving a profile preset.");
    const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server" });
    if (UserStore.getCurrentUser()?.id !== userId || presets !== originalPresets)
        throw new Error("The account or preset list changed while preparing the profile.");
    const freshPendingAvatar = getFreshPendingAvatar(section, guildId);
    const effectiveAvatar = freshPendingAvatar ?? profile.avatarDataUrl ?? null;

    const newPreset: ProfilePresetEx = {
        name,
        timestamp: Date.now(),
        ...profile,
        avatarDataUrl: effectiveAvatar,
    };
    addPreset(newPreset);
    await savePresetsData(section);
}

export async function refreshPreset(preset: ProfilePresetEx, section: PresetSection, guildId?: string) {
    const userId = UserStore.getCurrentUser()?.id;
    const originalPresets = presets;
    if (!userId || !presets.includes(preset)) throw new Error("The profile preset is no longer available.");
    const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server" });
    const index = presets.indexOf(preset);
    if (UserStore.getCurrentUser()?.id !== userId || presets !== originalPresets || index < 0)
        throw new Error("The account or preset list changed while preparing the profile.");
    updatePreset(index, {
        ...preset,
        ...Object.fromEntries(Object.entries(profile).filter(([, value]) => isNonNullish(value))),
        timestamp: Date.now()
    });
    await savePresetsData(section);
}

export async function deletePreset(index: number, section: PresetSection) {
    if (index < 0 || index >= presets.length) return;

    removePreset(index);
    await savePresetsData(section);
}

export async function movePreset(fromIndex: number, toIndex: number, section: PresetSection) {
    if (fromIndex < 0 || fromIndex >= presets.length || toIndex < 0 || toIndex >= presets.length) return;

    movePresetInArray(fromIndex, toIndex);
    await savePresetsData(section);
}

export async function renamePreset(index: number, newName: string, section: PresetSection) {
    if (index < 0 || index >= presets.length || !newName.trim()) return;

    const updatedPreset = { ...presets[index], name: newName.trim() };
    updatePreset(index, updatedPreset);
    await savePresetsData(section);
}

export function exportPresets(section: PresetSection) {
    const dataStr = JSON.stringify(presets, null, 2);
    saveFile(new File([dataStr], `profile-presets-${section}-${Date.now()}.json`, { type: "application/json" }));
}

export type ImportDecision = "override" | "merge" | "cancel";

export async function importPresets(
    forceUpdate: () => void,
    onImportPrompt: (existingCount: number) => Promise<ImportDecision>,
    section: PresetSection
) {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    const originalPresets = presets;
    const checkScope = () => {
        if (UserStore.getCurrentUser()?.id !== userId || presets !== originalPresets)
            throw new Error("The account or preset list changed during import.");
    };
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async (event: Event) => {
        try {
            const target = event.currentTarget as HTMLInputElement | null;
            const file = target?.files?.[0];
            if (!file) return;

            const text = await file.text();
            checkScope();
            const importedPresets: unknown = JSON.parse(text);

            if (!Array.isArray(importedPresets) || !importedPresets.every((preset: unknown) =>
                typeof preset === "object" && preset !== null
                && "name" in preset && typeof preset.name === "string"
                && "timestamp" in preset && typeof preset.timestamp === "number"
                && Number.isFinite(new Date(preset.timestamp).getTime())
            )) throw new Error("Invalid profile preset list.");

            if (presets.length > 0) {
                const decision = await onImportPrompt(presets.length);
                if (decision === "cancel") return;
                checkScope();
                if (decision === "override") {
                    replaceAllPresets(importedPresets);
                } else {
                    const combined = [...presets, ...importedPresets];
                    replaceAllPresets(combined);
                }
            } else {
                replaceAllPresets(importedPresets);
            }

            await savePresetsData(section);
            forceUpdate();
        } catch {
            showToast("Could not import the profile presets.", Toasts.Type.FAILURE);
        }
    };
    input.click();
}
