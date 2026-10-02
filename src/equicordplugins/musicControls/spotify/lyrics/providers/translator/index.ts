/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lyricsRequestGeneration, requestLyrics } from "@equicordplugins/musicControls/lyricsRequest";
import { settings } from "@equicordplugins/musicControls/settings";
import { Provider, SyncedLyric } from "@equicordplugins/musicControls/spotify/lyrics/providers/types";

// stolen from src/plugins/translate/utils.ts

interface GoogleData {
    src: string;
    sentences: {
        // 🏳️‍⚧️
        trans: string;
        orig: string;
        src_translit?: string;
    }[];
}

async function googleTranslate(text: string, targetLang: string, romanize: boolean): Promise<GoogleData | null> {
    const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
        // see https://stackoverflow.com/a/29537590 for more params
        // holy shidd nvidia
        client: "gtx",
        // source language
        sl: "auto",
        // target language
        tl: targetLang,
        // what to return, t = translation probably
        dt: romanize ? "rm" : "t",
        // Send json object response instead of weird array
        dj: "1",
        source: "input",
        // query, duh
        q: text
    });

    return await requestLyrics(url).catch(() => null) as GoogleData | null;
}

async function processLyrics(
    lyrics: SyncedLyric[],
    targetLang: string,
    romanize: boolean
): Promise<SyncedLyric[] | null> {
    if (!lyrics) return null;

    const generation = lyricsRequestGeneration;
    const texts = [...new Set(lyrics.map(lyric => lyric.text).filter((text): text is string => !!text))];
    const translated = new Map<string, string>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, texts.length) }, async () => {
        while (next < texts.length && generation === lyricsRequestGeneration) {
            const text = texts[next++];
            const translation = await googleTranslate(text, targetLang, romanize);
            const sentence = translation?.sentences?.[0];
            const result = romanize ? sentence?.src_translit : sentence?.trans;
            if (result) translated.set(text, result);
        }
    }));
    if (generation !== lyricsRequestGeneration || !translated.size) return null;
    return lyrics.map(lyric => ({ ...lyric, text: lyric.text ? translated.get(lyric.text) ?? lyric.text : lyric.text }));
}

async function translateLyrics(lyrics: SyncedLyric[]) {
    return await processLyrics(lyrics, settings.store.translateTo, false);
}

async function romanizeLyrics(lyrics: SyncedLyric[]) {
    return await processLyrics(lyrics, "", true);
}

export const lyricsAlternativeFetchers = {
    [Provider.Translated]: translateLyrics,
    [Provider.Romanized]: romanizeLyrics
};
