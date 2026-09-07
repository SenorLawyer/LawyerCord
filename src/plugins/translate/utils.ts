/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { classNameFactory } from "@utils/css";
import { isObject, tryOrElse } from "@utils/misc";
import { PluginNative } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

import { DeeplLanguages, GoogleLanguages, KagiLanguages } from "./languages";
import { settings } from "./settings";

export const cl = classNameFactory("vc-trans-");

const Native = VencordNative.pluginHelpers.Translate as PluginNative<typeof import("./native")>;

export interface TranslationValue {
    sourceLanguage: string;
    text: string;
}

export const getLanguages = () => {
    if (IS_WEB) {
        return GoogleLanguages;
    }
    switch (settings.store.service) {
        case "google":
            return GoogleLanguages;
        case "kagi":
            return KagiLanguages;
        default:
            return DeeplLanguages;
    }
};

export async function translateText(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const service = IS_WEB ? "google" : settings.store.service;
    const translateImpl = service === "google" ? googleTranslate : service === "kagi" ? kagiTranslate : deeplTranslate;

    if (translateImpl === deeplTranslate && sourceLang === "auto")
        sourceLang = "";

    try {
        return await translateImpl(text, sourceLang, targetLang);
    } catch (e) {
        const userMessage = typeof e === "string"
            ? e
            : "Something went wrong. If this issue persists, please check the console or ask for help in the support server.";

        showToast(userMessage, Toasts.Type.FAILURE);

        throw e instanceof Error
            ? e
            : new Error(userMessage);
    }
}

export function translate(kind: "received" | "sent", text: string): Promise<TranslationValue> {
    return translateText(
        text,
        settings.store[`${kind}Input`],
        settings.store[`${kind}Output`]
    );
}

async function googleTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA", // some google API key
        "query.sourceLanguage": sourceLang,
        "query.targetLanguage": targetLang,
        "query.text": text,
    });

    const res = await fetch(url);
    if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Google Translate request failed (${res.status}).`);
    }

    const response: unknown = await res.json().catch(() => null);
    if (!isObject(response) || !("sourceLanguage" in response) || typeof response.sourceLanguage !== "string"
        || !("translation" in response) || typeof response.translation !== "string")
        throw new Error("Google Translate returned an invalid response.");
    const { sourceLanguage, translation } = response;

    return {
        sourceLanguage: GoogleLanguages[sourceLanguage] ?? sourceLanguage,
        text: translation
    };
}

async function deeplTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    if (!settings.store.deeplApiKey)
        throw "DeepL API key is not set.";

    // CORS jumpscare
    const { status, data } = await Native.makeDeeplTranslateRequest(
        settings.store.service === "deepl-pro",
        settings.store.deeplApiKey,
        JSON.stringify({
            text: [text],
            target_lang: targetLang,
            source_lang: sourceLang.split("-")[0]
        })
    );

    switch (status) {
        case 200:
            break;
        case -1:
            throw "Failed to connect to DeepL API.";
        case 403:
            throw "Invalid DeepL API key or version";
        case 456:
            throw "DeepL API quota exceeded.";
        default:
            throw new Error(`DeepL translation request failed (${status}).`);
    }

    const response: unknown = tryOrElse(() => JSON.parse(data), null);
    const translation: unknown = isObject(response) && "translations" in response && Array.isArray(response.translations)
        ? response.translations[0] : null;
    if (!isObject(translation) || !("detected_source_language" in translation) || typeof translation.detected_source_language !== "string"
        || !("text" in translation) || typeof translation.text !== "string")
        throw new Error("DeepL returned an invalid response.");

    return {
        sourceLanguage: DeeplLanguages[translation.detected_source_language] ?? translation.detected_source_language,
        text: translation.text
    };
}

async function kagiTranslate(text: string, sourceLang: string, targetLang: string): Promise<TranslationValue> {
    const { status, data } = await Native.makeKagiTranslateRequest(
        settings.store.kagiSession, text, sourceLang, targetLang
    );

    switch (status) {
        case 200:
            break;
        case 401:
            throw "Invalid or expired Kagi session token";
        default:
            throw new Error(`Kagi translation request failed (${status}).`);
    }

    const response: unknown = data;
    if (!isObject(response) || !("translation" in response) || typeof response.translation !== "string"
        || !("detected_language" in response) || !isObject(response.detected_language)
        || !("label" in response.detected_language) || typeof response.detected_language.label !== "string")
        throw new Error("Kagi returned an invalid response.");
    return {
        sourceLanguage: response.detected_language.label,
        text: response.translation
    };
}
