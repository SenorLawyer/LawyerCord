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
import { createSourceFile, isFunctionDeclaration, JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

const playerPath = "src/components/BirthdayCelebration/index.tsx";
const effectsPath = "src/components/BirthdayCelebration/Effects.tsx";

function compile(source: string) {
    return transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }, fileName: "fixture.tsx"
    }).outputText;
}

function declaration(name: string) {
    const source = createSourceFile(playerPath, readFileSync(playerPath, "utf8"), ScriptTarget.Latest, true);
    const node = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node);
    return compile(node.getText(source));
}

function deferred() {
    let resolve: () => void = () => { throw new Error("Promise was not initialized."); };
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function loadVideo(enumerateDevices: () => Promise<unknown[]>, warnings: unknown[], outputId = "native-42", name = "Default (Headphones)") {
    return runInNewContext(`${declaration("playVideo")}\nplayVideo;`, {
        MediaEngineStore: { getOutputDeviceId: () => outputId, getOutputDevices: () => ({ [outputId]: { name } }) },
        navigator: { mediaDevices: { enumerateDevices } }, logger: { warn: (...args: unknown[]) => warnings.push(args) }
    }) as (video: object) => Promise<string | undefined>;
}

test("video maps Discord native output names to browser sinks and waits for routing before playback", async () => {
    for (const label of ["Headphones", "Headphones (USB Audio)"]) {
        const routing = deferred();
        const events: string[] = [];
        const warnings: unknown[] = [];
        const playVideo = loadVideo(async () => [
            { kind: "audiooutput", deviceId: "default", label: "Speakers" },
            { kind: "audioinput", deviceId: "microphone", label },
            { kind: "audiooutput", deviceId: "browser-99", label }
        ], warnings, "default");
        const video = {
            muted: true, volume: 0, isConnected: true, sinkId: "",
            async setSinkId(id: string) { events.push(`route:${id}`); await routing.promise; this.sinkId = id; },
            async play() { events.push("play"); }
        };
        const pending = playVideo(video);
        await setImmediate();
        assert.deepEqual(events, ["route:browser-99"]);
        assert.equal(video.muted, false);
        assert.equal(video.volume, 1);
        routing.resolve();
        assert.equal(await pending, "browser-99");
        assert.deepEqual(events, ["route:browser-99", "play"]);
        assert.deepEqual(warnings, []);
    }
});

test("video falls back to the native output ID when no browser output name matches", async () => {
    const events: string[] = [];
    const warnings: unknown[] = [];
    const playVideo = loadVideo(async () => [
        { kind: "audioinput", deviceId: "microphone", label: "Headphones" },
        { kind: "audiooutput", deviceId: "native-42", label: "Different browser label" }
    ], warnings);
    const video = {
        muted: true, volume: 0, isConnected: true, sinkId: "",
        async setSinkId(id: string) { events.push(`route:${id}`); this.sinkId = id; },
        async play() { events.push("play"); }
    };
    assert.equal(await playVideo(video), "native-42");
    assert.deepEqual(events, ["route:native-42", "play"]);
    assert.deepEqual(warnings, []);
});

test("video never plays after disconnecting before or during asynchronous output selection", async () => {
    for (const stage of ["initial", "enumerate", "route"]) {
        const enumeration = deferred();
        const routing = deferred();
        let plays = 0;
        let routes = 0;
        const playVideo = loadVideo(async () => {
            await enumeration.promise;
            return [{ kind: "audiooutput", deviceId: "browser-99", label: "Headphones" }];
        }, []);
        const video = {
            muted: true, volume: 0, isConnected: stage !== "initial", sinkId: "",
            async setSinkId() { routes++; await routing.promise; }, async play() { plays++; }
        };
        const pending = playVideo(video);
        if (stage === "enumerate") video.isConnected = false;
        enumeration.resolve();
        await setImmediate();
        if (stage === "route") video.isConnected = false;
        routing.resolve();
        assert.equal(await pending, undefined);
        assert.equal(plays, 0);
        assert.equal(routes, stage === "route" ? 1 : 0);
    }
});

test("video output failures fall back to playback and playback rejection is handled", async () => {
    for (const failure of ["enumerate", "route", "unsupported", "missing", "play"]) {
        const warnings: unknown[] = [];
        let plays = 0;
        const playVideo = loadVideo(async () => {
            if (failure === "enumerate") throw new Error("Device enumeration denied.");
            return failure === "missing" ? [] : [{ kind: "audiooutput", deviceId: "browser-99", label: "Headphones" }];
        }, warnings);
        const video = {
            muted: true, volume: 0, isConnected: true, sinkId: "",
            ...(failure === "unsupported" ? {} : { async setSinkId() {
                if (failure === "route") throw new Error("Output unavailable.");
            } }),
            async play() { plays++; if (failure === "play") throw new Error("Autoplay denied."); }
        };
        assert.equal(await playVideo(video), "default");
        await setImmediate();
        assert.equal(plays, 1);
        assert.equal(warnings.length, ["enumerate", "route", "play"].includes(failure) ? 1 : 0);
    }
});

function mountEffects(reducedMotion = false, routing = Promise.resolve(), closeFails = false) {
    const events: string[] = [];
    const warnings: unknown[] = [];
    const frames = new Map<number, (time: number) => void>();
    const listeners = new Map<string, () => void>();
    let nextFrame = 0;
    let effect: (() => (() => void) | undefined) | undefined;
    let cleanup: (() => void) | undefined;
    const noop = () => {};
    const context = {
        setTransform: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
        save: noop, translate: noop, rotate: noop, scale: noop, closePath: noop, fill: noop, bezierCurveTo: noop,
        fillRect: noop, restore: noop
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    class FakeAudio {
        state = "suspended";
        sampleRate = 10;
        destination = {};
        constructor() { events.push("audio:create"); }
        createGain() { return { gain: { value: 0 }, connect: noop }; }
        createBuffer() { return { getChannelData: () => new Float32Array(14) }; }
        async setSinkId(id: string) { events.push(`audio:route:${id}`); await routing; }
        async resume() { events.push("audio:resume"); }
        async close() { events.push("audio:close"); if (closeFails) throw new Error("Already closed."); }
    }
    const modules: Record<string, unknown> = {
        "@utils/Logger": { Logger: class { warn(...args: unknown[]) { warnings.push(args); } } },
        "@webpack/common": { useRef: () => ({ current: canvas }), useEffect: (callback: typeof effect) => { effect = callback; } }
    };
    const Effects = runInNewContext(`${compile(readFileSync(effectsPath, "utf8"))}\nexports.default;`, {
        exports: {}, require: (name: string) => modules[name], React: { createElement: noop },
        matchMedia: () => ({ matches: reducedMotion }), innerWidth: 1000, innerHeight: 700, devicePixelRatio: 2,
        AudioContext: FakeAudio, performance: { now: () => 0 },
        requestAnimationFrame: (callback: (time: number) => void) => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: (id: number) => { events.push(`cancel:${id}`); assert.ok(frames.delete(id)); },
        window: {
            addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener); },
            removeEventListener: (name: string, listener: () => void) => { assert.equal(listeners.get(name), listener); listeners.delete(name); }
        }
    });
    Effects({ sinkId: "browser-99" });
    assert.ok(effect);
    cleanup = effect();
    return { events, warnings, frames, listeners, canvas, cleanup };
}

