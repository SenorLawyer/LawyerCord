/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
}

function fixture() {
    const calls: { worker: number; name: string; input: Record<string, string>; }[] = [];
    const workers: Worker[] = [];
    const themes: { id: string | null; }[] = [];
    let fetchWork: Promise<unknown> | undefined;
    let initWork: Promise<void> | undefined;
    let work: (name: string, input: Record<string, string>) => Promise<unknown> | undefined = () => undefined;
    class Worker {
        destroyed = false;
        id = workers.push(this);
        init() { return initWork ?? Promise.resolve(); }
        run(name: string, input: Record<string, string>) {
            calls.push({ worker: this.id, name, input });
            return work(name, input) ?? Promise.resolve(name === "getTheme" ? { themeData: JSON.stringify({ name: input.theme }) } : name === "codeToThemedTokens" ? [[{ content: input.code }]] : undefined);
        }
        destroy() { this.destroyed = true; }
    }
    const modules: Record<string, unknown> = {
        "@plugins/shikiCodeblocks.desktop/hooks/useTheme": { dispatchTheme: (theme: { id: string | null; }) => themes.push(theme) },
        "@utils/dependencies": { shikiWorkerSrc: "worker", shikiOnigasmSrc: "wasm" },
        "@vap/core/ipc": { WorkerClient: Worker },
        "./languages": { languages: {}, loadLanguages: async () => {}, resolveLang: (id: string) => ({ id: id === "ts" ? "typescript" : id, grammar: {} }), getGrammar: async () => ({}) },
        "./themes": { themes: { DarkPlus: "default" } }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_SHIKI_WORKER_SOURCE ?? "src/plugins/shikiCodeblocks.desktop/api/shiki.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const { shiki } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, AbortController, setTimeout, clearTimeout,
        fetch: () => fetchWork ?? Promise.resolve({ ok: true, blob: async () => ({}) }),
        require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }
    }) as { shiki: {
        init(theme: string): Promise<void>; destroy(): void; loadLang(lang: string): Promise<void>; loadTheme(theme: string): Promise<void>;
        setTheme(theme: string): Promise<void>; tokenizeCode(code: string, lang: string): Promise<unknown>; currentThemeUrl: string | null; timeoutMs: number;
    }; };
    return { shiki, calls, workers, themes, setFetch: (p: Promise<unknown>) => fetchWork = p, setInit: (p: Promise<void>) => initWork = p,
        setWork: (fn: typeof work) => work = fn };
}

test("Concurrent blocks share grammar and theme worker loads, including language aliases", async () => {
    const f = fixture();
    await f.shiki.init("default");
    await Promise.all(Array.from({ length: 100 }, (_, i) => f.shiki.loadLang(i % 2 ? "typescript" : "ts")));
    await Promise.all(Array.from({ length: 100 }, () => f.shiki.loadTheme("other")));
    assert.equal(f.calls.filter(c => c.name === "loadLanguage").length, 1);
    assert.equal(f.calls.filter(c => c.name === "loadTheme").length, 1);
    f.shiki.destroy();
});

test("Failed worker loads can be retried", async () => {
    const f = fixture();
    await f.shiki.init("default");
    f.setWork(name => name === "loadLanguage" || name === "loadTheme" ? Promise.reject(new Error("Load failed")) : undefined);
    await assert.rejects(f.shiki.loadLang("ts"));
    await assert.rejects(f.shiki.loadTheme("other"));
    f.setWork(() => undefined);
    await f.shiki.loadLang("ts");
    await f.shiki.loadTheme("other");
    assert.equal(f.calls.filter(c => c.name === "loadLanguage").length, 2);
    assert.equal(f.calls.filter(c => c.name === "loadTheme").length, 2);
    f.shiki.destroy();
});

