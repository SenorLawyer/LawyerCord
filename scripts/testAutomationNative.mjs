/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
let reads = 0;
let processes = 0;
const result = await build({
    entryPoints: ["src/equicordplugins/automationCore.desktop/native.ts"], bundle: true, write: false, platform: "node", format: "cjs",
    external: ["electron"],
    plugins: [{ name: "isolated-paths", setup(build) {
        build.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export const DATA_DIR="/isolated-test";' }));
    } }],
});
const globals = {
    module: { exports: {} }, Buffer, URL, Date, process, AbortController,
    setInterval: () => { throw new Error("Native automation scans must not create background timers."); },
    setTimeout, clearTimeout,
    fetch: () => { throw new Error("Unexpected network call."); },
    require: name => {
        if (name === "electron") return { safeStorage: {}, shell: {} };
        if (name === "fs/promises") return { readdir: async () => { reads++; return []; }, stat: async () => { reads++; throw Object.assign(new Error("Missing test file"), { code: "ENOENT" }); } };
        if (name === "child_process") return { spawn: () => { processes++; throw new Error("Unexpected process scan."); } };
        return require(name);
    },
};
runInNewContext(result.outputFiles[0].text, globals);
const api = globals.module.exports;
await api.pollSystemEvents({}, 0, []);
assert.equal(reads, 0);
assert.equal(processes, 0);
await api.pollSystemEvents({}, 0, ["codex-finish"]);
assert.ok(reads > 0);
assert.equal(processes, 0);
const previousReads = reads;
await api.pollSystemEvents({}, 0, []);
assert.equal(reads, previousReads);
await api.pollSystemEvents({}, 0, ["process-start"]);
assert.equal(processes, 1);
assert.equal(reads, previousReads);
console.log("Native scans are demand-driven, source-specific, and create no background timers.");
