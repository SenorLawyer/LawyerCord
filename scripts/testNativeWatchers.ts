/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync("src/main/ipcMain.ts", "utf8");
const compile = (code: string) => transpileModule(code, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

test("reinitializing native CSS watchers closes old watchers and cancels pending setup", async () => {
    const code = source.slice(source.indexOf("const stopWatching"), source.indexOf("ipcMain.on(IpcEvents.GET_MONACO_THEME"));
    const watchers: { closed: boolean; callback: () => Promise<void>; }[] = [];
    const callbacks = new Map<string, (event: { sender: EventEmitter; }) => Promise<void>>();
    const pendingOpens: (() => void)[] = [];
    const updates: string[] = [];
    const sender = Object.assign(new EventEmitter(), { postMessage() { updates.push("main"); } });
    const popout = Object.assign(new EventEmitter(), { postMessage() { updates.push("popout"); } });
    runInNewContext(compile(code), {
        IpcEvents: { INIT_FILE_WATCHERS: "init" }, IS_DEV: true,
        QUICK_CSS_PATH: "quickCss", THEMES_DIR: "themes", RENDERER_CSS_PATH: "renderer",
        ipcMain: { handle: (name: string, callback: (event: { sender: EventEmitter; }) => Promise<void>) => callbacks.set(name, callback) },
        debounce: (callback: unknown) => callback,
        readCss: async () => "css",
        readFile: async () => "renderer",
        open: () => new Promise(resolve => pendingOpens.push(() => resolve({ close: async () => { } }))),
        watch(_path: string, _options: unknown, callback: () => Promise<void>) {
            const watcher = { closed: false, callback, close() { this.closed = true; } };
            watchers.push(watcher);
            return watcher;
        }
    });
    const init = callbacks.get("init");
    assert.ok(init);
    const first = init({ sender });
    pendingOpens.shift()?.();
    await first;
    assert.equal(watchers.length, 3);
    const popoutInit = init({ sender: popout });
    pendingOpens.shift()?.();
    await popoutInit;
    assert.equal(watchers.length, 6);
    assert.ok(watchers.every(watcher => !watcher.closed));
    await watchers[0].callback();
    await watchers[3].callback();
    assert.deepEqual(updates, ["main", "popout"]);
    const second = init({ sender });
    assert.ok(watchers.slice(0, 3).every(watcher => watcher.closed));
    assert.ok(watchers.slice(3).every(watcher => !watcher.closed));
    assert.equal(sender.listenerCount("destroyed"), 1);
    const third = init({ sender });
    pendingOpens.shift()?.();
    await second;
    assert.equal(watchers.length, 6, "superseded setup must not create watchers");
    sender.emit("destroyed");
    pendingOpens.shift()?.();
    await third;
    assert.equal(watchers.length, 6, "destroyed renderer must not create watchers");
    assert.equal(sender.listenerCount("destroyed"), 0);
    assert.equal(popout.listenerCount("destroyed"), 1);
    const before = updates.length;
    for (const watcher of watchers) await watcher.callback();
    assert.equal(updates.length, before + 3, "only the popout still receives updates");
    popout.emit("destroyed");
    assert.ok(watchers.every(watcher => watcher.closed));
    assert.equal(popout.listenerCount("destroyed"), 0);
});
