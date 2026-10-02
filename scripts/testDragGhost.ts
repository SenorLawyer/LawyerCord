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

interface GhostState { visible: boolean; x: number; y: number; }
interface Element { type: unknown; props: Record<string, unknown>; }
interface Ghost {
    mountGhost(): void;
    unmountGhost(): void;
    showGhost(state: object, position?: { x: number; y: number; }): void;
    scheduleGhostPosition(x: number, y: number): void;
}

function fixture() {
    const path = process.env.AUDIT_DRAG_GHOST_SOURCE ?? "src/equicordplugins/dragify/ghost.tsx";
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    let snapshot: GhostState | undefined;
    let updates = 0;
    let tree: Element | undefined;
    let cleanup: (() => void) | undefined;
    const frames = new Map<number, () => void>();
    let frameId = 0;
    const effects: (() => void)[] = [];
    const selectors: (() => unknown)[] = [];
    const dependencies: (unknown[] | undefined)[] = [];
    const voice = { getVoiceStateForUser: (id: string) => ({ channelId: "voice", id }) };
    const sync = (subscribe: (listener: () => void) => () => void, get: () => GhostState) => {
        cleanup?.(); snapshot = get(); cleanup = subscribe(() => { snapshot = get(); updates++; }); return snapshot;
    };
    const modules: Record<string, unknown> = {
        "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@utils/css": { classNameFactory: (prefix: string) => (name: string) => prefix + name },
        "@utils/misc": { classes: (...values: string[]) => values.join(" ") },
        "@webpack/common": {
            React: { useSyncExternalStore: sync },
            createRoot: () => ({ render: (element: Element) => { tree = element; }, unmount: () => { cleanup?.(); for (const effect of effects) effect(); } }),
            useState: (initial: GhostState) => { snapshot = initial; return [initial, (next: GhostState) => { snapshot = next; updates++; }]; },
            useEffect: (effect: () => () => void) => effects.push(effect()),
            useStateFromStores: (_stores: unknown[], select: () => unknown, deps?: unknown[]) => { selectors.push(select); dependencies.push(deps); return select(); }, VoiceStateStore: voice
        },
        "react/jsx-runtime": { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) }
    };
    const exports = {};
    runInNewContext(outputText, {
        exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        document: { body: { appendChild() {} }, createElement: () => ({ isConnected: true, remove() {} }) },
        requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: (id: number) => frames.delete(id), clearTimeout() {}, window: { setTimeout: () => 1 }
    });
    const ghost = exports as Ghost;
    ghost.mountGhost(); assert.ok(tree);
    const boundary = tree.props.children as Element;
    const component = boundary.props.children as Element;
    const render = component.type as () => unknown;
    render();
    return { ghost, render, selectors, dependencies,
        get snapshot() { return snapshot; }, get updates() { return updates; }, get frames() { return frames.size; },
        flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); }
    };
}

test("Dragify shows its initial position immediately and coalesces movement into one snapshot per frame", () => {
    const f = fixture();
    f.ghost.showGhost({ kind: "user", title: "User", entityId: "first", exiting: false }, { x: 5, y: 10 });
    assert.equal(f.snapshot?.visible, true); assert.equal(f.snapshot.x, 5); assert.equal(f.snapshot.y, 10);
    f.flush();
    const before = f.updates;
    for (let i = 1; i <= 100; i++) f.ghost.scheduleGhostPosition(i, i + 1);
    assert.equal(f.updates, before); assert.equal(f.frames, 1);
    f.flush(); assert.equal(f.updates, before + 1); assert.equal(f.snapshot?.x, 100); assert.equal(f.snapshot?.y, 101);
    f.ghost.scheduleGhostPosition(100, 101); f.flush(); assert.equal(f.updates, before + 1);
    f.ghost.scheduleGhostPosition(300, 301);
    f.ghost.showGhost({ kind: "channel", title: "Channel", entityId: "channel", exiting: false }, { x: 20, y: 21 });
    f.flush(); assert.equal(f.snapshot?.x, 20); assert.equal(f.snapshot?.y, 21);
    f.ghost.scheduleGhostPosition(200, 201); f.ghost.unmountGhost(); assert.equal(f.frames, 0);
    const stopped = f.updates; f.flush(); assert.equal(f.updates, stopped);
});

test("Dragify voice selector follows ghost replacement and excludes an invisible user", () => {
    const f = fixture();
    assert.equal(f.selectors[0](), null);
    f.ghost.showGhost({ kind: "user", title: "User", entityId: "first", exiting: false }); f.render();
    const first = f.selectors.at(-1); assert.ok(first); assert.equal((first() as { id: string; }).id, "first");
    f.ghost.showGhost({ kind: "user", title: "User", entityId: "second", exiting: false }); f.render();
    const second = f.selectors.at(-1); assert.ok(second); assert.equal((second() as { id: string; }).id, "second");
    assert.ok(f.dependencies.at(-1)?.includes("second"));
    f.ghost.unmountGhost(); f.render(); const hidden = f.selectors.at(-1); assert.ok(hidden); assert.equal(hidden(), null);
});