test("Effects cleanup cancels the latest frame, removes the same resize listener and closes audio", async () => {
    const mounted = mountEffects();
    await setImmediate();
    assert.deepEqual(mounted.events, ["audio:create", "audio:route:browser-99", "audio:resume"]);
    assert.equal(mounted.canvas.width, 1500);
    assert.equal(mounted.canvas.height, 1050);
    assert.equal(mounted.listeners.size, 1);
    for (let i = 1; i <= 3; i++) {
        const entry = mounted.frames.entries().next().value;
        assert.ok(entry);
        mounted.frames.delete(entry[0]);
        entry[1](i * 16);
        assert.equal(mounted.frames.size, 1);
    }
    assert.ok(mounted.cleanup);
    mounted.cleanup();
    await setImmediate();
    assert.equal(mounted.frames.size, 0);
    assert.equal(mounted.listeners.size, 0);
    assert.deepEqual(mounted.events.slice(-2), ["cancel:4", "audio:close"]);
    assert.deepEqual(mounted.warnings, []);
});

test("Effects cannot resume audio after cleanup while sink selection is pending", async () => {
    for (const rejectClose of [false, true]) {
        const routing = deferred();
        const mounted = mountEffects(false, routing.promise, rejectClose);
        assert.ok(mounted.cleanup);
        mounted.cleanup();
        routing.resolve();
        await setImmediate();
        assert.equal(mounted.events.includes("audio:resume"), false);
        assert.equal(mounted.events.filter(event => event === "audio:close").length, 1);
        assert.equal(mounted.frames.size, 0);
        assert.equal(mounted.listeners.size, 0);
        assert.equal(mounted.warnings.length, rejectClose ? 1 : 0);
    }
});

