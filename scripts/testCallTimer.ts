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

function load(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
    const code = transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }, ...globals
    });
}

test("fixed timers skip disabled work, clean up changes and respect updated intervals", () => {
    const timers = new Map<number, { tick(): void; delay: number; }>();
    let dependencies: unknown[] = [];
    let cleanup: (() => void) | undefined;
    let now = 2_000;
    let time: number | undefined;
    let timerId = 0;
    const api = load("src/utils/react.tsx", {
        "@webpack/common": {
            useState: (initial: number) => { time ??= initial; return [time, (value: number) => { time = value; }]; },
            useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
                if (deps.length === dependencies.length && deps.every((value, index) => value === dependencies[index])) return;
                cleanup?.();
                dependencies = deps;
                cleanup = effect();
            }
        },
        "./lazyReact": {}, "./misc": {}
    }, {
        Date: { now: () => now },
        setInterval: (tick: () => void, delay: number) => { const id = ++timerId; timers.set(id, { tick, delay }); return id; },
        clearInterval: (id: number) => timers.delete(id)
    });
    api.useFixedTimer({ initialTime: 1_000, enabled: false });
    assert.equal(timers.size, 0);
    api.useFixedTimer({ initialTime: 1_000, enabled: true });
    assert.equal(timers.size, 1);
    assert.equal(timers.get(1)?.delay, 1_000);
    now = 6_000;
    timers.get(1)?.tick();
    assert.equal(time, 5_000);
    api.useFixedTimer({ initialTime: 1_000, enabled: true, interval: 60_000 });
    assert.equal(timers.size, 1);
    assert.equal(timers.has(1), false);
    assert.equal(timers.get(2)?.delay, 60_000);
    api.useFixedTimer({ initialTime: 1_000, enabled: false });
    assert.equal(timers.size, 0);
    cleanup?.();
});

test("CallTimer disables ticks for hidden self timers and an absent voice connection", () => {
    const ticks: { enabled?: boolean }[] = [];
    const store = { format: "stopwatch", showSeconds: false, showRoleColor: false, trackSelf: false };
    const settings = { store, use: () => store };
    const React = { createElement: (type: unknown, props: unknown) => ({ type, props }) };
    const common = { React, UserStore: { getCurrentUser: () => ({ id: "self" }) }, Tooltip: () => null };
    const mocks = {
        "@utils/misc": { classes: () => "" },
        "@utils/react": { useFixedTimer: (options: { enabled?: boolean }) => { ticks.push(options); return 0; } },
        "@utils/text": { formatDurationMs: () => "0:00" },
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": common
    };
    const { Timer } = load("src/plugins/callTimer/Timer.tsx", { ...mocks, "./index": { settings }, "./TimerIcon": {} }, { React });
    assert.equal(Timer({ time: 1_000, userId: "self" }), null);
    assert.equal(ticks[0].enabled, false);
    store.trackSelf = true;
    Timer({ time: 1_000, userId: "self" });
    assert.equal(ticks[1].enabled, true);
    const { default: plugin } = load("src/plugins/callTimer/index.tsx", {
        ...mocks,
        "@api/Settings": { definePluginSettings: () => settings }, "@api/Styles": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "./alignedChatInputFix.css?managed": {}, "./Timer": {}
    });
    assert.equal(plugin.ConnectionTimer(), null);
    assert.equal(ticks[2].enabled, false);
});
