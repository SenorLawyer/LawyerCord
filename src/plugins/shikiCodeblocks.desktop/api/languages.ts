/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
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

import { ILanguageRegistration } from "@vap/shiki";

import { SHIKI_REPO, SHIKI_REPO_COMMIT } from "./themes";

export const JSON_REPO = "Vencord/ShikiPluginAssets";
export const JSON_REPO_COMMIT = "75d69df9fdf596a31eef8b7f6f891231a6feab44";
export const JSON_URL = `https://cdn.jsdelivr.net/gh/${JSON_REPO}@${JSON_REPO_COMMIT}/grammars.json`;
export const shikiRepoGrammar = (name: string) => `https://cdn.jsdelivr.net/gh/${SHIKI_REPO}@${SHIKI_REPO_COMMIT}/packages/tm-grammars/grammars/${name}.json`;

export interface Language {
    name: string;
    id: string;
    devicon?: string;
    grammarUrl: string,
    grammar?: ILanguageRegistration["grammar"];
    scopeName: string;
    aliases?: string[];
    custom?: boolean;
}
export interface LanguageJson {
    name: string;
    displayName: string;
    scopeName: string;
    devicon?: string;
    aliases?: string[];
}

export const languages: Record<string, Language> = {};

export const loadLanguages = async (signal?: AbortSignal) => {
    if (Object.keys(languages).length > 0) return;
    const response = await fetch(JSON_URL, { signal });
    if (!response.ok) throw new Error("Could not load code languages.");
    const langsJson: LanguageJson[] = await response.json();
    signal?.throwIfAborted();
    Object.assign(languages, Object.fromEntries(langsJson.map(lang => {
        const { name, displayName, ...rest } = lang;
        return [name, { ...rest, id: name, name: displayName, grammarUrl: shikiRepoGrammar(name) }];
    })));
};

export const getGrammar = async (lang: Language, signal?: AbortSignal): Promise<NonNullable<ILanguageRegistration["grammar"]>> => {
    if (lang.grammar) return lang.grammar;
    const response = await fetch(lang.grammarUrl, { signal });
    if (!response.ok) throw new Error("Could not load the code language.");
    const grammar: NonNullable<ILanguageRegistration["grammar"]> = await response.json();
    signal?.throwIfAborted();
    lang.grammar = grammar;
    return grammar;
};

const aliasCache = new Map<string, Language>();
export function resolveLang(idOrAlias: string) {
    if (Object.prototype.hasOwnProperty.call(languages, idOrAlias)) return languages[idOrAlias];
    const cached = aliasCache.get(idOrAlias);
    if (cached) return cached;

    const lang = Object.values(languages).find(lang => lang.aliases?.includes(idOrAlias));

    if (!lang) return null;

    aliasCache.set(idOrAlias, lang);
    return lang;
}
