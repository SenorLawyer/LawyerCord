/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@equicordplugins/translatePlus/settings";
import { isObject } from "@utils/misc";
import { escapeRegExp } from "@utils/text";

type Dictionary = Record<string, string>;

const SHAVIAN_DICTIONARY_URL = "https://raw.githubusercontent.com/ForkPrince/TranslatePlus/322199d5fdb1a9506591c9f4a2826338b5d67e38/shavian.json";
const SITELEN_DICTIONARY_URL = "https://raw.githubusercontent.com/ForkPrince/TranslatePlus/5ca152b134ea11433971f21b2ef8d556d4306717/sitelen-pona.json";

const TOKI_PONA_WORD_REGEX = /\b(?:leko|weka|pan|lete|linja|lipu|suli|nimi|akesi|misikeke|selo|ike|sijelo|sona|lili|pimeja|ante|jo|loje|telo|walo|kijetesantakalu|kasi|waso|wile|utala|lukin|sina|lape|ma|pilin|jasima|la|olin|pipi|meso|lawa|pi|pakala|oko|tan|ken|jaki|unpa|esun|seme|sitelen|len|kule|soko|open|ala|tenpo|lon|sinpin|pini|kokosila|mama|musi|monsi|mewika|taso|ona|mun|kiwen|tomo|mute|mi|nena|palisa|meli|laso|wawa|ale|kipisi|kulupu|ilo|lupa|nanpa|en|mu|jelo|kili|tonsi|moku|ni|kama|pu|poki|monsuta|sin|lasina|poka|soweli|sewi|elena|epiku|moli|pona|lanpan|alasa|anu|kute|uta|luka|suno|sama|awen|namako|suwi|noka|seli|mije|sike|jan|pali|tawa|inli|nasa|mani|wan|insa|nijon|nasin|kalama|ijo|toki|anpa|kala|kepeken|ko|kon|pana|tu|supa|kin|usawi|yupekosi)\b/gm;
const SITELEN_REGEX = /(?:󱤀|󱤁|󱤂|󱤃|󱤄|󱤅|󱤆|󱤇|󱤈|󱤉|󱤊|󱤋|󱤌|󱤍|󱤎|󱤏|󱤐|󱤑|󱤒|󱤓|󱤔|󱤕|󱤖|󱤗|󱤘|󱤙|󱤚|󱤛|󱤜|󱤝|󱤞|󱤟|󱤠|󱤡|󱤢|󱤣|󱤤|󱤥|󱤦|󱤧|󱤨|󱤩|󱤪|󱤫|󱤬|󱤭|󱤮|󱤯|󱤰|󱤱|󱤲|󱤳|󱤴|󱤵|󱤶|󱤷|󱤸|󱤹|󱤺|󱤻|󱤼|󱤽|󱤾|󱤿|󱥀|󱥁|󱥂|󱥃|󱥄|󱥅|󱥆|󱥇|󱥈|󱥉|󱥊|󱥋|󱥌|󱥍|󱥎|󱥏|󱥐|󱥑|󱥒|󱥓|󱥔|󱥕|󱥖|󱥗|󱥘|󱥙|󱥚|󱥛|󱥜|󱥝|󱥞|󱥟|󱥠|󱥡|󱥢|󱥣|󱥤|󱥥|󱥦|󱥧|󱥨|󱥩|󱥪|󱥫|󱥬|󱥭|󱥮|󱥯|󱥰|󱥱|󱥲|󱥳|󱥴|󱥵|󱥶|󱥷|󱦠|󱦡|󱦢|󱦣|󱥸|󱥹|󱥺|󱥻|󱥼|󱥽|󱥾|󱥿|󱦀|󱦁|󱦂|󱦃|󱦄|󱦅|󱦆|󱦇|󱦈|󱦐|󱦑|󱦒|󱦓|󱦔|󱦕|󱦖|󱦗|󱦘|󱦙|󱦚|󱦛|󱦜|󱦝)/m;
const SHAVIAN_REGEX = /[\u{10450}-\u{1047F}]+/u;

let shavianDictionaryPromise: Promise<Dictionary> | undefined;
let sitelenDictionaryPromise: Promise<{ dictionary: Dictionary; pattern: RegExp; }> | undefined;

function fetchDictionary(url: string): Promise<Dictionary> {
    return fetch(url).then(async response => {
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const dictionary: unknown = await response.json().catch(() => null);
        if (!isObject(dictionary) || Array.isArray(dictionary))
            throw new Error("TranslatePlus received an invalid dictionary.");
        const entries = Object.entries(dictionary);
        if (!entries.length || entries.some(([key, value]: [string, unknown]) => !key || typeof value !== "string"))
            throw new Error("TranslatePlus received an invalid dictionary.");
        return dictionary as Dictionary;
    });
}

