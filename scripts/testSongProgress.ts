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

interface Audio {
    currentTime: number;
    duration: number;
    paused: boolean;
    addEventListener(name: string, listener: () => void): void;
    removeEventListener(name: string, listener: () => void): void;
}

interface Playing {
    audio?: { previewStart?: number; previewSlice?: number; };
}

function fixture() {
    const path = process.env.AUDIT_SONG_PROGRESS_SOURCE ?? "src/equicordplugins/songSpotlight.desktop/ui/components/ProgressCircle.tsx";
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    let progress = 0;
    let frames = 0;
    let cleanup: (() => void) | undefined;
    let effect: (() => (() => void) | void) | undefined;
    let previousDeps: unknown[] | undefined;
    const audioRef: { current: Audio | undefined; } = { current: undefined };
    const playingRef: { current: Playing | undefined; } = { current: undefined };
    const exports: { default?: (props: object) => unknown; } = {};
    const modules = {
        "@webpack/common": {
            useMemo: (factory: () => unknown) => factory(),
            useState: () => [progress, (value: number) => { progress = value; }],
            useEffect: (next: typeof effect, deps: unknown[]) => {
                if (!previousDeps || deps.some((value, index) => value !== previousDeps?.[index])) {
                    effect = next;
                    previousDeps = deps;
                }
            }
        },
        "react/jsx-runtime": { jsx: (_type: unknown, props: object) => ({ props }) }
    };
    runInNewContext(outputText, { exports, require: (name: keyof typeof modules) => {
        assert.ok(name in modules, name);
        return modules[name];
    }, requestAnimationFrame: () => ++frames, cancelAnimationFrame() {} });
    assert.ok(exports.default);
    const component = exports.default;
    return {
        audioRef, get progress() { return progress; }, get frames() { return frames; },
        render(playing?: Playing) {
            playingRef.current = playing;
            component({ border: 2.5, audioRef, playing, playingRef });
            if (effect) { cleanup?.(); cleanup = effect() || undefined; effect = undefined; }
        },
        close() { cleanup?.(); }
    };
}

function audio() {
    const listeners = new Map<string, Set<() => void>>();
    const node: Audio = { currentTime: 0, duration: 100, paused: false,
        addEventListener(name, listener) { let set = listeners.get(name); if (!set) listeners.set(name, set = new Set()); set.add(listener); },
        removeEventListener(name, listener) { listeners.get(name)?.delete(listener); }
    };
    return { node, emit(name: string) { for (const listener of listeners.get(name) ?? []) listener(); },
        get count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); } };
}

test("SongSpotlight progress schedules no frames while idle or playing and releases media listeners", () => {
    const f = fixture(); f.render(); assert.equal(f.frames, 0);
    const first = audio(); f.audioRef.current = first.node; f.render({ audio: {} });
    assert.ok(first.count > 0); assert.equal(f.frames, 0);
    first.node.currentTime = 25; first.emit("timeupdate"); assert.equal(f.progress, 0.25);
    first.node.paused = true; first.emit("pause"); assert.equal(f.progress, 0);
    f.render(); assert.equal(first.count, 0);
    const second = audio(); f.audioRef.current = second.node; f.render({ audio: {} });
    assert.equal(first.count, 0); assert.ok(second.count > 0);
    f.close(); assert.equal(second.count, 0);
    first.node.currentTime = 90; first.emit("timeupdate"); assert.equal(f.progress, 0);
});

test("SongSpotlight progress follows preview slices and rejects invalid duration", () => {
    const f = fixture(); const media = audio(); f.audioRef.current = media.node;
    f.render({ audio: { previewStart: 10_000, previewSlice: 20_000 } });
    media.node.currentTime = 20; media.emit("timeupdate"); assert.equal(f.progress, 0.5);
    media.node.currentTime = 50; media.emit("timeupdate"); assert.equal(f.progress, 1);
    media.node.currentTime = 0; media.emit("seeked"); assert.equal(f.progress, 0);
    f.render({ audio: {} });
    for (const duration of [0, NaN, Infinity]) {
        media.node.duration = duration; media.emit("durationchange"); assert.equal(f.progress, 0);
    }
    media.node.duration = 50; media.node.currentTime = 25; media.emit("durationchange"); assert.equal(f.progress, 0.5);
    media.node.paused = true; media.emit("ended"); assert.equal(f.progress, 0); f.close();
});
