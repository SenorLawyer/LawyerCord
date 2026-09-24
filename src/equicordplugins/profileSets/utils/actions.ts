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
import { presets, PresetSection, type ProfilePresetEx, savePresetsData } from "./storage";
import { isPresetList } from "./validation";

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
    await savePresetsData(section, [...presets, newPreset]);
}

export async function refreshPreset(preset: ProfilePresetEx, section: PresetSection, guildId?: string) {
    const userId = UserStore.getCurrentUser()?.id;
    const originalPresets = presets;
    if (!userId || !presets.includes(preset)) throw new Error("The profile preset is no longer available.");
    const profile = await getCurrentProfile(guildId, { isGuildProfile: section === "server" });
    const index = presets.indexOf(preset);
    if (UserStore.getCurrentUser()?.id !== userId || presets !== originalPresets || index < 0)
        throw new Error("The account or preset list changed while preparing the profile.");
    const updatedPreset = {
        ...preset,
        ...Object.fromEntries(Object.entries(profile).filter(([, value]) => isNonNullish(value))),
        timestamp: Date.now()
    };
    await savePresetsData(section, presets.map((entry, i) => i === index ? updatedPreset : entry));
}

export async function deletePreset(index: number, section: PresetSection) {
    if (index < 0 || index >= presets.length) return;

    await savePresetsData(section, presets.filter((_, i) => i !== index));
}

export async function movePreset(fromIndex: number, toIndex: number, section: PresetSection) {
    if (fromIndex < 0 || fromIndex >= presets.length || toIndex < 0 || toIndex >= presets.length) return;

    const reordered = [...presets];
    const [preset] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, preset);
    await savePresetsData(section, reordered);
}

export async function renamePreset(index: number, newName: string, section: PresetSection) {
    if (index < 0 || index >= presets.length || !newName.trim()) return;

    const updatedPreset = { ...presets[index], name: newName.trim() };
    await savePresetsData(section, presets.map((entry, i) => i === index ? updatedPreset : entry));
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
    try {
        const file = await chooseFile("application/json");
        if (!file) return;

        const text = await file.text();
        checkScope();
        const importedPresets: unknown = JSON.parse(text);

        if (!isPresetList(importedPresets)) throw new Error("Invalid profile preset list.");

        const decision = presets.length > 0 ? await onImportPrompt(presets.length) : "override";
        if (decision === "cancel") return;
        checkScope();
        await savePresetsData(section, decision === "merge" ? [...presets, ...importedPresets] : importedPresets);
        forceUpdate();
    } catch {
        showToast("Could not import the profile presets.", Toasts.Type.FAILURE);
    }
}
