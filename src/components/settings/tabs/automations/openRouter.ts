/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import type { PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.AutomationCore as PluginNative<typeof import("@equicordplugins/automationCore.desktop/native")>;
const SETTINGS_KEY = "LawyerCord_automationAISettings";

export interface OpenRouterModel {
    id: string;
    name: string;
    promptPrice: number;
    completionPrice: number;
    contextLength: number;
}

let cachedModels: OpenRouterModel[] = [];
const modelListeners = new Set<(models: OpenRouterModel[]) => void>();
let inFlight: Promise<OpenRouterModel[]> | undefined;

/** Price per million tokens, the unit OpenRouter quotes on its own pricing page. */
export function formatModelPrice(model: OpenRouterModel): string {
    if (!model.promptPrice && !model.completionPrice) return "Free";
    const perMillion = (value: number) => `$${(value * 1_000_000).toFixed(2)}`;
    return `${perMillion(model.promptPrice)} in / ${perMillion(model.completionPrice)} out per million tokens`;
}

export function getCachedModels(): OpenRouterModel[] {
    return cachedModels;
}

export function subscribeModels(listener: (models: OpenRouterModel[]) => void): () => void {
    modelListeners.add(listener);
    return () => modelListeners.delete(listener);
}

/** Loads the live catalogue from OpenRouter. Shared, so many pickers cause one request. */
export function loadOpenRouterModels(refresh = false): Promise<OpenRouterModel[]> {
    if (cachedModels.length && !refresh) return Promise.resolve(cachedModels);
    if (inFlight && !refresh) return inFlight;

    inFlight = (async () => {
        if (!IS_DISCORD_DESKTOP) return [];
        const result = await Native.listOpenRouterModels(refresh);
        if (result.success && result.models) {
            cachedModels = result.models;
            for (const listener of modelListeners) listener(cachedModels);
        }
        return cachedModels;
    })().finally(() => { inFlight = undefined; });

    return inFlight;
}

export interface AutomationAISettings {
    defaultModel: string;
    maxTokens: number;
    temperature: number;
}

export const DEFAULT_AI_SETTINGS: AutomationAISettings = {
    defaultModel: "",
    maxTokens: 800,
    temperature: 0.2,
};

export async function getAutomationAISettings(): Promise<AutomationAISettings> {
    const value = await DataStore.get<Partial<AutomationAISettings>>(SETTINGS_KEY);
    const defaultModel = value?.defaultModel;
    return {
        // Validated against OpenRouter's live catalogue at send time, not against a baked-in list.
        defaultModel: typeof defaultModel === "string" ? defaultModel : DEFAULT_AI_SETTINGS.defaultModel,
        maxTokens: Number.isInteger(value?.maxTokens) ? Math.min(4_096, Math.max(16, value?.maxTokens ?? 800)) : DEFAULT_AI_SETTINGS.maxTokens,
        temperature: typeof value?.temperature === "number" && Number.isFinite(value.temperature) ? Math.min(2, Math.max(0, value.temperature)) : DEFAULT_AI_SETTINGS.temperature,
    };
}

export async function setAutomationAISettings(value: AutomationAISettings): Promise<void> {
    await DataStore.set(SETTINGS_KEY, value);
}

export async function getOpenRouterStatus() {
    if (!IS_DISCORD_DESKTOP) return { available: false, configured: false, error: "OpenRouter blocks require Discord Desktop." };
    return Native.getOpenRouterStatus();
}

export async function setOpenRouterKey(value: string) {
    if (!IS_DISCORD_DESKTOP) return { success: false, error: "OpenRouter blocks require Discord Desktop." };
    return Native.setOpenRouterKey(value);
}

export async function clearOpenRouterKey() {
    if (!IS_DISCORD_DESKTOP) return { success: false, error: "OpenRouter blocks require Discord Desktop." };
    return Native.clearOpenRouterKey();
}

export async function completeOpenRouter(value: { model: string; systemPrompt: string; prompt: string; maxTokens: number; temperature: number; json: boolean; timeoutSeconds: number; messages: import("./ai").AIMessage[]; }, signal: AbortSignal) {
    if (!IS_DISCORD_DESKTOP) return { success: false, error: "OpenRouter blocks require Discord Desktop." };
    if (signal.aborted) throw new Error("Run cancelled.");
    const requestId = crypto.randomUUID();
    const cancel = () => { void Native.cancelOpenRouter(requestId); };
    signal.addEventListener("abort", cancel, { once: true });
    try { return await Native.completeOpenRouter({ ...value, requestId }); }
    finally { signal.removeEventListener("abort", cancel); }
}
