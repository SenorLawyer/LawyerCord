/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import type * as Regex from "../src/components/settings/tabs/automations/regex";

function fixture() {
    let account = "A", channel = "C", blocked = false;
    const opened: string[] = [];
    const warnings: unknown[] = [];
    let settings: { store: { regex: string; url: string; }; def: Record<string, { onChange?: (value: string) => void; }>; };
    const blobs = new Map<string, Blob>();
    const workers = new Set<Worker>();
    let created = 0;
    class BrowserWorker {
        onmessage?: (event: { data: unknown; }) => void;
        onerror?: (event: { preventDefault(): void; }) => void;
        private stopped = false;
        private ready: Promise<Worker>;
        constructor(url: string) {
            const blob = blobs.get(url);
            assert.ok(blob);
            this.ready = blob.text().then(source => {
                const worker = new Worker(`const { parentPort } = require("node:worker_threads"); let onmessage; const postMessage = data => parentPort.postMessage(data); ${source}; parentPort.on("message", data => onmessage({ data }));`, { eval: true });
                created++;
                workers.add(worker);
                worker.on("exit", () => workers.delete(worker));
                worker.on("message", data => this.onmessage?.({ data }));
                worker.on("error", () => this.onerror?.({ preventDefault() {} }));
                if (this.stopped) void worker.terminate();
                return worker;
            });
        }
        postMessage(data: unknown) { void this.ready.then(worker => { if (!this.stopped) worker.postMessage(data); }); }
        terminate() { this.stopped = true; void this.ready.then(worker => worker.terminate()); }
    }
    const modules = new Map<string, Record<string, unknown>>();
    const require = createRequire(import.meta.url);
    function load(path: string): Record<string, unknown> {
        const cached = modules.get(path);
        if (cached) return cached;
        const exports: Record<string, unknown> = {};
        modules.set(path, exports);
        const code = transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
        runInNewContext(code, { exports, VencordNative: { native: { openExternal: (url: string) => opened.push(url) } }, Error, Blob, Worker: BrowserWorker, setTimeout, clearTimeout, structuredClone, crypto, AbortController, require(name: string) {
            if (name === "@api/Settings") return { definePluginSettings(def: typeof settings.def) { settings = { def, store: { regex: "hop on (?:fortnite|fn)", url: "test://open" } }; return settings; } };
            if (name === "@utils/constants") return { Devs: { ImLvna: {} } };
            if (name === "@utils/Logger") return { __esModule: true, Logger: class { error(...args: unknown[]) { warnings.push(args); } warn(...args: unknown[]) { warnings.push(args); } } };
            if (name === "@utils/types") return { __esModule: true, default: (value: unknown) => value, OptionType: { STRING: 1 } };
            if (name === "@webpack/common") return { RelationshipStore: { isBlocked: () => blocked }, SelectedChannelStore: { getChannelId: () => channel }, UserStore: { getCurrentUser: () => ({ id: account }) } };
            if (name === "@utils/regex") return load(resolve("src/utils/regex.ts"));
            return name.startsWith(".") ? load(resolve(dirname(path), `${name}.ts`)) : require(name);
        }, URL: {
            createObjectURL(blob: Blob) { const url = crypto.randomUUID(); blobs.set(url, blob); return url; },
            revokeObjectURL(url: string) { blobs.delete(url); }
        } });
        return exports;
    }
    const api = load(resolve("src/components/settings/tabs/automations/regex.ts")) as typeof Regex;
    const plugin = load(resolve("src/equicordplugins/hopOn/index.tsx")).default as { start(): void; stop(): void; flux: Record<string, (event: unknown) => Promise<void> | void>; };
    plugin.start();
    return { plugin, api, opened, warnings, workers, blobs, created: () => created, send(content = "HOP ON FN", extra = {}) { return plugin.flux.MESSAGE_CREATE({ type: "MESSAGE_CREATE", optimistic: false, channelId: channel, message: { content, author: { id: "other" } }, ...extra }); }, configure(regex: string) { settings.store.regex = regex; settings.def.regex.onChange?.(regex); }, setAccount(value: string) { account = value; plugin.flux.CONNECTION_OPEN({}); }, setChannel(value: string) { channel = value; plugin.flux.CHANNEL_SELECT({}); }, block() { blocked = true; }, changeUrl() { settings.store.url = "test://new"; settings.def.url.onChange?.(settings.store.url); } };
}

test("HopOn matches through a real isolated worker and retains event filters", async () => {
    const f = fixture();
    try {
        await f.send();
        await f.send("no match");
        await f.send(undefined, { optimistic: true });
        await f.send(undefined, { channelId: "elsewhere" });
        await f.send(undefined, { message: { content: "hop on fn", state: "SENDING" } });
        assert.deepEqual(f.opened, ["test://open"]);
        f.api.stopRegexWorker();
        await f.send();
        assert.equal(f.opened.length, 2);
        f.configure("[");
        await f.send();
        f.configure(" ");
        await f.send();
        assert.equal(f.opened.length, 2);
    } finally { f.plugin.stop(); f.api.stopRegexWorker(); }
});

test("HopOn catastrophic matches leave the main thread responsive and later work succeeds", async () => {
    const f = fixture();
    let beats = 0;
    const timer = setInterval(() => beats++, 10);
    try {
        f.configure("^(a+)+$");
        await f.send("a".repeat(40) + "!");
        assert.ok(beats >= 5);
        assert.equal(f.opened.length, 0);
        assert.equal(f.warnings.length, 1);
        f.configure("yes");
        await f.send("YES");
        assert.deepEqual(f.opened, ["test://open"]);
    } finally { clearInterval(timer); f.plugin.stop(); }
});

test("HopOn cancels stale matches across lifecycle and configuration changes", async () => {
    for (const change of ["stop", "account", "channel", "pattern", "url", "blocked"] as const) {
        const f = fixture();
        try {
            const pending = f.send();
            if (change === "stop") { f.plugin.stop(); f.plugin.start(); }
            if (change === "account") { f.setAccount("B"); f.setAccount("A"); }
            if (change === "channel") { f.setChannel("D"); f.setChannel("C"); }
            if (change === "pattern") f.configure("other");
            if (change === "url") f.changeUrl();
            if (change === "blocked") f.block();
            await pending;
            assert.equal(f.opened.length, 0, change);
        } finally { f.plugin.stop(); }
    }
});

test("HopOn bounds bursts and stopping it leaves automation work owned separately", async () => {
    const f = fixture();
    try {
        f.configure("^(a+)+$");
        const jobs = [f.send("a".repeat(40) + "!")];
        for (let index = 0; index < 65; index++) jobs.push(f.send("a"));
        await Promise.all(jobs);
        assert.equal(f.opened.length, 64);
        assert.equal(f.warnings.length, 2);
        const automation = f.api.evaluateRegex("^ok$", ["ok"]);
        f.plugin.stop();
        assert.equal((await automation).matches[0], true);
    } finally { f.plugin.stop(); f.api.stopRegexWorker(); }
});


test("Cancelling a full HopOn queue does not create workers for pending matches", async () => {
    const f = fixture();
    try {
        f.configure("^(a+)+$");
        const jobs = [f.send("a".repeat(40) + "!")];
        for (let index = 0; index < 64; index++) jobs.push(f.send("a"));
        f.plugin.stop();
        await Promise.all(jobs);
        assert.equal(f.created(), 1);
        assert.equal(f.warnings.length, 0);
        assert.equal(f.opened.length, 0);
    } finally { f.plugin.stop(); }
});