test("A failed theme change during startup retains the initialized theme", async () => {
    const f = fixture();
    const handshake = deferred<void>();
    f.setInit(handshake.promise);
    const init = f.shiki.init("initial");
    await flush();
    f.setWork(name => name === "loadTheme" ? Promise.reject(new Error("Load failed")) : undefined);
    const changed = assert.rejects(f.shiki.setTheme("broken"));
    handshake.resolve();
    await Promise.all([init, changed]);
    assert.equal(f.shiki.currentThemeUrl, "initial");
    assert.equal(f.themes.at(-1)?.id, "initial");
    f.shiki.destroy();
});

test("Stopping while the worker source loads cannot recreate a worker", async () => {
    const f = fixture();
    const fetch = deferred<unknown>();
    f.setFetch(fetch.promise);
    const init = f.shiki.init("default").catch(() => {});
    f.shiki.destroy();
    fetch.resolve({ ok: true, blob: async () => ({}) });
    await init;
    assert.equal(f.workers.length, 0);
});

test("Stopping an unanswered worker handshake settles initialization", async () => {
    const f = fixture();
    const handshake = deferred<void>();
    f.setInit(handshake.promise);
    const init = f.shiki.init("default").catch(() => {});
    await flush();
    f.shiki.destroy();
    const result = await Promise.race([init.then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("pending"), 50))]);
    handshake.resolve();
    await init;
    assert.equal(result, "settled");
});

test("Restart loads grammars and tokens into the replacement worker", async () => {
    const f = fixture();
    await f.shiki.init("default");
    await f.shiki.tokenizeCode("old", "ts");
    f.shiki.destroy();
    await f.shiki.init("default");
    await f.shiki.tokenizeCode("new", "ts");
    const jobs = f.calls.filter(c => c.name === "codeToThemedTokens");
    assert.equal(jobs[1].worker, 2);
    assert.equal(f.calls.filter(c => c.name === "loadLanguage" && c.worker === 2).length, 1);
    f.shiki.destroy();
});

test("Theme data and URL commit together and the latest requested theme wins", async () => {
    const f = fixture();
    await f.shiki.init("default");
    const old = deferred<unknown>();
    f.setWork((name, input) => name === "getTheme" && input.theme === "older" ? old.promise : undefined);
    const older = f.shiki.setTheme("older");
    await flush();
    assert.equal(f.shiki.currentThemeUrl, "default");
    await f.shiki.setTheme("newer");
    old.resolve({ themeData: JSON.stringify({ name: "older" }) });
    await older;
    assert.equal(f.shiki.currentThemeUrl, "newer");
    assert.equal(f.themes.at(-1)?.id, "newer");
    f.shiki.destroy();
});

test("Tokens completing after a theme change are discarded", async () => {
    const f = fixture();
    await f.shiki.init("default");
    const tokens = deferred<unknown>();
    f.setWork(name => name === "codeToThemedTokens" ? tokens.promise : undefined);
    const job = f.shiki.tokenizeCode("code", "ts");
    const result = job.then(value => value, () => null);
    await flush();
    await f.shiki.setTheme("newer");
    tokens.resolve([[{ content: "stale" }]]);
    assert.equal(await result, null);
    f.shiki.destroy();
});


test("Repeated initialization shares one worker", async () => {
    const f = fixture();
    await Promise.all([f.shiki.init("default"), f.shiki.init("default")]);
    assert.equal(f.workers.length, 1);
    f.shiki.destroy();
});

test("Failed initialization destroys its worker and permits a fresh start", async () => {
    const f = fixture();
    f.setWork(name => name === "setHighlighter" ? Promise.reject(new Error("Load failed")) : undefined);
    await assert.rejects(f.shiki.init("default"));
    assert.equal(f.workers[0].destroyed, true);
    f.setWork(() => undefined);
    await f.shiki.init("default");
    await f.shiki.tokenizeCode("new", "ts");
    assert.equal(f.calls.at(-1)?.worker, 2);
    f.shiki.destroy();
});

