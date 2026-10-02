/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = "src/components/settings/tabs/automations/";
function evaluate<T>(source: string, globals: object): T {
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    return runInNewContext(`${code}\nexports;`, { exports: {}, ...globals }) as T;
}
function declaration(file: string, name: string) {
    const ast = ts.createSourceFile(file, readFileSync(root + file, "utf8"), ts.ScriptTarget.Latest, true);
    let result = "";
    const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(ast);
        else if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = `export const ${node.getText(ast)};`;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(result, name);
    return result;
}

test("Automation saves preserve old snapshot arrays across 100 edits and insertions", async () => {
    const api = evaluate<{ upsertAutomation(value: { id: string; name: string; }): Promise<void>; snapshot(): { id: string; name: string; }[]; }>(
        `let automations = []; let guilds = []; ${declaration("engine.ts", "upsertAutomation")}\nexport const snapshot = () => automations;`, {
            loadAutomationState: async () => {}, migrateWorkflow: structuredClone, validateWorkflow: () => [], nextDue: new Map(),
            refreshTriggerCache() {}, collectGuildReferences: () => [], dirtyKeys: new Set(), GUILDS_KEY: "guilds", WORKFLOWS_KEY: "workflows", notify() {}, queueWrite: async () => {}, scheduleEngine() {}
        });
    for (let i = 0; i < 100; i++) {
        const before = api.snapshot();
        const saved = JSON.stringify(before);
        await api.upsertAutomation({ id: String(i % 10), name: String(i) });
        assert.notEqual(api.snapshot(), before);
        assert.equal(JSON.stringify(before), saved);
        assert.equal(api.snapshot().find(item => item.id === String(i % 10))?.name, String(i));
    }
});

test("Model refresh bursts share one request and permit a fresh request after settlement", async () => {
    let calls = 0;
    let resolve: (value: object) => void = () => {};
    let notifications = 0;
    const api = evaluate<{ loadOpenRouterModels(refresh?: boolean): Promise<unknown>; subscribeModels(listener: () => void): () => void; }>(readFileSync(root + "openRouter.ts", "utf8"), {
        require: () => ({}), IS_DISCORD_DESKTOP: true,
        VencordNative: { pluginHelpers: { AutomationCore: { listOpenRouterModels() { calls++; return new Promise(done => { resolve = done; }); } } } }
    });
    const unsubscribe = api.subscribeModels(() => notifications++);
    const requests = Array.from({ length: 100 }, () => api.loadOpenRouterModels(true));
    assert.equal(calls, 1);
    resolve({ success: true, models: [{ id: "first" }] });
    await Promise.all(requests);
    assert.equal(notifications, 1);
    const fresh = api.loadOpenRouterModels(true);
    assert.equal(calls, 2);
    resolve({ success: true, models: [{ id: "second" }] });
    await fresh;
    unsubscribe();
});

function dragFixture() {
    let sequence = 0;
    let layouts = 0;
    const frames = new Map<number, () => void>();
    const listeners = new Map<string, (event: object) => void>();
    const positions: { x: number; y: number; final: boolean; }[] = [];
    const dragCleanup: { current?: () => void; } = {};
    let captured = false;
    const element = {
        addEventListener(name: string, callback: (event: object) => void) { listeners.set(name, callback); },
        removeEventListener(name: string, callback: (event: object) => void) { if (listeners.get(name) === callback) listeners.delete(name); },
        setPointerCapture() { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture() { captured = false; }
    };
    const api = evaluate<{ startDrag(source: object, event: object): void; }>(declaration("BuilderModal.tsx", "startDrag"), {
        dragCleanup, dragGroup: {}, crypto, clicked: {}, setDrag() {}, setView() {}, setGhost() {}, setPointer() {}, setDropTarget() {}, dispatch() {},
        requestAnimationFrame(callback: () => void) { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame(id: number) { frames.delete(id); },
        toCanvas(x: number, y: number) { layouts++; return { x, y }; }, moveNode(_id: string, x: number, y: number, final: boolean) { positions.push({ x, y, final }); },
        surfaceRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 1000 }) } }, latest: { current: {} }
    });
    const start = () => api.startDrag({ kind: "node", id: "node", nodeX: 10, nodeY: 20 }, { button: 0, currentTarget: element, clientX: 0, clientY: 0, pointerId: 1 });
    return { start, positions, frames, listeners, layouts: () => layouts, captured: () => captured, cleanup: () => dragCleanup.current?.(),
        event(name: string, x: number, y: number) { listeners.get(name)?.({ clientX: x, clientY: y }); },
        frame() { for (const [id, callback] of frames) { frames.delete(id); callback(); } }
    };
}

test("Automation drag coalesces 100 moves and uses the final release position", () => {
    const f = dragFixture(); f.start();
    for (let i = 1; i <= 100; i++) f.event("pointermove", i, i * 2);
    assert.equal(f.positions.length, 0);
    f.frame();
    assert.equal(f.positions.length, 1);
    assert.equal(f.layouts(), 2);
    assert.deepEqual(f.positions[0], { x: 110, y: 220, final: false });
    f.event("pointermove", 110, 220);
    f.event("pointerup", 120, 240);
    assert.deepEqual(f.positions.at(-1), { x: 130, y: 260, final: true });
    assert.equal(f.frames.size, 0);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.captured(), false);
});

test("Automation drag replacement and unmount cancel pending frames across 100 cycles", () => {
    const f = dragFixture();
    for (let i = 0; i < 100; i++) { f.start(); f.event("pointermove", 10, 20); }
    assert.equal(f.frames.size, 1);
    f.cleanup(); f.frame();
    assert.equal(f.frames.size, 0);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.positions.length, 0);
    assert.equal(f.captured(), false);
});
