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
    const store = { channelIds: ["tracked"], buckets: { "2001-01-01:12": 10000 } as Record<string, number> };
    const timers = new Set<() => void>();
    let writes = 0;
    const settings = { store: new Proxy(store, { set(target, key, value) { writes++; Reflect.set(target, key, value); return true; } }) };
    const mocks: Record<string, unknown> = {
        "./styles.css": {}, "@api/ContextMenu": {},
        "@api/Settings": { definePluginSettings: () => ({ withPrivateSettings: () => settings }) },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value }, "@webpack/common": {}
    };
    const source = readFileSync("src/equicordplugins/activityHeatmap/index.tsx", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const plugin = runInNewContext(`${code}\nexports.default;`, { exports: {}, Date,
        setTimeout: (callback: () => void) => { timers.add(callback); return callback; },
        clearTimeout: (callback: () => void) => timers.delete(callback),
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    }) as { flux: { MESSAGE_CREATE(event: object): void; }; stop(): void; };
    return { plugin, store, timers, writes: () => writes };
}

test("Activity heatmap batches tracked messages and releases its pending save on stop", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.plugin.flux.MESSAGE_CREATE({ message: { channel_id: "tracked", author: { id: "user" } } });
    assert.equal(f.writes(), 0);
    assert.equal(f.timers.size, 1);
    f.plugin.stop();
    assert.equal(f.timers.size, 0);
    assert.equal(Object.values(f.store.buckets).reduce((sum, count) => sum + count, 0), 100);
    assert.equal(f.writes(), 1);
});

test("Activity heatmap rejects invalid dates and skips untracked or optimistic messages", () => {
    const f = fixture();
    for (const event of [
        { optimistic: true, message: { channel_id: "tracked", author: { id: "user" } } },
        { message: { channel_id: "other", author: { id: "user" } } },
        { message: { channel_id: "tracked", author: { id: "user" }, timestamp: "invalid" } }
    ]) assert.doesNotThrow(() => f.plugin.flux.MESSAGE_CREATE(event));
    assert.equal(f.timers.size, 0);
    assert.equal(f.writes(), 0);
});
