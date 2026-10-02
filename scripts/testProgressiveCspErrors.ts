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

test("Repeated blocked resources do not wake subscribers and unique blocked URLs stay bounded", () => {
    let notify: ((event: { effectiveDirective: string; blockedURI: string; }) => void) | undefined;
    let updates = 0;
    const cleanups: (() => void)[] = [];
    const { outputText } = transpileModule(readFileSync("src/utils/cspViolations.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, document: { addEventListener: (_event: string, handler: typeof notify) => { notify = handler; } },
        require: (id: string) => id === "@webpack/common"
            ? { useLayoutEffect: (effect: () => () => void) => cleanups.push(effect()) }
            : { useForceUpdater: () => () => updates++ }
    }) as { CspBlockedUrls: Set<string>; useCspErrors(): readonly string[]; };
    assert.ok(notify);
    api.useCspErrors();
    for (let count = 0; count < 10000; count++) notify({ effectiveDirective: "img-src", blockedURI: "https://blocked.example/repeat.png" });
    assert.equal(updates, 1);
    for (let count = 0; count < 10000; count++) notify({ effectiveDirective: "img-src", blockedURI: `https://blocked.example/${count}.png` });
    assert.ok(api.CspBlockedUrls.size <= 256, `Retained ${api.CspBlockedUrls.size} blocked URLs`);
    assert.ok(api.CspBlockedUrls.has("https://blocked.example/9999.png"));
    assert.ok(!api.CspBlockedUrls.has("https://blocked.example/repeat.png"));
    cleanups[0]();
    const before = updates;
    notify({ effectiveDirective: "img-src", blockedURI: "https://blocked.example/after-unmount.png" });
    assert.equal(updates, before);
});
