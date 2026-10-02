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

test("GIF font resources release on last modal close and reject late font completion", async () => {
    const fonts = new Set<unknown>();
    const urls = new Set<string>();
    let urlId = 0;
    let release: (() => void) | undefined;
    let gated = false;
    const code = transpileModule(readFileSync("src/equicordplugins/gifMaker/fonts.ts", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const api = runInNewContext(code + "\nexports;", {
        exports: {}, AbortController,
        fetch: async () => ({ ok: true, text: async () => "font", blob: async () => new Blob(["font"]) }),
        URL: { createObjectURL: () => { const url = String(++urlId); urls.add(url); return url; }, revokeObjectURL: (url: string) => urls.delete(url) },
        CSSRule: { FONT_FACE_RULE: 5 },
        CSSStyleSheet: class { cssRules = [{ type: 5, style: { getPropertyValue: (key: string) => key === "src" ? "url(https://fonts.gstatic.com/font.woff2)" : "" } }]; replaceSync() {} },
        FontFace: class { async load() { if (gated) await new Promise<void>(resolve => { release = resolve; }); return this; } },
        document: { fonts },
        require: () => ({ Logger: class { warn() {} } })
    });
    const close = api.retainFonts?.() ?? (() => api.clearFonts?.());
    const closeOther = api.retainFonts?.() ?? (() => {});
    for (let i = 0; i < 100; i++) await api.loadGoogleFont(`Font ${i}`);
    assert.equal(fonts.size, 100);
    close();
    assert.equal(fonts.size, 100);
    closeOther();
    assert.equal(fonts.size, 0);
    assert.equal(urls.size, 0);
    api.retainFonts?.();
    gated = true;
    const pending = api.loadGoogleFont("Late");
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    api.clearFonts?.();
    release?.();
    await pending;
    assert.equal(fonts.size, 0);
    assert.equal(urls.size, 0);
});