test("reduced motion starts no Effects audio, frames or resize listeners", async () => {
    const mounted = mountEffects(true);
    await setImmediate();
    assert.deepEqual(mounted.events, []);
    assert.equal(mounted.frames.size, 0);
    assert.equal(mounted.listeners.size, 0);
    assert.equal(mounted.cleanup, undefined);
});

test("the main video plays once without controls and cleans up after ending, Escape or its thirty-second fallback", () => {
    for (const finish of ["ended", "escape", "timeout"]) {
        const timers = new Map<number, () => void>();
        const listeners = new Map<string, (event: { key: string; }) => void>();
        const videos: Record<string, unknown>[] = [];
        let effect: (() => () => void) | undefined;
        let closes = 0;
        const Player = runInNewContext(`${declaration("CelebrationPlayer")}\nCelebrationPlayer;`, {
            useState: (initial: unknown) => [initial, () => {}],
            useEffect: (callback: typeof effect) => { effect = callback; },
            setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 30_000); timers.set(1, callback); return 1; },
            clearTimeout: (id: number) => { assert.ok(timers.delete(id)); },
            document: {
                addEventListener: (name: string, callback: (event: { key: string; }) => void) => listeners.set(name, callback),
                removeEventListener: (name: string, callback: (event: { key: string; }) => void) => {
                    assert.equal(listeners.get(name), callback);
                    listeners.delete(name);
                }
            },
            React: { createElement: (type: unknown, props: Record<string, unknown>) => { if (type === "video") videos.push(props); return null; } },
            Effects: "Effects", Button: "Button", videoUrl: "fixture.mp4"
        });
        Player({ onClose: () => closes++ });
        assert.equal(videos.length, 4);
        assert.equal(videos.filter(video => video.muted).length, 3);
        assert.equal(videos.filter(video => video.muted && video.loop).length, 3);
        assert.ok(videos.every(video => !video.controls));
        const main = videos.find(video => typeof video.onEnded === "function");
        assert.ok(main);
        assert.ok(!main.loop);
        assert.equal(main.onTimeUpdate, undefined);
        assert.equal(main.disablePictureInPicture, true);
        assert.equal(main.disableRemotePlayback, true);
        assert.ok(effect);
        const cleanup = effect();
        const keydown = listeners.get("keydown");
        assert.ok(keydown);
        keydown({ key: "Enter" });
        assert.equal(closes, 0);
        if (finish === "ended") {
            const ended = main.onEnded;
            assert.equal(typeof ended, "function");
            if (typeof ended !== "function") throw new Error("Missing ended callback.");
            ended();
        } else if (finish === "escape") keydown({ key: "Escape" });
        else {
            const timeout = timers.get(1);
            assert.ok(timeout);
            timeout();
        }
        assert.equal(closes, 1);
        cleanup();
        assert.equal(timers.size, 0);
        assert.equal(listeners.size, 0);
    }
});
