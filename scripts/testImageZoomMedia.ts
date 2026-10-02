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

interface Element { type: string; props: Record<string, unknown>; children: Element[]; }
interface Video { currentTime: number; src: string; pause(): void; }

function fixture(animated: boolean) {
    let cursor = 0;
    let bounds = 0;
    let paused = 0;
    let frameId = 0;
    const frames = new Map<number, () => void>();
    const states: unknown[] = [];
    const refs: { current: unknown; }[] = [];
    const effects = new Map<number, (() => void) | undefined>();
    const pendingEffects: (() => void)[] = [];
    const listeners = new Map<string, (event: object) => void>();
    const originalVideo = { currentTime: 37, src: "https://media.discordapp.net/original.webm", addEventListener() {}, removeEventListener() {} };
    const video: Video = { currentTime: 0, src: originalVideo.src, pause() { paused++; } };
    const settings = { zoom: 2, size: 100, invertScroll: false, zoomSpeed: 0.5, saveZoomValues: false };
    const image = { setAttribute() {} };
    const element = { getBoundingClientRect() { bounds++; return { left: 0, top: 0, width: 100, height: 80 }; },
        querySelector: (query: string) => query === "video" ? originalVideo : image };
    const createElement = (type: string, props: Record<string, unknown>, ...children: Element[]): Element => ({ type, props, children });
    const modules: Record<string, unknown> = {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@plugins/imageZoom": { settings: { store: settings } }, "@plugins/imageZoom/constants": { ELEMENT_ID: "modal" },
        "@plugins/imageZoom/utils/waitFor": { waitFor: (condition: () => boolean, ready: () => void) => { if (condition()) ready(); return () => {}; } },
        "@utils/css": { classNameFactory: () => () => "lens" },
        "@webpack/common": { FluxDispatcher: { dispatch() {} },
            useState: (initial: unknown) => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], (value: unknown) => { states[index] = value; }]; },
            useRef: (initial: unknown) => { const index = cursor++; return refs[index] ??= { current: initial }; },
            useMemo: (create: () => unknown) => { cursor++; return create(); },
            useCallback: (callback: unknown) => { const index = cursor++; return states[index] ??= callback; },
            useLayoutEffect: (effect: () => (() => void), _deps: unknown[]) => { const index = cursor++; if (!effects.has(index)) { effects.set(index, undefined); pendingEffects.push(() => effects.set(index, effect())); } }
        }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_IMAGE_ZOOM_SOURCE ?? "src/plugins/imageZoom/components/Magnifier.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const api = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, URL, React: { createElement },
        requestAnimationFrame: (callback: () => void) => { const id = ++frameId; frames.set(id, callback); return id; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        document: { getElementById: (id: string) => id === "modal" ? element : null,
            addEventListener: (name: string, callback: (event: object) => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name) },
        require: (name: string) => { assert.ok(name in modules, name); return modules[name]; }
    }) as { Magnifier(props: object): Element | null; };
    const instance = { props: { animated, src: "https://media.discordapp.net/attachments/1/image.png" }, state: { readyState: "READY", mouseOver: true, mouseDown: true } };
    return { video, originalVideo, settings, instance,
        render() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } cursor = 0; const result = api.Magnifier({ instance, zoom: 2, size: 100 }); for (const effect of pendingEffects.splice(0)) effect(); return result; },
        event(name: string, event: object = { button: 0, pageX: 50, pageY: 40, x: 50, y: 40 }) { const listener = listeners.get(name); assert.ok(listener); listener(event); },
        unmount() { for (const cleanup of effects.values()) cleanup?.(); },
        counts: () => ({ bounds, paused, listeners: listeners.size }) };
}

function media(tree: Element): Element {
    const result = tree.children.find(child => child?.type === "video" || child?.type === "img");
    assert.ok(result);
    return result;
}

test("Hidden zoom lenses mount neither duplicate media nor a bounding-box read", () => {
    for (const animated of [false, true]) {
        const f = fixture(animated);
        f.render();
        for (let i = 0; i < 100; i++) assert.equal(f.render(), null);
        assert.equal(f.counts().bounds, 0);
        f.unmount();
        assert.equal(f.counts().listeners, 0);
    }
});

test("Visible zoom videos keep their source, synchronize after metadata and pause on removal", () => {
    const f = fixture(true);
    f.render();
    f.event("mousedown");
    const visible = f.render();
    assert.ok(visible);
    const videoElement = media(visible);
    assert.equal(videoElement.props.src, f.originalVideo.src);
    assert.equal(videoElement.props.autoPlay, true);
    const ref = videoElement.props.ref as ((video: Video | null) => void) | { current: Video | null; };
    assert.equal(typeof ref, "function");
    if (typeof ref !== "function") return;
    ref(f.video);
    const loaded = videoElement.props.onLoadedMetadata as () => void;
    loaded();
    assert.equal(f.video.currentTime, 37);
    f.event("mouseup");
    assert.equal(f.render(), null);
    ref(null);
    assert.equal(f.counts().paused, 1);
    f.unmount();
    assert.equal(f.counts().listeners, 0);
});

test("Visible image lenses preserve scale and scroll changes while hidden lenses release the image", () => {
    const f = fixture(false);
    f.render();
    f.event("mousedown");
    const visible = f.render();
    assert.ok(visible);
    assert.equal(media(visible).props.width, "200px");
    assert.equal(media(visible).props.height, "160px");
    f.event("wheel", { deltaY: 100, pageX: 50, pageY: 40, x: 50, y: 40 });
    const zoomed = f.render();
    assert.ok(zoomed);
    assert.equal(media(zoomed).props.width, "250px");
    f.event("mouseup");
    assert.equal(f.render(), null);
});
