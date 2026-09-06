/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@equicordplugins/translatePlus/settings";
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
    return fetch(url).then(response => {
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        return response.json();
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

        if (word in dictionary) translated += dictionary[word];
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
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?${new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", dj: "1", source: "input", q: text })}`);
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const translate = await res.json();
        let translatedText = "";

        if (translate.sentences) {
            for (const sentence of translate.sentences) {
                if (!sentence.trans) continue;
                if (translatedText) translatedText += "\n";
                translatedText += sentence.trans;
            }
        }

        return {
            src: translate.src,
            text: translatedText
        };
    } catch (error) {
        console.error("[TranslatePlus] Google Translate request failed:", error);
        return { src: "en", text: "Translation failed due to an error." };
    }
}

export async function translate(text: string): Promise<any> {
    const { target, toki, sitelen, shavian } = settings.store;

    const output = { src: "", text: "" };

    if ((isTokiPona(text) || isSitelen(text)) && (toki || sitelen)) {
        if (isSitelen(text) && sitelen) text = await translateSitelen(text);

        const translate = await (await fetch("https://aiapi.serversmp.xyz/toki", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                text: text,
                src: "tl",
                target: "en"
            })
        })).json();

        output.src = "tp";
        output.text = target === "en" ? translate.translation[0] : (await google(target, translate.translation[0])).text;
    } else if (isShavian(text) && shavian) {
        const translate = await translateShavian(text);

        output.src = "sh";
        output.text = target === "en" ? translate : (await google(target, translate)).text;
    } else {
        const translate = await google(target, text);

        output.src = translate.src;
        output.text = translate.text;
    }

    return output;
}
