/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";

const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.split("=")[1] || "c637282a72ca612f29db2b8072b61c5bd2c943ec";
const sourcePath = "src/components/settings/tabs/automations/engine.ts";
const storageTest = process.argv.includes("--storage-test");
const header = storageTest ? "" : execFileSync("git", ["show", baseline + ":" + sourcePath], { encoding: "utf8" });
const moduleMocks = new Map();
const named = new Set();
for (const contents of [header, await readFile(sourcePath, "utf8")]) {
    for (const match of contents.matchAll(/import\s*{([^}]+)}\s*from\s*["'](@[^"']+|\.\/spotify)["']/g)) {
        for (const name of match[1].split(",").map(value => value.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])) if (/^\w+$/.test(name)) named.add(name);
    }
}
const common = `const noop=()=>{};const store=new Proxy({getCurrentUser:()=>({id:"100000000000000001"}),getChannel:()=>undefined},{get:(s,k)=>s[k]||noop});export const FluxDispatcher={subscribe:(name,fn)=>{const list=globalThis.handlers.get(name)||new Set();list.add(fn);globalThis.handlers.set(name,list)},unsubscribe:(name,fn)=>{const list=globalThis.handlers.get(name);list?.delete(fn);if(!list?.size)globalThis.handlers.delete(name)},dispatch:noop};${[...named].filter(n=>n!=="FluxDispatcher").map(n=>`export const ${n}=${n.endsWith("Store")?"store":n==="sleep"?"async()=>{}":n==="Logger"?"class{warn(){}error(){}debug(){}info(){}}":"noop"};`).join("\n")}export default class {warn(){}error(){}debug(){}info(){}}`;
moduleMocks.set("common", common);
moduleMocks.set("storage", `export async function keys(){return [...globalThis.data.keys()]}export async function del(key){globalThis.data.delete(key)}export async function getMany(keys){return keys.map(key=>globalThis.data.get(key))}export async function setMany(entries){globalThis.writes++;for(const [key,value]of entries)globalThis.data.set(key,structuredClone(value))}export async function get(key){return globalThis.data.get(key)}export async function set(key,value){globalThis.writes++;globalThis.data.set(key,structuredClone(value))}export async function update(key,fn){globalThis.data.set(key,fn(globalThis.data.get(key)))}`);
moduleMocks.set("openRouter", `export const completeOpenRouter=async()=>({success:false});export const getAutomationAISettings=async()=>({});export const loadOpenRouterModels=async()=>[];`);

async function engine(version) {
    const contents = version === "before" ? header : await readFile(sourcePath, "utf8");
    const bundled = await build({
        stdin: { contents, loader: "ts", resolveDir: dirname(resolve(sourcePath)) },
        bundle: true, write: false, platform: "node", format: "cjs",
        plugins: [{ name: "benchmark-adapters", setup(build) {
            build.onResolve({ filter: /^@/ }, args => ({ path: args.path === "@api/DataStore" ? "storage" : "common", namespace: "mock" }));
            build.onResolve({ filter: /^\.\/spotify$/ }, () => ({ path: "common", namespace: "mock" }));
            build.onResolve({ filter: /^\.\/openRouter$/ }, () => ({ path: "openRouter", namespace: "mock" }));
            if (version === "before") build.onLoad({ filter: /[\\/]automations[\\/]model\.ts$/ }, () => ({ contents: execFileSync("git", ["show", baseline + ":src/components/settings/tabs/automations/model.ts"], { encoding: "utf8" }), loader: "ts" }));
            build.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: moduleMocks.get(args.path), loader: "js" }));
        } }],
    });
    const globals = { module: { exports: {} }, exports: {}, handlers: new Map(), data: new Map(), writes: 0, structuredClone, crypto: globalThis.crypto, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, Date, Intl, performance, console, URL, window: { setTimeout, clearTimeout }, fetch: () => { throw Error("Benchmark reached network."); } };
    const helpers = runInNewContext(bundled.outputFiles[0].text + (version === "after" ? "\n({ resolveTemplate, variableValue });" : ""), globals);
    return { api: globals.module.exports, globals, helpers };
}