function getShavianDictionary() {
    shavianDictionaryPromise ??= fetchDictionary(SHAVIAN_DICTIONARY_URL).catch(error => {
        shavianDictionaryPromise = undefined;
        throw error;
    });

    return shavianDictionaryPromise;
}

function getSitelenDictionary() {
    sitelenDictionaryPromise ??= fetchDictionary(SITELEN_DICTIONARY_URL)
        .then(dictionary => {
            const sorted = Object.keys(dictionary).sort((a, b) => b.length - a.length);
            const patternSource = sorted.map(escapeRegExp).join("|");

            const pattern = new RegExp(`(${patternSource})`, "g");

            return { dictionary, pattern };
        })
        .catch(error => {
            sitelenDictionaryPromise = undefined;
            throw error;
        });

    return sitelenDictionaryPromise;
}

function isTokiPona(text: string) {
    return (text.match(TOKI_PONA_WORD_REGEX) || []).length >= text.split(/\s+/).length * 0.5;
}

function isSitelen(text: string) {
    return SITELEN_REGEX.test(text);
}

function isShavian(text: string) {
    return SHAVIAN_REGEX.test(text);
}

async function translateShavian(message: string) {
    const dictionary = await getShavianDictionary();

    const punctuationMap = {
        '"': "\"",
        "«": "\"",
        "»": "\"",
        ",": ",",
        "!": "!",
        "?": "?",
        ".": ".",
        "(": "(",
        ")": ")",
        "/": "/",
        ";": ";",
        ":": ":"
    };

    let translated = "";
    const words = message.split(/\s+/);

    for (let word of words) {
        let punctuationBefore = "", punctuationAfter = "";

        if (word[0] in punctuationMap) {
            punctuationBefore = punctuationMap[word[0]];
            word = word.slice(1);
        }

        if (word[word.length - 1] in punctuationMap) {
            punctuationAfter = punctuationMap[word[word.length - 1]];
            word = word.slice(0, -1);
        }

        translated += punctuationBefore;

        if (Object.hasOwn(dictionary, word)) translated += dictionary[word];
        else translated += word;

        translated += punctuationAfter + " ";
    }

    return translated.trim();
}

async function translateSitelen(message: string) {
    let spacedMessage = "";
    for (const char of message) {
        if (spacedMessage) spacedMessage += " ";
        spacedMessage += char;
    }

    const { dictionary, pattern } = await getSitelenDictionary();

    const translate = spacedMessage.replace(pattern, match => dictionary[match]);

    return translate;
}

async function google(target: string, text: string) {
    if (!text) return { src: "", text: "" };
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?${new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", dj: "1", source: "input", q: text })}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const translate: unknown = await res.json().catch(() => null);
    if (!isObject(translate) || !("src" in translate) || typeof translate.src !== "string"
        || !("sentences" in translate) || !Array.isArray(translate.sentences))
        throw new Error("Google Translate returned an invalid response.");
    const translatedText = translate.sentences.map((sentence: unknown) => {
        if (!isObject(sentence) || !("trans" in sentence) || typeof sentence.trans !== "string")
            throw new Error("Google Translate returned an invalid response.");
        return sentence.trans;
    }).filter(Boolean).join("\n");

    return {
        src: translate.src,
        text: translatedText
    };
}

export async function translate(text: string) {
    const { target, toki, sitelen, shavian } = settings.store;

    if ((isTokiPona(text) || isSitelen(text)) && (toki || sitelen)) {
        if (isSitelen(text) && sitelen) text = await translateSitelen(text);

        const response = await fetch("https://aiapi.serversmp.xyz/toki", {
            method: "POST",
            redirect: "error",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text: text,
                src: "tl",
                target: "en"
            })
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Toki Pona translation request failed (${response.status}).`);
        }
        const translate: unknown = await response.json().catch(() => null);
        if (!isObject(translate) || !("translation" in translate) || !Array.isArray(translate.translation)
            || typeof translate.translation[0] !== "string")
            throw new Error("Toki Pona provider returned an invalid response.");

        return {
            src: "tp",
            text: target === "en" ? translate.translation[0] : (await google(target, translate.translation[0])).text
        };
    }
    if (isShavian(text) && shavian) {
        const translate = await translateShavian(text);
        return {
            src: "sh",
            text: target === "en" ? translate : (await google(target, translate)).text
        };
    }
    return google(target, text);
}
