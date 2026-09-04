/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { randomUUID } from "crypto";
import { type IpcMainInvokeEvent, safeStorage } from "electron";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { join } from "path";

const STORAGE_DIR = join(DATA_DIR, "automations");
const KEY_PATH = join(STORAGE_DIR, "openrouter-key.bin");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODEL_CACHE_MS = 60 * 60 * 1000;
/** A model id is "vendor/name", optionally with a ":variant" suffix such as ":free". */
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

export interface OpenRouterModel {
    id: string;
    name: string;
    promptPrice: number;
    completionPrice: number;
    contextLength: number;
}

let modelCache: { models: OpenRouterModel[]; fetchedAt: number; } | null = null;
/** Ids OpenRouter has confirmed exist, so a completion cannot smuggle in an arbitrary URL path. */
let knownModelIds = new Set<string>();

const completions = new Map<string, AbortController>();

interface CompletionInput {
    requestId: string;
    timeoutSeconds: number;
    messages: { role: "user" | "assistant"; content: string; }[];
    model: string;
    systemPrompt: string;
    prompt: string;
    maxTokens: number;
    temperature: number;
    json: boolean;
}

interface CompletionResult {
    success: boolean;
    content?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    error?: string;
}

function secureStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
        && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function atomicWrite(value: Uint8Array): Promise<void> {
    await mkdir(STORAGE_DIR, { recursive: true });
    const temporaryPath = `${KEY_PATH}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, value, { mode: 0o600 });
    await rename(temporaryPath, KEY_PATH);
}

async function readKey(): Promise<string | null> {
    if (!secureStorageAvailable()) return null;
    try {
        return safeStorage.decryptString(await readFile(KEY_PATH));
    } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
    }
}

function completionInput(value: unknown): CompletionInput | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const input = value as Partial<CompletionInput>;
    if (
        typeof input.requestId !== "string"
        || !/^[\w-]{1,80}$/.test(input.requestId)
        || typeof input.timeoutSeconds !== "number" || !Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 300
        || !Array.isArray(input.messages) || input.messages.length > 40 || JSON.stringify(input.messages).length > 100000
        || !input.messages.every(message => typeof message === "object" && message !== null && (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.length <= 20000)
        || typeof input.model !== "string"
        || !MODEL_ID.test(input.model)
        || input.model.length > 120
        || (knownModelIds.size > 0 && !knownModelIds.has(input.model))
        || typeof input.systemPrompt !== "string"
        || input.systemPrompt.length > 20_000
        || typeof input.prompt !== "string"
        || input.prompt.length === 0
        || input.prompt.length > 100_000
        || typeof input.maxTokens !== "number"
        || !Number.isInteger(input.maxTokens)
        || input.maxTokens < 16
        || input.maxTokens > 4_096
        || typeof input.temperature !== "number"
        || !Number.isFinite(input.temperature)
        || input.temperature < 0
        || input.temperature > 2
        || typeof input.json !== "boolean"
    ) return null;
    return input as CompletionInput;
}

async function responseText(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error("OpenRouter returned too much data.");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

function toModel(value: unknown): OpenRouterModel | null {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || !MODEL_ID.test(entry.id)) return null;
    const pricing = typeof entry.pricing === "object" && entry.pricing !== null ? entry.pricing as Record<string, unknown> : {};
    const price = (key: string) => {
        const raw = pricing[key];
        const parsed = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : Number.NaN;
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        promptPrice: price("prompt"),
        completionPrice: price("completion"),
        contextLength: typeof entry.context_length === "number" ? entry.context_length : 0,
    };
}

/** The models OpenRouter currently serves. Cached for an hour; no key needed to read it. */
export async function listOpenRouterModels(_event: IpcMainInvokeEvent, refresh?: unknown): Promise<{ success: boolean; models?: OpenRouterModel[]; error?: string; }> {
    if (modelCache && refresh !== true && Date.now() - modelCache.fetchedAt < MODEL_CACHE_MS) {
        return { success: true, models: modelCache.models };
    }
    try {
        const response = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) return { success: false, error: `OpenRouter returned ${response.status} for its model list.` };
        const parsed: unknown = JSON.parse(await responseText(response));
        const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).data : null;
        if (!Array.isArray(data)) return { success: false, error: "OpenRouter did not return a model list." };

        const models = data.flatMap(entry => {
            const model = toModel(entry);
            return model ? [model] : [];
        }).sort((left, right) => left.name.localeCompare(right.name));
        if (!models.length) return { success: false, error: "OpenRouter returned no usable models." };

        modelCache = { models, fetchedAt: Date.now() };
        knownModelIds = new Set(models.map(model => model.id));
        return { success: true, models };
    } catch {
        return { success: false, error: "OpenRouter's model list could not be reached." };
    }
}

export async function getOpenRouterStatus(_event: IpcMainInvokeEvent): Promise<{ available: boolean; configured: boolean; error?: string; }> {
    if (!secureStorageAvailable()) return { available: false, configured: false, error: "Secure operating system storage is unavailable." };
    try {
        return { available: true, configured: Boolean(await readKey()) };
    } catch {
        return { available: true, configured: false, error: "Encrypted credential storage could not be read." };
    }
}

export async function setOpenRouterKey(_event: IpcMainInvokeEvent, value: unknown): Promise<{ success: boolean; error?: string; }> {
    if (!secureStorageAvailable()) return { success: false, error: "Secure operating system storage is unavailable." };
    if (typeof value !== "string" || value.trim().length < 20 || value.trim().length > 512)
        return { success: false, error: "Enter a valid OpenRouter API key." };
    try {
        await atomicWrite(safeStorage.encryptString(value.trim()));
        return { success: true };
    } catch {
        return { success: false, error: "The OpenRouter key could not be saved." };
    }
}

export async function clearOpenRouterKey(_event: IpcMainInvokeEvent): Promise<{ success: boolean; error?: string; }> {
    try {
        await unlink(KEY_PATH);
        return { success: true };
    } catch (error) {
        return isMissingFile(error) ? { success: true } : { success: false, error: "The OpenRouter key could not be removed." };
    }
}

export function cancelOpenRouter(event: IpcMainInvokeEvent, requestId: unknown): { success: boolean; } {
    if (typeof requestId !== "string" || !/^[\w-]{1,80}$/.test(requestId)) return { success: false };
    completions.get(`${event.sender.id}:${requestId}`)?.abort();
    return { success: true };
}

export async function completeOpenRouter(_event: IpcMainInvokeEvent, value: unknown): Promise<CompletionResult> {
    const input = completionInput(value);
    if (!input) return { success: false, error: "The AI block configuration is invalid." };
    if (completions.size >= 32) return { success: false, error: "Too many AI requests are active." };
    const requestKey = `${_event.sender.id}:${input.requestId}`;
    if (completions.has(requestKey)) return { success: false, error: "This AI request is already running." };
    const controller = new AbortController();
    completions.set(requestKey, controller);
    let key: string | null;
    try {
        key = await readKey();
    } catch {
        completions.delete(requestKey);
        return { success: false, error: "The OpenRouter key could not be read." };
    }
    if (!key) { completions.delete(requestKey); return { success: false, error: "Add an OpenRouter API key in Automation settings." }; }

    const timeout = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
    try {
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/SenorLawyer/LawyerCord",
                "X-OpenRouter-Title": "LawyerCord Automations",
            },
            body: JSON.stringify({
                model: input.model,
                messages: [
                    ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
                    ...input.messages,
                    { role: "user", content: input.prompt },
                ],
                max_tokens: input.maxTokens,
                temperature: input.temperature,
                ...(input.json ? { response_format: { type: "json_object" } } : {}),
            }),
        });
        const text = await responseText(response);
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            return { success: false, error: `OpenRouter returned HTTP ${response.status}.` };
        }
        if (typeof body !== "object" || body === null || Array.isArray(body))
            return { success: false, error: "OpenRouter returned an invalid response." };
        const record = body as Record<string, unknown>;
        if (!response.ok) {
            const { error } = record;
            const errorMessage = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
                ? error.message
                : `OpenRouter returned HTTP ${response.status}.`;
            return { success: false, error: errorMessage.slice(0, 500) };
        }
        const { choices } = record;
        const first = Array.isArray(choices) ? choices[0] : undefined;
        const resultMessage = typeof first === "object" && first !== null && "message" in first ? first.message : undefined;
        const content = typeof resultMessage === "object" && resultMessage !== null && "content" in resultMessage && typeof resultMessage.content === "string"
            ? resultMessage.content
            : undefined;
        if (!content) return { success: false, error: "OpenRouter returned no text." };
        const usage = typeof record.usage === "object" && record.usage !== null ? record.usage as Record<string, unknown> : {};
        return {
            success: true,
            content,
            model: typeof record.model === "string" ? record.model : input.model,
            promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
            completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
        };
    } catch (error) {
        return { success: false, error: error instanceof DOMException && error.name === "AbortError" ? "OpenRouter timed out." : "The OpenRouter request failed." };
    } finally {
        clearTimeout(timeout);
        completions.delete(requestKey);
    }
}
