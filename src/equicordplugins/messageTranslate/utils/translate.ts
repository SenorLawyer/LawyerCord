/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { settings } from "../settings";
import { CachedTranslation, TranslateResponse } from "../types";

const logger = new Logger("MessageTranslate");

const translationCache = new Map<string, CachedTranslation>();
const inProgress = new Map<string, AbortController>();
const failed = new Map<string, string>();

export function resetTranslations() {
    for (const controller of inProgress.values()) controller.abort();
    inProgress.clear();
    translationCache.clear();
    failed.clear();
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > 1000) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
    }
}

export function getCached(messageId: string): CachedTranslation | undefined {
    return translationCache.get(messageId);
}

export function hasFailed(messageId: string, text: string): boolean {
    return failed.get(messageId) === text;
}

export function isInProgress(messageId: string): boolean {
    return inProgress.has(messageId);
}

export function clearCache(messageId: string) {
    translationCache.delete(messageId);
    failed.delete(messageId);
}

async function fetchTranslation(text: string, targetLang: string, signal: AbortSignal): Promise<TranslateResponse> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&dj=1&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, { signal });

    if (!response.ok) {
        throw new Error(`Translation API returned ${response.status} ${response.statusText}`);
    }

    return await response.json();
}

export async function translate(messageId: string, text: string): Promise<CachedTranslation | null> {
    if (inProgress.has(messageId)) return null;
    const cached = translationCache.get(messageId);
    if (cached) return cached;

    const controller = new AbortController();
    inProgress.set(messageId, controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
        const targetLang = settings.store.targetLanguage;
        const response = await fetchTranslation(text, targetLang, controller.signal);
        if (controller.signal.aborted) return null;

        if (response.src === targetLang || response.confidence < settings.store.confidenceRequirement) {
            remember(failed, messageId, text);
            return null;
        }

        let translatedText = "";
        for (const sentence of response.sentences) {
            if (sentence.trans) translatedText += sentence.trans;
        }

        if (!translatedText || translatedText === text) {
            remember(failed, messageId, text);
            return null;
        }

        const entry: CachedTranslation = {
            original: text,
            translated: translatedText,
            sourceLang: response.src,
        };
        remember(translationCache, messageId, entry);
        return entry;
    } catch (e) {
        if (controller.signal.aborted) return null;
        logger.error("Translation failed", e);
        remember(failed, messageId, text);
        return null;
    } finally {
        clearTimeout(timeout);
        if (inProgress.get(messageId) === controller) inProgress.delete(messageId);
    }
}