const now = Date.now();
function fixture(id, type = "note") {
    const block = { id: "block-" + id, type, position: { x: 0, y: 0 }, config: type === "wait-reply" ? { channelId: "200000000000000001", timeoutSeconds: 60 } : {} };
    return { id: "flow-" + id, name: "Workflow " + id, enabled: true, trigger: { type: "message", channelId: String(300000000000000000n + BigInt(id)) }, schedule: { interval: 1, unit: "hours", startAt: now + 3600000 }, maxRunMinutes: 15, blocks: [block], createdAt: now, updatedAt: now };
}
function measure(fn, iterations) {
    const values = [];
    for (let sample = 0; sample < 7; sample++) {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) fn();
        values.push(performance.now() - start);
    }
    values.sort((a,b)=>a-b);
    return { medianMs: values[3], p95Ms: values[6], iterations };
}
if (storageTest) {
    const { api, globals, helpers } = await engine("after");
    const variables = { messages: [{ content: "Hello" }], value: 0 };
    assert.equal(helpers.resolveTemplate("{{messages.0.content}} {{value}}", variables), "Hello 0");
    assert.equal(helpers.variableValue("messages.0.content", { variables }), "Hello");
    assert.equal(helpers.resolveTemplate("{{inherited}}", Object.create({ inherited: "private" })), "");
    for (const path of ["__proto__", "messages.constructor", "messages.0.prototype"]) {
        assert.throws(() => helpers.resolveTemplate(`{{${path}}}`, variables), /not allowed/);
        assert.throws(() => helpers.variableValue(path, { variables }), /not allowed/);
    }
    const legacy = fixture(1);
    const scheduled = fixture(3);
    delete scheduled.trigger;
    const scheduledReload = await engine("after");
    scheduledReload.globals.data.set("LawyerCord_automations", [scheduled]);
    await scheduledReload.api.loadAutomationState();
    assert.equal(scheduledReload.api.getAutomationSnapshot().automations[0].trigger.type, "schedule");
    assert.deepEqual(scheduledReload.globals.data.get("LawyerCord_automations_v1_backup"), [scheduled]);
    await scheduledReload.api.setAutomationSystemEnabled(true);
    scheduledReload.api.stopAutomationEngine();
    globals.data.set("LawyerCord_automations", [legacy]);
    await api.loadAutomationState();
    assert.equal(api.getAutomationSnapshot().automations[0].runMode, "skip");
    assert.deepEqual(globals.data.get("LawyerCord_automations_v1_backup"), [legacy]);
    assert.equal(globals.data.get("LawyerCord_automations_v2").version, 2);
    await api.startAutomationEngine();
    assert.equal(api.getAutomationSnapshot().systemEnabled, false);
    assert.equal(globals.handlers.size, 0);
    assert.equal((await api.runAutomation(legacy.id)).success, false);
    await api.setAutomationSystemEnabled(true);
    assert.equal(globals.handlers.get("MESSAGE_CREATE").size, 1);
    assert.equal(globals.data.get("LawyerCord_automations_v2").systemEnabled, true);
    const enabledReload = await engine("after");
    enabledReload.globals.data.set("LawyerCord_automations_v2", globals.data.get("LawyerCord_automations_v2"));
    await enabledReload.api.startAutomationEngine();
    assert.equal(enabledReload.globals.handlers.get("MESSAGE_CREATE").size, 1);
    enabledReload.api.stopAutomationEngine();
    await api.setAutomationSystemEnabled(false);
    assert.equal(globals.handlers.size, 0);
    assert.equal(globals.data.get("LawyerCord_automations_v2").systemEnabled, false);
    await api.replaceAutomations([]);
    await api.setAutomationSystemEnabled(true);
    assert.equal(globals.handlers.size, 0);
    await api.replaceAutomations([legacy]);
    assert.equal(globals.handlers.get("MESSAGE_CREATE").size, 1);
    const waiting = fixture(2, "wait-reply");
    await api.replaceAutomations([waiting]);
    const pending = api.runAutomation(waiting.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    await api.setAutomationSystemEnabled(false);
    assert.equal((await pending).success, false);
    assert.equal(globals.handlers.size, 0);
    await api.replaceAutomations([legacy]);
    const saved = globals.data.get("LawyerCord_automations_v2");
    await api.upsertAutomation({ ...api.getAutomationSnapshot().automations[0], name: "Saved" });
    assert.deepEqual(globals.data.get("LawyerCord_automations_v1_backup"), [legacy]);
    const invalid = await engine("after");
    invalid.globals.data.set("LawyerCord_automations_v2", { version: 999, automations: [] });
    await assert.rejects(invalid.api.loadAutomationState(), /not been replaced/);
    assert.equal(invalid.globals.writes, 0);
    assert.equal(invalid.globals.data.get("LawyerCord_automations_v2").version, 999);
    const restored = await engine("after");
    restored.globals.data.set("LawyerCord_automations_v2", saved);
    await api.saveAutomationDraft({ ...legacy, id: "unsaved", name: "Unpublished draft" });
    restored.globals.data.set("LawyerCord_automationDraft_unsaved", globals.data.get("LawyerCord_automationDraft_unsaved"));
    await restored.api.loadAutomationState();
    assert.equal(restored.api.getAutomationSnapshot().automations[0].id, legacy.id);
    assert.equal(restored.api.getAutomationSnapshot().drafts[0].name, "Unpublished draft");
    await restored.api.discardAutomationDraft("unsaved");
    assert.equal(restored.api.getAutomationSnapshot().drafts.length, 0);
    api.stopAutomationEngine(); invalid.api.stopAutomationEngine(); restored.api.stopAutomationEngine();
    console.log("Production storage migration, backup, reload, and fail-closed checks passed.");
} else {
const results = {};
for (const version of ["before", "after"]) {
    const { api, globals } = await engine(version);
    const flows = Array.from({ length: 100 }, (_, id) => fixture(id));
    await api.replaceAutomations(flows);
    await api.startAutomationEngine();
    if (api.setAutomationSystemEnabled) await api.setAutomationSystemEnabled(true);
    const event = { message: { id: "400000000000000001", channel_id: "999999999999999999", content: "unmatched", author: { id: "100000000000000002" } } };
    const dispatch = () => { for (const fn of globals.handlers.get("MESSAGE_CREATE") ?? []) fn(event); };
    const dispatchResult = measure(dispatch, 10000);
    const heapBefore = process.memoryUsage().heapUsed;
    const snapshots = measure(() => api.getAutomationSnapshot(), 1000);
    const retainedHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    const waits = Array.from({ length: 20 }, (_, id) => fixture(id, "wait-reply"));
    await api.replaceAutomations(waits);
    if (api.setAutomationRunLimit) await api.setAutomationRunLimit(32);
    const pending = waits.map(flow => api.runAutomation(flow.id));
    await new Promise(resolve => setTimeout(resolve, 25));
    const waitSubscriptions = globals.handlers.get("MESSAGE_CREATE")?.size ?? 0;
    api.stopAutomationEngine();
    await Promise.all(pending);
    const looping = fixture(0);
    looping.blocks[0].next = looping.blocks[0].id;
    looping.enabled = false;
    await api.replaceAutomations([looping]);
    if (api.setAutomationSystemEnabled) await api.startAutomationEngine();
    const started = performance.now();
    await api.runAutomation(looping.id);
    const tenThousandStepsMs = performance.now() - started;
    results[version] = { dispatch: dispatchResult, snapshots, retainedHeapDeltaBytes, waitSubscriptions, tenThousandStepsMs, storageWrites: globals.writes };
    api.stopAutomationEngine();
}
const output = resolve("dist/automation-review");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "performance.json"), JSON.stringify({ baseline, results, notes: ["Production engine code with identical isolated Discord and storage adapters.", "Heap deltas include garbage collection noise and do not measure total allocations.", "The 100-block editor is measured separately by the browser preview."] }, null, 2));
console.log(JSON.stringify(results, null, 2));
}
