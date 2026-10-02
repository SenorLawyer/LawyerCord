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
    let reads = 0;
    let writes = 0;
    let hook = 0;
    let sequence = 0;
    const states: unknown[] = [];
    const refs: { current: unknown; }[] = [];
    const frames = new Map<number, () => void>();
    const listeners = new Map<string, (event: unknown) => void>();
    let cleanup: (() => void) | undefined;
    let effect: (() => () => void) | undefined;
    let deps: unknown[] | undefined;
    const element = { getBoundingClientRect() { reads++; return { left: 10, top: 20, width: 300, height: 200 }; }, querySelector: () => null };
    const common = {
        useState(value: unknown) { const index = hook++; if (!(index in states)) states[index] = value; return [states[index], (next: unknown) => { states[index] = next; writes++; }]; },
        useRef(value: unknown) { const index = hook++; return refs[index] ??= { current: value }; },
        useCallback: (callback: unknown) => callback,
        useMemo: (callback: () => unknown) => callback(),
        useLayoutEffect(callback: () => () => void, next: unknown[]) { if (!deps || next.some((value, index) => value !== deps?.[index])) { effect = callback; deps = next; } },
        FluxDispatcher: { dispatch() {} }
    };
    const modules: Record<string, unknown> = {
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@plugins/imageZoom": { settings: { store: { zoom: 2, size: 100, invertScroll: false, zoomSpeed: 1, saveZoomValues: false } } },
        "@plugins/imageZoom/constants": { ELEMENT_ID: "image" },
        "@plugins/imageZoom/utils/waitFor": { waitFor(_predicate: unknown, callback: () => void) { callback(); return () => {}; } },
        "@utils/css": { classNameFactory: () => () => "lens" },
        "@webpack/common": common
    };
    const source = readFileSync(process.env.AUDIT_MAGNIFIER_SOURCE ?? "src/plugins/imageZoom/components/Magnifier.tsx", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
    interface Node { props: { style: { transform: string; }; }; children: Node[]; }
    const exports = runInNewContext(`${code}\nexports;`, { exports: {}, require: (name: string) => modules[name], URL,
        React: { createElement: (_type: unknown, props: unknown, ...children: unknown[]) => ({ props, children }) },
        document: { getElementById: (id: string) => id === "image" ? element : null,
            addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
            removeEventListener: (name: string, callback: (event: unknown) => void) => { if (listeners.get(name) === callback) listeners.delete(name); } },
        requestAnimationFrame: (callback: () => void) => { const id = ++sequence; frames.set(id, callback); return id; },
        cancelAnimationFrame: (id: number) => frames.delete(id)
    }) as { Magnifier(props: unknown): Node | null; };
    const instance = { state: { mouseOver: true, mouseDown: true, readyState: "READY" }, props: { animated: false, src: "https://example.com/image.png" } };
    function render(owner = instance) {
        hook = 0;
        const node = exports.Magnifier({ instance: owner, size: 100, zoom: 2 });
        if (effect) { cleanup?.(); cleanup = effect(); effect = undefined; }
        return node;
    }
    render();
    writes = 0;
    return { instance, render, frames, listeners, reads: () => reads, writes: () => writes,
        emit(name: string, x = 150, y = 160) { listeners.get(name)?.({ x, y, pageX: x + 5, pageY: y + 7, button: 0, deltaY: 100 }); },
        flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
        unmount() { cleanup?.(); }
    };
}

test("Magnifier coalesces 100 pointer events into one layout read and state update at the final position", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.emit("mousemove", 100 + i, 200 + i);
    assert.equal(f.reads(), 0);
    assert.equal(f.writes(), 0);
    assert.equal(f.frames.size, 1);
    f.flush();
    const node = f.render();
    assert.equal(f.reads(), 1);
    assert.equal(f.writes(), 1);
    assert.equal(node?.props.style.transform, "translate(149px, 249px)");
    assert.equal(node?.children[0].props.style.transform, "translate(-338px, -522px)");
    f.unmount();
});

test("Mouse release, unmount and instance replacement cancel pending magnifier movement", () => {
    const f = fixture();
    f.emit("mousemove");
    f.emit("mouseup");
    assert.equal(f.frames.size, 0);
    f.flush();
    assert.equal(f.render(), null);
    f.emit("mousemove");
    f.render({ ...f.instance });
    assert.equal(f.frames.size, 0);
    assert.equal(f.reads(), 0);
    f.emit("mousemove");
    f.unmount();
    assert.equal(f.frames.size, 0);
    assert.equal(f.listeners.size, 0);
});

test("Wheel zoom uses its latest pointer and scale in the pending frame", () => {
    const f = fixture();
    f.emit("mousemove", 100, 100);
    f.emit("wheel", 150, 160);
    f.flush();
    assert.equal(f.reads(), 1);
    assert.equal(f.writes(), 1);
    assert.equal(f.render()?.children[0].props.style.transform, "translate(-385px, -391px)");
    f.unmount();
});
