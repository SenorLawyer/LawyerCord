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

test("Song preview releases playback and global references when its node unmounts", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/songSpotlight.desktop/ui/components/AudioPlayer.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const effects: Array<() => void> = [];
    const refs: Array<{ current: unknown }> = [];
    const audioRef = { current: undefined };
    const common = {
        useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => { const ref = { current }; refs.push(ref); return ref; },
        useEffect: (fn: () => void) => effects.push(fn)
    };
    const api = runInNewContext(`${source};({Player:exports.default, playing:()=>globalPlaying})`, {
        exports: {}, queueMicrotask, require: (name: string) => name === "@webpack/common" ? common : { __esModule: true, default: { store: { previewVolume: 100 } } },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) }
    });
    const tree = api.Player({ audioRef, list: [{ audio: { previewUrl: "https://example.com/preview" } }], playing: 0, setPlaying: () => {}, setLoadedAudio: () => {} });
    const { handleRef, handleLoaded } = tree.children[0][0].props;
    let pauses = 0;
    const node = { paused: false, pause: () => { pauses++; }, play: () => Promise.resolve() };
    handleRef(0, node);
    handleLoaded(0, true);
    effects.forEach(fn => fn());
    assert.equal(api.playing(), node);
    handleRef(0, null);
    await Promise.resolve();
    assert.equal(pauses, 1);
    assert.equal(api.playing(), undefined);
    assert.equal(audioRef.current, undefined);
    assert.equal((refs[1].current as Set<number>).size, 0);
});

test("Song preview recognizes a loaded node after callback ref reattachment", () => {
    const source = readFileSync("src/equicordplugins/songSpotlight.desktop/ui/components/AudioPlayer.tsx", "utf8");
    const start = source.indexOf("    const handleRef = ");
    const end = source.indexOf("    const handleLoaded = ", start);
    const node = { readyState: 4, pause() {}, addEventListener() {}, removeEventListener() {} };
    const loaded = { current: new Set([0]) };
    const nodes = { current: new Map([[0, node]]) };
    const handleRef = runInNewContext(transpileModule(source.slice(start, end), {
        compilerOptions: { target: ScriptTarget.ES2022 }
    }).outputText + "\nhandleRef;", {
        queueMicrotask, loaded, nodes, nodeEvents: { current: new Map() },
        audios: [{ previewUrl: "unchanged" }], audioRef: { current: node },
        globalPlaying: node, useCallback: (fn: unknown) => fn
    });
    handleRef(0, null);
    assert.equal(loaded.current.has(0), false);
    handleRef(0, node);
    assert.equal(loaded.current.has(0), true);
    assert.equal(nodes.current.get(0), node);
});

test("Refreshing a retained preview does not emit pause or clear playing state", async () => {
    const source = transpileModule(readFileSync("src/equicordplugins/songSpotlight.desktop/ui/components/AudioPlayer.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const effects: Array<() => void> = [];
    const refs: Array<{ current: unknown }> = [];
    let refIndex = 0;
    let selected: number | undefined = 0;
    let pauses = 0;
    let plays = 0;
    const audioRef = { current: undefined };
    const common = {
        useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useRef: (current: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
        useEffect: (fn: () => void) => effects.push(fn)
    };
    const api = runInNewContext(source + "\n({Player:exports.default, playing:()=>globalPlaying})", {
        exports: {}, queueMicrotask,
        require: (name: string) => name === "@webpack/common" ? common : { __esModule: true, default: { store: { previewVolume: 100 } } },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) }
    });
    function render() {
        refIndex = 0;
        effects.length = 0;
        return api.Player({ audioRef, list: [{ audio: { previewUrl: "unchanged" } }], playing: selected, setPlaying: (value: number | undefined) => { selected = value; }, setLoadedAudio() {} }).children[0][0].props;
    }
    const first = render();
    const node = {
        readyState: 4, paused: true,
        pause() { pauses++; this.paused = true; first.handleStopped(0); },
        play() { plays++; this.paused = false; return Promise.resolve(); }
    };
    first.handleRef(0, node);
    effects.forEach(fn => fn());
    const refreshed = render();
    first.handleRef(0, null);
    refreshed.handleRef(0, node);
    effects.forEach(fn => fn());
    await Promise.resolve();
    assert.equal(pauses, 0);
    assert.equal(plays, 1);
    assert.equal(selected, 0);
    assert.equal(api.playing(), node);
    assert.equal(audioRef.current, node);
    refreshed.handleRef(0, null);
    await Promise.resolve();
    assert.equal(pauses, 1);
    assert.equal(api.playing(), undefined);
    assert.equal(audioRef.current, undefined);
});
