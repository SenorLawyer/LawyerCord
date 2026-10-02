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

function fixture() {
    let themeRequests = 0;
    let highlights = 0;
    let visible = true;
    let codeComponent: unknown;
    const keys: (readonly string[])[] = [];
    const jobs: unknown[][] = [];
    const store = { tryHljs: false, useDevIcon: "DISABLED", bgOpacity: 100, theme: "new-theme", customTheme: "" };
    const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
        if (type === codeComponent && typeof type === "function") return type(props);
        return { type, props, children };
    },
        useState: (value: unknown) => [value, () => {}], useEffect() {} };
    const modules: Record<string, unknown> = {
        "@components/ErrorBoundary": { __esModule: true, default: (props: unknown) => props },
        "@plugins/shikiCodeblocks.desktop/api/languages": { resolveLang: () => ({ id: "typescript", name: "TypeScript" }) },
        "@plugins/shikiCodeblocks.desktop/api/shiki": { shiki: { currentThemeUrl: "old-theme", setTheme() { themeRequests++; } } },
        "@plugins/shikiCodeblocks.desktop/settings": { settings: { use: (selected: readonly string[]) => { keys.push(selected); return store; } } },
        "@plugins/shikiCodeblocks.desktop/hooks/useTheme": { useTheme: () => ({ id: "old-theme", theme: { fg: "#fff", colors: { "editor.background": "#000" } } }) },
        "@plugins/shikiCodeblocks.desktop/utils/color": { hex2Rgb: () => [0, 0, 0] },
        "@plugins/shikiCodeblocks.desktop/utils/misc": { cl: () => "code", hljs: { getLanguage: () => ({ name: "TypeScript" }), highlight: (content: string) => { highlights++; return { value: content }; } }, shouldUseHljs: ({ tryHljs }: { tryHljs: boolean; }) => tryHljs },
        "@utils/react": { useIntersection: () => [null, visible], useAwaiter: (_factory: unknown, options: { deps: unknown[]; }) => { jobs.push(options.deps); return [null]; } },
        "@webpack/common": { React, useEffect: React.useEffect, useMemo: (factory: () => unknown) => factory() },
        "./ButtonRow": {}, "./Code": {}, "./Header": {}
    };
    function load(path: string): Record<string, unknown> {
        const { outputText } = transpileModule(readFileSync(path, "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
        });
        return runInNewContext(`${outputText}\nexports;`, { exports: {}, React, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    }
    const sourcePath = process.env.AUDIT_SHIKI_HIGHLIGHTER_SOURCE ?? "src/plugins/shikiCodeblocks.desktop/components/Highlighter.tsx";
    if (readFileSync(sourcePath, "utf8").includes("hooks/useShikiSettings")) {
        modules["@plugins/shikiCodeblocks.desktop/hooks/useShikiSettings"] = load(process.env.AUDIT_SHIKI_HOOK_SOURCE ?? "src/plugins/shikiCodeblocks.desktop/hooks/useShikiSettings.ts");
    }
    const code = load("src/plugins/shikiCodeblocks.desktop/components/Code.tsx");
    codeComponent = code.Code;
    modules["./Code"] = code;
    const highlighter = load(sourcePath).Highlighter;
    assert.equal(typeof highlighter, "function");
    return { store, keys, jobs,
        setVisible(value: boolean) { visible = value; },
        highlights: () => highlights,
        render: () => (highlighter as (props: object) => unknown)({ lang: "typescript", content: "const n = 1;", isPreview: false }),
        requests: () => themeRequests };
}

test("Mounting a hundred Shiki blocks never submits theme changes from rendering", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.render();
    assert.equal(f.requests(), 0);
});

test("Shiki blocks reuse one settings key list and subscribe only to displayed options", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.render();
    assert.deepEqual(Array.from(f.keys[0]), ["tryHljs", "useDevIcon", "bgOpacity"]);
    assert.ok(f.keys.every(keys => keys === f.keys[0]));
});

test("Changing the highlighter preference invalidates token work with unchanged code and theme", () => {
    const f = fixture();
    f.render();
    const previous = f.jobs[0];
    f.store.tryHljs = true;
    f.render();
    assert.notDeepEqual(Array.from(f.jobs[1]), Array.from(previous));
});


test("Hidden Shiki fallback blocks defer highlight.js until their first visible render", () => {
    const f = fixture();
    f.store.tryHljs = true;
    f.setVisible(false);
    for (let i = 0; i < 100; i++) f.render();
    assert.equal(f.highlights(), 0);
    f.setVisible(true);
    f.render();
    assert.equal(f.highlights(), 1);
});
