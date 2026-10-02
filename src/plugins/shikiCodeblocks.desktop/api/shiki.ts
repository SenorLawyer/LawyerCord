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

import { dispatchTheme } from "@plugins/shikiCodeblocks.desktop/hooks/useTheme";
import type { ShikiSpec } from "@plugins/shikiCodeblocks.desktop/types";
import { shikiOnigasmSrc, shikiWorkerSrc } from "@utils/dependencies";
import { WorkerClient } from "@vap/core/ipc";
import type { IShikiTheme, IThemedToken } from "@vap/shiki";

import { getGrammar, languages, loadLanguages, resolveLang } from "./languages";
import { themes } from "./themes";

const defaultTheme = themes.DarkPlus;

interface WorkerSession {
    controller: AbortController;
    client: WorkerClient<ShikiSpec> | null;
    ready?: Promise<WorkerClient<ShikiSpec>>;
    languages: Map<string, Promise<void>>;
    themes: Map<string, Promise<void>>;
    themeRequest: number;
}

let session: WorkerSession | undefined;

function waitForWork<T>(owner: WorkerSession, factory: () => Promise<T>): Promise<T> {
    const { signal } = owner.controller;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            owner.controller.abort(new Error("The code highlighter took too long to respond."));
            if (session === owner) shiki.destroy();
        }, shiki.timeoutMs);
        const abort = () => {
            clearTimeout(timeout);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
            signal.throwIfAborted();
            return factory();
        }).then(value => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            if (signal.aborted) reject(signal.reason);
            else resolve(value);
        }, error => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}

async function readySession() {
    const owner = session;
    if (!owner?.ready) throw new Error("The code highlighter is stopped.");
    const client = await owner.ready;
    owner.controller.signal.throwIfAborted();
    return { owner, client };
}

async function setTheme(owner: WorkerSession, client: WorkerClient<ShikiSpec>, themeUrl: string, request?: number) {
    const { themeData } = await waitForWork(owner, () => client.run("getTheme", { theme: themeUrl }));
    owner.controller.signal.throwIfAborted();
    if (request !== undefined && owner.themeRequest !== request) return;
    const theme: IShikiTheme = JSON.parse(themeData);
    shiki.currentThemeUrl = themeUrl;
    shiki.currentTheme = theme;
    dispatchTheme({ id: themeUrl, theme });
}

function loadTheme(owner: WorkerSession, client: WorkerClient<ShikiSpec>, themeUrl: string) {
    let work = owner.themes.get(themeUrl);
    if (!work) {
        work = waitForWork(owner, () => client.run("loadTheme", { theme: themeUrl })).catch(error => {
            owner.themes.delete(themeUrl);
            throw error;
        });
        owner.themes.set(themeUrl, work);
    }
    return work;
}

function loadLang(owner: WorkerSession, client: WorkerClient<ShikiSpec>, langId: string) {
    const lang = resolveLang(langId);
    if (!lang) return;
    let work = owner.languages.get(lang.id);
    if (!work) {
        work = (async () => {
            const grammar = lang.grammar ?? await waitForWork(owner, () => getGrammar(lang, owner.controller.signal));
            await waitForWork(owner, () => client.run("loadLanguage", { lang: { ...lang, grammar } }));
        })().catch(error => {
            owner.languages.delete(lang.id);
            throw error;
        });
        owner.languages.set(lang.id, work);
    }
    return work;
}

export const shiki = {
    get client() { return session?.client ?? null; },
    currentTheme: null as IShikiTheme | null,
    currentThemeUrl: null as string | null,
    timeoutMs: 10000,
    languages,
    themes,
    init: async (initThemeUrl: string | undefined) => {
        if (session?.ready) return void await session.ready;
        const owner: WorkerSession = {
            controller: new AbortController(), client: null,
            languages: new Map(), themes: new Map(), themeRequest: 0
        };
        session = owner;
        const timeout = setTimeout(() => owner.controller.abort(new Error("The code highlighter took too long to start.")), shiki.timeoutMs);
        owner.ready = (async () => {
            /** https://stackoverflow.com/q/58098143 */
            const workerBlob = await waitForWork(owner, () => fetch(shikiWorkerSrc, { signal: owner.controller.signal }).then(res => {
                if (!res.ok) throw new Error("Could not load the code highlighter.");
                return res.blob();
            }));
            owner.controller.signal.throwIfAborted();
            const client = owner.client = new WorkerClient<ShikiSpec>("shiki-client", "shiki-host", workerBlob, { name: "ShikiWorker" });
            await waitForWork(owner, () => client.init());
            await waitForWork(owner, () => loadLanguages(owner.controller.signal));
            await waitForWork(owner, () => client.run("setOnigasm", { wasm: shikiOnigasmSrc }));
            const themeUrl = initThemeUrl || defaultTheme;
            await waitForWork(owner, () => client.run("setHighlighter", { theme: themeUrl, langs: [] }));
            owner.themes.set(themeUrl, Promise.resolve());
            await setTheme(owner, client, themeUrl);
            return client;
        })().catch(error => {
            if (session === owner) shiki.destroy();
            throw error;
        }).finally(() => clearTimeout(timeout));
        await owner.ready;
    },
    loadTheme: async (themeUrl: string) => {
        const { owner, client } = await readySession();
        await loadTheme(owner, client, themeUrl);
    },
    setTheme: async (themeUrl: string) => {
        const requestedSession = session;
        if (!requestedSession) return;
        const request = ++requestedSession.themeRequest;
        const { owner, client } = await readySession();
        themeUrl ||= defaultTheme;
        await loadTheme(owner, client, themeUrl);
        await setTheme(owner, client, themeUrl, request);
    },
    loadLang: async (langId: string) => {
        const { owner, client } = await readySession();
        await loadLang(owner, client, langId);
    },
    tokenizeCode: async (code: string, langId: string): Promise<IThemedToken[][]> => {
        const { owner, client } = await readySession();
        const lang = resolveLang(langId);
        if (!lang) return [];
        const theme = shiki.currentThemeUrl ?? defaultTheme;
        await loadLang(owner, client, lang.id);
        const tokens = await waitForWork(owner, () => client.run("codeToThemedTokens", { code, lang: langId, theme }));
        owner.controller.signal.throwIfAborted();
        if (shiki.currentThemeUrl !== theme) throw new Error("The code theme changed.");
        return tokens;
    },
    destroy() {
        const owner = session;
        session = undefined;
        owner?.controller.abort(new Error("The code highlighter stopped."));
        owner?.client?.destroy();
        owner?.languages.clear();
        owner?.themes.clear();
        shiki.currentTheme = null;
        shiki.currentThemeUrl = null;
        dispatchTheme({ id: null, theme: null });
    }
};
