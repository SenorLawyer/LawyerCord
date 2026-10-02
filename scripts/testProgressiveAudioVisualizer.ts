/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Browsing paused audio embeds does not fetch or create visualizer audio contexts", async () => {
    let fetches = 0;
    let contexts = 0;
    const effects: (() => void | (() => void))[] = [];
    const listeners = new Map<string, () => void>();
    const audio = { paused: true, currentTime: 0, src: "fixture", addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name), async play() { this.paused = false; } };
    const canvas = { getContext: () => ({ setTransform() {} }), getBoundingClientRect: () => ({ width: 100, height: 20 }) };
    const settings = { oscilloscope: true, spectrograph: true };
    const React = {
        useRef: (current: unknown) => ({ current }), useEffect: (callback: () => void | (() => void)) => effects.push(callback),
        createElement: (_tag: unknown, props: { ref: { current: unknown; }; }) => { props.ref.current = canvas; return null; }
    };
    const source = readFileSync("src/equicordplugins/betterAudioPlayer/index.tsx", "utf8") + "\nexport { Visualizer };";
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const { Visualizer } = runInNewContext(code + "\nexports;", { exports: {}, React, AbortController, setTimeout, clearTimeout, Blob, window: { devicePixelRatio: 1 },
        fetch: async () => { fetches++; return new Response("audio"); },
        AudioContext: class { state = "running"; constructor() { contexts++; } createAnalyser() { return { fftSize: 0, connect() {} }; } createMediaElementSource() { return { connect() {} }; } close() {} },
        ResizeObserver: class { observe() {} disconnect() {} }, URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        require(name: string) {
            if (name === "@api/Settings") return { definePluginSettings: () => ({ store: settings }) };
            if (name === "@webpack/common") return { React };
            if (name === "@utils/constants") return { EquicordDevs: {} };
            if (name === "@utils/css") return { classNameFactory: () => () => "" };
            if (name === "@utils/types") return { __esModule: true, default: (x: unknown) => x, OptionType: {} };
            if (name === "@utils/Logger") return { Logger: class { error() {} } };
            return {};
        }
    });
    for (let i = 0; i < 100; i++) {
        Visualizer({ playerRef: { current: audio }, src: `fixture-${i}` });
        const cleanups = effects.splice(0).map(effect => effect());
        await setImmediate();
        for (const cleanup of cleanups) cleanup?.();
    }
    assert.equal(fetches, 0);
    assert.equal(contexts, 0);
    assert.equal(listeners.size, 0);
    Visualizer({ playerRef: { current: audio }, src: "playing" });
    const cleanups = effects.splice(0).map(effect => effect());
    audio.paused = false;
    listeners.get("play")?.();
    listeners.get("play")?.();
    await setImmediate();
    assert.equal(fetches, 1);
    assert.equal(contexts, 1);
    for (const cleanup of cleanups) cleanup?.();
    assert.equal(listeners.size, 0);
});
