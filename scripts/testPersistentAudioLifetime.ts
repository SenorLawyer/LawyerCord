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
    const effects: (() => (() => void) | undefined)[] = [];
    const audio: Audio[] = [];
    let userId = "original";
    let toasts = 0;
    class Audio extends EventTarget {
        currentTime = 1;
        duration = 100;
        muted = false;
        playbackRate = 1;
        volume = 1;
        paused = false;
        ended = false;
        reject: (reason: Error) => void = () => {};
        resolve: () => void = () => {};
        constructor(public src: string) { super(); audio.push(this); }
        play() { return new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
        pause() { this.paused = true; }
    }
    const settings = { store: { showWidget: false, showToast: true, keepAudioAttachments: true } };
    const modules: Record<string, unknown> = {
        "./styles.css": {}, "@api/Settings": { definePluginSettings: () => settings },
        "@utils/constants": { EquicordDevs: {} }, "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": { React: { createElement() {}, useRef: (value: unknown) => ({ current: value }), useEffect: (effect: typeof effects[number]) => effects.push(effect) }, showToast: () => toasts++, Toasts: { Type: {} }, UserStore: { getCurrentUser: () => ({ id: userId }) } }
    };
    const source = transpileModule(readFileSync("src/equicordplugins/persistentAudioPlayback/index.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    const api = runInNewContext(`${source}\n({ plugin: exports.default, continueCustomDetached, detachedPlayers, AudioKeeper });`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }, URL, Audio, cancelAnimationFrame() {}, requestAnimationFrame: () => 1
    });
    const snapshot = { src: "https://example.com/audio.ogg", currentTime: 1, duration: 100, muted: false, playbackRate: 1, volume: 1 };
    return { ...api, snapshot, audio, effects, Audio, user: (id: string) => userId = id, toasts: () => toasts };
}

test("Persistent audio ignores replaced player's late play success and rejection", async () => {
    const f = fixture();
    f.continueCustomDetached("audio", f.snapshot);
    f.continueCustomDetached("audio", f.snapshot);
    f.audio[0].reject(new Error("Old player failed."));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.detachedPlayers.get(f.snapshot.src).audio, f.audio[1]);
    assert.equal(f.audio[1].paused, false);
    f.plugin.stop();
    f.audio[1].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.toasts(), 0);
    assert.equal(f.detachedPlayers.size, 0);
});

test("Persistent audio cleanup cannot revive playback after stop, reconnect or account replacement", () => {
    for (const mode of ["stop", "reconnect", "account"]) {
        const f = fixture();
        const audio = new f.Audio(f.snapshot.src);
        f.AudioKeeper({ kind: "audio", src: f.snapshot.src, mediaRef: { current: audio } });
        const cleanup = f.effects[0]();
        if (mode === "stop") f.plugin.stop();
        else if (mode === "reconnect") f.plugin.flux.CONNECTION_OPEN();
        else f.user("replacement");
        cleanup();
        assert.equal(f.audio.length, 1);
        assert.equal(f.detachedPlayers.size, 0);
    }
});
