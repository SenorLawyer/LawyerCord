/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync("src/api/Themes.ts", "utf8");

function fixture() {
    const settings = {
        enabledThemeLinks: [] as string[], enabledThemes: [] as string[], useQuickCss: true,
        themeActivationModes: {} as Record<string, "always" | "light" | "dark">
    };
    const styles = new Map<string, { textContent: string; disabled: boolean; }>();
    const blobs = new Map<string, Blob>();
    const errors: unknown[][] = [];
    const quickCss = Promise.withResolvers<string>();
    const listeners: ((css: string) => void)[] = [];
    const themeData = new Map<string, Promise<string | undefined>>();
    let urlCount = 0;
    const mocks: Record<string, object> = {
        "@api/Settings": { Settings: settings },
        "@utils/css": {
            createAndAppendStyle(id: string) {
                let text = "";
                const style = {
                    disabled: false,
                    get textContent() { return text; },
                    set textContent(value: string) { text = value; this.disabled = false; }
                };
                styles.set(id, style);
                return style;
            }
        },
        "@utils/guards": { isNonNullish: (value: unknown) => value != null },
        "@utils/Logger": { Logger: class { error(...args: unknown[]) { errors.push(args); } } },
        "@webpack/common": {},
        "@webpack/common/stores": { ThemeStore: { theme: "dark" } },
        "./Styles": {}
    };
    const api = {} as { initThemes(): Promise<void>; toggle(enabled: boolean): Promise<void>; };
    runInNewContext(transpileModule(source + "\nexport { initThemes, toggle };", {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText, {
        exports: api, IS_WEB: true, IS_USERSCRIPT: false, Blob,
        document: { addEventListener() { } },
        URL: {
            createObjectURL(blob: Blob) { const url = `blob:fixture-${++urlCount}`; blobs.set(url, blob); return url; },
            revokeObjectURL(url: string) { blobs.delete(url); }
        },
        VencordNative: {
            themes: { getThemeData: (name: string) => themeData.get(name) ?? Promise.resolve(undefined) },
            quickCss: { get: () => quickCss.promise, addChangeListener: (listener: (css: string) => void) => listeners.push(listener) }
        },
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { api, settings, styles, blobs, errors, themeData, quickCss, listeners };
}

test("overlapping theme loads preserve current URLs and only commit the latest selection", async () => {
    const { api, settings, styles, blobs, themeData } = fixture();
    settings.enabledThemes = ["initial"];
    themeData.set("initial", Promise.resolve("initial {}"));
    await api.initThemes();
    const previousUrl = [...blobs.keys()][0];
    const slow = Promise.withResolvers<string>();
    themeData.set("slow", slow.promise);
    settings.enabledThemes = ["slow"];
    const obsolete = api.initThemes();
    assert.ok(blobs.has(previousUrl), "active styles survive while replacement data is loading");
    settings.enabledThemes = ["latest"];
    themeData.set("latest", Promise.resolve("latest {}"));
    await api.initThemes();
    const currentCss = styles.get("vencord-themes")?.textContent;
    assert.equal(blobs.has(previousUrl), false);
    slow.resolve("obsolete {}");
    await obsolete;
    assert.equal(styles.get("vencord-themes")?.textContent, currentCss);
    assert.equal(blobs.size, 1);
    assert.equal(await [...blobs.values()][0].text(), "latest {}");
    settings.enabledThemes = [];
    await api.initThemes();
    assert.equal(blobs.size, 0);
});

test("failed theme reads retain the active style and do not leak partial results", async () => {
    const { api, settings, styles, blobs, errors, themeData } = fixture();
    settings.enabledThemes = ["initial"];
    themeData.set("initial", Promise.resolve("initial {}"));
    await api.initThemes();
    const currentCss = styles.get("vencord-themes")?.textContent;
    const failure = Promise.withResolvers<string>();
    settings.enabledThemes = ["good", "bad"];
    themeData.set("good", Promise.resolve("new {}"));
    themeData.set("bad", failure.promise);
    const pending = api.initThemes();
    failure.reject(new Error("Read failed"));
    await pending;
    assert.equal(styles.get("vencord-themes")?.textContent, currentCss);
    assert.equal(blobs.size, 1);
    assert.equal(await [...blobs.values()][0].text(), "initial {}");
    assert.equal(errors.length, 1);
});