test("Unanswered initialization times out and destroys its worker", async () => {
    const f = fixture();
    f.shiki.timeoutMs = 10;
    f.setInit(deferred<void>().promise);
    await assert.rejects(f.shiki.init("default"), /too long/);
    assert.equal(f.workers[0].destroyed, true);
});

test("Unanswered token work expires and releases the worker", async () => {
    const f = fixture();
    await f.shiki.init("default");
    f.shiki.timeoutMs = 10;
    const tokens = deferred<unknown>();
    f.setWork(name => name === "codeToThemedTokens" ? tokens.promise : undefined);
    const tokenized = f.shiki.tokenizeCode("code", "ts").then(() => "resolved", () => "rejected");
    const result = await Promise.race([tokenized, new Promise(resolve => setTimeout(() => resolve("pending"), 100))]);
    tokens.resolve([]);
    await tokenized;
    assert.equal(result, "rejected");
    assert.equal(f.workers[0].destroyed, true);
});

test("Stopping pending language work prevents any later token request", async () => {
    const f = fixture();
    await f.shiki.init("default");
    const language = deferred<unknown>();
    f.setWork(name => name === "loadLanguage" ? language.promise : undefined);
    const result = f.shiki.tokenizeCode("old", "ts").catch(() => null);
    await flush();
    f.shiki.destroy();
    await f.shiki.init("default");
    language.resolve(undefined);
    assert.equal(await result, null);
    assert.equal(f.calls.filter(c => c.name === "codeToThemedTokens").length, 0);
    f.shiki.destroy();
});


test("Highlight.js runs once for unchanged code across display updates", () => {
    let highlights = 0;
    let cached: { dependencies: unknown[]; value: unknown; } | undefined;
    const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
    const modules: Record<string, unknown> = {
        "@plugins/shikiCodeblocks.desktop/utils/misc": { cl: () => "code", hljs: {
            getLanguage: () => ({}), highlight: (content: string) => { highlights++; return { value: content }; }
        } },
        "@webpack/common": { useMemo: (factory: () => unknown, dependencies: unknown[]) => {
            if (!cached || dependencies.some((value, index) => value !== cached?.dependencies[index]))
                cached = { dependencies, value: factory() };
            return cached.value;
        } }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_SHIKI_CODE_SOURCE ?? "src/plugins/shikiCodeblocks.desktop/components/Code.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { Code } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, React, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }
    }) as { Code: (props: object) => unknown; };
    const props = { useHljs: true, lang: "ts", content: "let x = 1", tokens: null, theme: { plainColor: "white" } };
    for (let i = 0; i < 100; i++) Code({ ...props, theme: { plainColor: i % 2 ? "white" : "black" } });
    assert.equal(highlights, 1);
    Code({ ...props, content: "let x = 2" });
    assert.equal(highlights, 2);
});

test("Theme subscriptions catch changes between render and effect without mutating rendered snapshots", () => {
    const effects: (() => (() => void))[] = [];
    const updates: unknown[] = [];
    const React = {
        useState: (initial: unknown) => [initial, (state: unknown) => updates.push(state)],
        useEffect: (effect: () => (() => void)) => effects.push(effect)
    };
    const { outputText } = transpileModule(readFileSync("src/plugins/shikiCodeblocks.desktop/hooks/useTheme.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const theme = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: () => ({ React })
    }) as { useTheme(): { id: string | null; }; dispatchTheme(state: { id: string | null; theme: object | null; }): void; };
    const rendered = theme.useTheme();
    theme.dispatchTheme({ id: "loaded", theme: {} });
    const cleanup = effects[0]();
    assert.equal(rendered.id, null);
    assert.equal((updates.at(-1) as { id: string; }).id, "loaded");
    cleanup();
    const count = updates.length;
    theme.dispatchTheme({ id: "other", theme: {} });
    assert.equal(updates.length, count);
});
