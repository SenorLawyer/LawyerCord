/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync("src/components/settings/tabs/themes/index.tsx", "utf8").replace("    const allThemes:", "    capture({ refreshOnlineThemes, refreshOnlineTheme });\n    const allThemes:") + "\nexport { ThemesTab };";
const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
function fixture() {
    const effects: (() => (() => void) | undefined)[] = [];
    const requests: { signal?: AbortSignal; resolve(value: object): void; }[] = [];
    let callbacks: { refreshOnlineThemes(): Promise<void>; refreshOnlineTheme(link: string): Promise<void>; };
    let parses = 0;
    let updates = 0;
    const settings = { themeLinks: ["https://example.com/theme.css"], enabledThemeLinks: [], enabledThemes: [], pinnedThemes: [], themeNames: {}, themeActivationModes: {} };
    const common = {
        Settings: settings, useSettings: () => settings, wrapTab: (component: unknown) => component, classNameFactory: () => () => "", classes: () => "", Margins: {},
        React: { createElement: () => null }, useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
        useState: (value: unknown) => [value, () => updates++], useRef: (value: unknown) => ({ current: value }),
        getThemeInfo: () => { parses++; return {}; }, Toasts: { Type: {} }, showToast() {}
    };
    const api = runInNewContext(`${code}\nexports;`, {
        exports: {}, require: () => common, IS_USERSCRIPT: false, IS_WEB: false, AbortController, AbortSignal,
        VencordNative: { themes: { getThemesList: async () => [] } },
        capture(value: typeof callbacks) { callbacks = value; },
        fetch(_url: string, options?: { signal?: AbortSignal; }) { return new Promise(resolve => { requests.push({ signal: options?.signal, resolve }); }); }
    }) as { ThemesTab(): void; };
    api.ThemesTab();
    const cleanups = effects.map(effect => effect());
    return { requests, settings, callbacks: () => callbacks, parses: () => parses, updates: () => updates, unmount() { cleanups.forEach(cleanup => cleanup?.()); } };
}

test("Theme tab navigation aborts pending online reads over 100 mounts", async () => {
    for (let i = 0; i < 100; i++) {
        const f = fixture(); f.unmount();
        assert.equal(f.requests[0].signal?.aborted, true);
        f.requests[0].resolve({ ok: true, text: async () => "@dark body {}" });
        await setImmediate();
        assert.equal(f.parses(), 0);
        assert.deepEqual(f.settings.themeActivationModes, {});
    }
});

test("Replacing theme refreshes discards deleted metadata and bounds pending batches", async () => {
    const f = fixture();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) pending.push(f.callbacks().refreshOnlineThemes());
    assert.equal(f.requests.filter(request => !request.signal?.aborted).length, 1);
    f.settings.themeLinks = [];
    pending.push(f.callbacks().refreshOnlineThemes());
    for (const request of f.requests) request.resolve({ ok: true, text: async () => "@dark body {}" });
    await Promise.all(pending);
    assert.equal(f.parses(), 0);
    assert.deepEqual(f.settings.themeActivationModes, {});
    f.unmount();
});

test("Individual theme refresh replacement and tab cleanup cancel stale metadata publication", async () => {
    const f = fixture();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) pending.push(f.callbacks().refreshOnlineTheme(f.settings.themeLinks[0]));
    assert.equal(f.requests.slice(1).filter(request => !request.signal?.aborted).length, 1);
    f.unmount();
    assert.ok(f.requests.every(request => request.signal?.aborted));
    for (const request of f.requests) request.resolve({ ok: true, text: async () => "@dark body {}" });
    await Promise.all(pending);
    assert.equal(f.parses(), 0);
});
