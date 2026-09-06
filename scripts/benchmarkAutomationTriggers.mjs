/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice(11) ?? "6e664e03b";
const path = "src/components/settings/tabs/automations/events.ts";
async function load(before) {
    const source = before ? execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }) : await readFile(path, "utf8");
    const bundle = await build({ stdin: { contents: source, resolveDir: resolve("src/components/settings/tabs/automations"), loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs" });
    const globals = { module: { exports: {} }, exports: {} };
    runInNewContext(bundle.outputFiles[0].text, globals);
    return globals.module.exports;
}
const workflows = Array.from({ length: 2000 }, (_, i) => ({ id: `workflow-${i}`, enabled: true, trigger: { type: "message", authorId: `person-${i}` } }));
const events = Array.from({ length: 5000 }, (_, i) => ({ type: "MESSAGE_CREATE", channelId: "channel", guildId: "server", authorId: `person-${i % workflows.length}`, content: "A message", self: false, bot: false, mention: false, fromEngine: false }));
function measure(api) {
    const index = api.compileTriggers(workflows);
    const timings = [];
    for (let pass = 0; pass < 8; pass++) {
        let matches = 0;
        const start = performance.now();
        for (const event of events) matches += api.matchTriggers(index, event).length;
        const elapsed = performance.now() - start;
        assert.equal(matches, events.length);
        if (pass) timings.push(elapsed);
    }
    timings.sort((a, b) => a - b);
    return { medianMs: timings[3], slowestMs: timings[6], matched: events.length };
}
const before = measure(await load(true));
const after = measure(await load(false));
const result = { baseline, workflows: workflows.length, events: events.length, before, after, speedup: before.medianMs / after.medianMs, scope: "Synthetic user-filtered trigger dispatch. Not Discord FPS or total CPU." };
await mkdir("dist/automation-review", { recursive: true });
await writeFile("dist/automation-review/trigger-performance.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
