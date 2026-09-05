/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync(new URL("../src/utils/react.tsx", import.meta.url), "utf8");
interface Target { visible: boolean; }
type Ref = (target: Target | null) => void;

function fixture() {
    let isIntersecting = false;
    let previousRef: Ref | undefined;
    let previousTarget: Target | null = null;
    let memo: { callback: Ref; deps: unknown[]; } | undefined;
    const metrics = { observers: 0, disconnects: 0, layoutReads: 0 };
    const instances: Observer[] = [];
    class Observer {
        target?: Target;
        disconnected = false;
        constructor(readonly callback: (entries: { target: Target; isIntersecting: boolean; }[]) => void) {
            metrics.observers++;
            instances.push(this);
        }
        observe(target: Target) { this.target = target; }
        disconnect() { this.disconnected = true; metrics.disconnects++; }
        notify(visible: boolean) {
            assert.ok(this.target);
            assert.equal(this.disconnected, false);
            this.callback([{ target: this.target, isIntersecting: visible }]);
        }
    }
    const observerRef = { current: null as Observer | null };
    const common = {
        React: {
            useRef: () => observerRef,
            useCallback(callback: Ref, deps: unknown[]) {
                if (!memo || deps.some((value, i) => !Object.is(value, memo?.deps[i]))) memo = { callback, deps };
                return memo.callback;
            }
        },
        useState: () => [isIntersecting, (value: boolean) => { isIntersecting = value; }]
    };
    const mocks: Record<string, object> = {
        "@webpack/common": common,
        "./lazyReact": {},
        "./misc": { checkIntersecting: (target: Target) => { metrics.layoutReads++; return target.visible; } }
    };
    const exports = {} as { useIntersection(mode: boolean): [Ref, boolean]; };
    runInNewContext(transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText, {
        exports, IntersectionObserver: Observer,
        require(name: string) { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return {
        metrics, instances,
        render(target: Target | null, intersectOnly = false) {
            const [ref] = exports.useIntersection(intersectOnly);
            if (previousRef !== ref || previousTarget !== target) {
                previousRef?.(null);
                if (target) ref(target);
            }
            previousRef = ref;
            previousTarget = target;
            return isIntersecting;
        },
        unmount() { previousRef?.(null); }
    };
}

test("unchanged intersection refs avoid observer and layout work across 100 renders", () => {
    const { render, unmount, metrics } = fixture();
    const target = { visible: false };
    for (let i = 0; i < 100; i++) assert.equal(render(target), false);
    assert.deepEqual(metrics, { observers: 1, disconnects: 0, layoutReads: 1 });
    unmount();
    assert.equal(metrics.disconnects, 1);
});

test("intersection refs observe replacement elements and disconnect on unmount", () => {
    const { render, unmount, instances, metrics } = fixture();
    render({ visible: false });
    const replacement = { visible: true };
    assert.equal(render(replacement), true);
    assert.equal(instances[0].disconnected, true);
    assert.equal(instances[1].target, replacement);
    instances[1].notify(false);
    assert.equal(render(replacement), false);
    unmount();
    assert.deepEqual(metrics, { observers: 2, disconnects: 2, layoutReads: 2 });
});

test("intersection mode changes reattach refs and stop one-shot observers after visibility", () => {
    const { render, unmount, instances, metrics } = fixture();
    const target = { visible: false };
    render(target);
    render(target, true);
    assert.equal(instances[0].disconnected, true);
    instances[1].notify(true);
    assert.equal(render(target, true), true);
    assert.equal(instances[1].disconnected, true);
    assert.equal(metrics.observers, 2);
    render(target, false);
    instances[2].notify(false);
    assert.equal(render(target), false);
    unmount();
    assert.deepEqual(metrics, { observers: 3, disconnects: 3, layoutReads: 3 });
});

test("one-shot intersection refs skip observation for already visible elements", () => {
    const { render, unmount, metrics } = fixture();
    const target = { visible: true };
    assert.equal(render(target, true), true);
    assert.equal(render(target, true), true);
    unmount();
    assert.deepEqual(metrics, { observers: 0, disconnects: 0, layoutReads: 1 });
});
