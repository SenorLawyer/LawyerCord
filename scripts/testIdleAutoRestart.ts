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
    const source = readFileSync(process.env.AUDIT_IDLE_SOURCE ?? "src/equicordplugins/idleAutoRestart/index.tsx", "utf8");
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    let now = 1000;
    let nextId = 0;
    let inVoice = false;
    let reloads = 0;
    let schedules = 0;
    const timers = new Map<number, { at: number; callback(): void; }>();
    const listeners = new Map<string, () => void>();
    const voiceListeners = new Set<() => void>();
    const values = { isEnabled: true, idleMinutes: 5 };
    let options: Record<string, { onChange(value: boolean | number): void; }> = {};
    const store = new Proxy(values, {
        set(target, key, value) {
            Reflect.set(target, key, value);
            options[String(key)]?.onChange(value);
            return true;
        }
    });
    const exports: { default?: { start(): void; stop(): void; toolboxActions(): { props: { action(): void; }; }; }; } = {};
    const modules: Record<string, unknown> = {
        "@api/Settings": { definePluginSettings: (def: typeof options) => { options = def; return { store }; } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/Logger": { Logger: class { info() {} } },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin, OptionType: {} },
        "@webpack/common": { Menu: { MenuItem: "item" }, VoiceStateStore: {
            isCurrentClientInVoiceChannel: () => inVoice,
            addChangeListener: (callback: () => void) => voiceListeners.add(callback),
            removeChangeListener: (callback: () => void) => voiceListeners.delete(callback)
        } },
        "react/jsx-runtime": { jsx: (_type: unknown, props: unknown) => ({ props }) }
    };
    runInNewContext(outputText, {
        exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        Date: { now: () => now },
        setTimeout: (callback: () => void, delay: number) => {
            schedules++;
            timers.set(++nextId, { at: now + delay, callback });
            return nextId;
        },
        clearTimeout: (id: number) => timers.delete(id),
        document: {
            addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
            removeEventListener: (name: string, callback: () => void) => {
                assert.equal(listeners.get(name), callback);
                listeners.delete(name);
            }
        },
        location: { reload: () => reloads++ }
    });
    const plugin = exports.default;
    assert.ok(plugin);
    return {
        plugin, store, timers, listeners, voiceListeners,
        get reloads() { return reloads; },
        get schedules() { return schedules; },
        voice(value: boolean) { inVoice = value; for (const cb of voiceListeners) cb(); },
        advance(ms: number) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) { timers.delete(id); timer.callback(); }
            }
        }
    };
}

test("idle restart waits for voice changes without polling and reloads when an overdue call ends", () => {
    const f = fixture();
    f.plugin.start();
    assert.equal(f.timers.size, 1);
    f.voice(true);
    assert.equal(f.timers.size, 0);
    const schedules = f.schedules;
    f.advance(3_600_000);
    assert.equal(f.reloads, 0);
    assert.equal(f.schedules, schedules);
    f.voice(false);
    assert.equal(f.timers.size, 1);
    f.advance(0);
    assert.equal(f.reloads, 1);
    f.plugin.stop();
    assert.equal(f.voiceListeners.size, 0);
    assert.equal(f.listeners.size, 0);
});

test("idle activity remains throttled and unrelated voice changes preserve its deadline", () => {
    const f = fixture(); f.plugin.start();
    f.advance(1000); f.listeners.get("mousemove")?.();
    const schedules = f.schedules;
    f.advance(500); f.listeners.get("mousemove")?.();
    for (let i = 0; i < 100; i++) f.voice(false);
    assert.equal(f.schedules, schedules);
    f.advance(299_499); assert.equal(f.reloads, 0);
    f.advance(1); assert.equal(f.reloads, 1);
    f.plugin.stop();
});

test("idle restart settings cannot install work before start or after stop", () => {
    const f = fixture();
    f.store.isEnabled = true; f.store.idleMinutes = 10;
    assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
    f.plugin.start(); f.plugin.stop();
    f.store.isEnabled = true; f.store.idleMinutes = 5; f.voice(false);
    assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
    f.plugin.start(); assert.equal(f.timers.size, 1);
    f.store.isEnabled = false;
    assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
    f.voice(true); f.voice(false); f.advance(3_600_000);
    assert.equal(f.reloads, 0);
    f.plugin.stop();
});

test("idle restart toolbox toggles schedule once through settings ownership", () => {
    const f = fixture(); f.plugin.start();
    f.plugin.toolboxActions().props.action();
    assert.equal(f.timers.size, 0);
    const schedules = f.schedules;
    f.plugin.toolboxActions().props.action();
    assert.equal(f.schedules, schedules + 1);
    assert.equal(f.timers.size, 1);
    f.plugin.stop();
});
