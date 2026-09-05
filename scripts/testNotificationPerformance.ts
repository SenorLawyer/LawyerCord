/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const filename = "src/api/Notifications/NotificationComponent.tsx";
const root = fileURLToPath(new URL("../", import.meta.url));

test("notification dismissal releases the queue even if the caller's callback throws", async () => {
    const source = readFileSync(new URL("../src/api/Notifications/Notifications.tsx", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("function _showNotification"), source.indexOf("function shouldBeNative"));
    const { outputText } = transpileModule(code, {
        compilerOptions: { target: ScriptTarget.ES2022, jsx: 2 }, fileName: "Notifications.tsx"
    });
    let rendered: { onClose(): void; } | null = null;
    let cleared = false;
    const show = runInNewContext(`${outputText}\n_showNotification;`, {
        NotificationComponent: "fixture",
        React: { createElement: (_type: unknown, props: { onClose(): void; }) => props },
        getRoot: () => ({ render(props: typeof rendered) { rendered = props; if (props === null) cleared = true; } })
    });
    const error = new Error("Caller callback failed");
    let settled = false;
    const pending = show({ onClose() { throw error; } }, 1).then(() => { settled = true; });
    const notification = rendered as { onClose(): void; } | null;
    assert.ok(notification);
    assert.throws(() => notification.onClose(), error);
    await setImmediate();
    assert.equal(cleared, true);
    assert.equal(settled, true);
    await pending;
});

interface Element {
    props: Record<string, unknown>;
    children: unknown[];
}

interface Effect {
    deps: readonly unknown[];
    cleanup?: () => void;
}

interface Animation {
    currentTime: number;
    duration: number;
    paused: boolean;
    cancelled: boolean;
    pause(): void;
    cancel(): void;
}

function fixture(source: string, timeout = 5000, permanent = false) {
    let now = 0;
    let cursor = 0;
    let nextTimer = 0;
    let dirty = false;
    let mounted = true;
    let element: Element;
    const slots: unknown[] = [];
    const effects = new Map<number, Effect>();
    const pending: (() => void)[] = [];
    const timers = new Map<number, { at: number; interval?: number; callback: () => void; }>();
    const animations: Animation[] = [];
    const settings = { notifications: { timeout, position: "bottom-right" } };
    const metrics = { timerCallbacks: 0, stateUpdates: 0, renders: 0, closedAt: null as number | null };
    const props = { title: "Fixture", body: "Notification performance fixture", permanent, onClose: close };

    function unmount() {
        mounted = false;
        effects.forEach(effect => effect.cleanup?.());
    }

    function close() {
        metrics.closedAt = now;
        unmount();
    }

    function schedule(callback: () => void, delay: number, interval?: number) {
        const id = ++nextTimer;
        timers.set(id, { at: now + Math.max(0, delay), interval, callback });
        return id;
    }

    const common = {
        React: { createElement: (_type: unknown, props: Element["props"] | null, ...children: unknown[]): Element => ({ props: props ?? {}, children }) },
        useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void] {
            const index = cursor++;
            if (!(index in slots)) slots[index] = initial;
            return [slots[index] as T, next => {
                const value = typeof next === "function" ? (next as (previous: T) => T)(slots[index] as T) : next;
                if (Object.is(slots[index], value)) return;
                slots[index] = value;
                metrics.stateUpdates++;
                dirty = true;
            }];
        },
        useRef<T>(initial: T) {
            const index = cursor++;
            if (!(index in slots)) slots[index] = { current: initial };
            return slots[index];
        },
        useEffect(callback: () => void | (() => void), deps: readonly unknown[]) {
            const index = cursor++;
            const previous = effects.get(index);
            if (previous && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
            pending.push(() => {
                previous?.cleanup?.();
                effects.set(index, { deps, cleanup: callback() || undefined });
            });
        },
    };
    const progress = {
        animate(keyframes: { transform: string; }[], options: { duration: number; }) {
            assert.equal(keyframes[0].transform, "scaleX(1)");
            assert.equal(keyframes[1].transform, "scaleX(0)");
            const animation: Animation = {
                currentTime: 0, duration: options.duration, paused: false, cancelled: false,
                pause() { this.paused = true; },
                cancel() { this.cancelled = true; },
            };
            animations.push(animation);
            return animation;
        },
    };
    const mocks: Record<string, object> = {
        "./styles.css": {},
        "@api/Settings": { useSettings: () => settings },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@utils/misc": { classes: (...names: string[]) => names.filter(Boolean).join(" ") },
        "@webpack/common": common,
    };
    const module = { exports: {} as { default?: (props: object) => Element; } };
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: 2 }, fileName: filename,
    });
    runInNewContext(outputText, {
        module, exports: module.exports, Date: { now: () => now },
        setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
        setInterval: (callback: () => void, interval: number) => schedule(callback, interval, interval),
        clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id),
        require(name: string) {
            assert.ok(name in mocks, `Unexpected import: ${name}`);
            return mocks[name];
        },
    });
    const Component = module.exports.default;
    assert.ok(Component);

    function attachRefs(node: unknown) {
        if (!node || typeof node !== "object" || !("props" in node) || !("children" in node)) return;
        const { props, children } = node as Element;
        if (props.ref && typeof props.ref === "object" && "current" in props.ref) props.ref.current = progress;
        children.forEach(attachRefs);
    }

    function render() {
        assert.ok(Component);
        assert.ok(mounted);
        dirty = false;
        cursor = 0;
        metrics.renders++;
        element = Component(props);
        attachRefs(element);
        pending.splice(0).forEach(effect => effect());
    }

    function advance(ms: number) {
        const end = now + ms;
        for (;;) {
            const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.interval) timer.at += timer.interval;
            else timers.delete(id);
            metrics.timerCallbacks++;
            timer.callback();
            if (dirty && mounted) render();
        }
        now = end;
    }

    function hover(value: boolean) {
        const handler = element.props[value ? "onMouseEnter" : "onMouseLeave"];
        assert.equal(typeof handler, "function");
        (handler as () => void)();
        if (dirty) render();
    }

    render();
    return { settings, props, metrics, animations, timers, advance, hover, render, unmount };
}

function workloads(source: string) {
    const normal = fixture(source);
    normal.advance(4999);
    assert.equal(normal.metrics.closedAt, null);
    normal.advance(1);
    assert.equal(normal.metrics.closedAt, 5000);
    assert.equal(normal.timers.size, 0);

    const hover = fixture(source);
    hover.advance(1200);
    hover.hover(true);
    hover.advance(7000);
    assert.equal(hover.metrics.closedAt, null);
    hover.hover(false);
    hover.advance(3799);
    assert.equal(hover.metrics.closedAt, null);
    hover.advance(1);
    assert.equal(hover.metrics.closedAt, 12000);
    assert.equal(hover.timers.size, 0);
    return { default5s: normal.metrics, hover7s: hover.metrics };
}

const source = readFileSync(new URL(`../${filename}`, import.meta.url), "utf8");
const after = workloads(source);
assert.deepEqual(after.default5s, { timerCallbacks: 1, stateUpdates: 0, renders: 1, closedAt: 5000 });
assert.deepEqual(after.hover7s, { timerCallbacks: 1, stateUpdates: 2, renders: 3, closedAt: 12000 });

const changed = fixture(source);
changed.advance(2000);
changed.settings.notifications.timeout = 3000;
changed.render();
assert.equal(changed.animations.at(-1)?.currentTime, 2000);
assert.equal(changed.animations.at(-1)?.duration, 3000);
changed.advance(999);
assert.equal(changed.metrics.closedAt, null);
changed.advance(1);
assert.equal(changed.metrics.closedAt, 3000);

const paused = fixture(source);
paused.advance(1200);
paused.hover(true);
assert.equal(paused.animations.at(-1)?.currentTime, 1200);
assert.equal(paused.animations.at(-1)?.paused, true);
paused.advance(7000);
paused.settings.notifications.timeout = 1000;
paused.render();
assert.equal(paused.timers.size, 0);
paused.hover(false);
paused.advance(0);
assert.equal(paused.metrics.closedAt, 8200);

for (const [timeout, permanent] of [[0, false], [5000, true]] as const) {
    const indefinite = fixture(source, timeout, permanent);
    indefinite.advance(10000);
    assert.equal(indefinite.metrics.closedAt, null);
    assert.equal(indefinite.timers.size, 0);
    assert.equal(indefinite.animations.length, 0);
    indefinite.unmount();
}

const disabled = fixture(source);
disabled.advance(1200);
disabled.settings.notifications.timeout = 0;
disabled.render();
assert.equal(disabled.timers.size, 0);
assert.ok(disabled.animations.every(animation => animation.cancelled));
disabled.advance(7000);
assert.equal(disabled.metrics.closedAt, null);
disabled.settings.notifications.timeout = 5000;
disabled.render();
disabled.advance(0);
assert.equal(disabled.metrics.closedAt, 8200);

const cleanup = fixture(source);
cleanup.advance(1200);
cleanup.unmount();
cleanup.advance(10000);
assert.equal(cleanup.metrics.closedAt, null);
assert.equal(cleanup.timers.size, 0);
assert.ok(cleanup.animations.every(animation => animation.cancelled));

const callback = fixture(source);
callback.advance(1000);
let replacementCalls = 0;
callback.props.onClose = () => { replacementCalls++; callback.unmount(); };
callback.render();
callback.advance(4000);
assert.equal(replacementCalls, 1);
assert.equal(callback.metrics.closedAt, null);

const baseline = process.argv.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
if (baseline) {
    const before = workloads(execFileSync("git", ["show", `${baseline}:${filename}`], { cwd: root, encoding: "utf8" }));
    console.log(JSON.stringify({ measurement: "Actual notification component with mocked hooks, animation and deterministic clock; counts are not browser CPU timings", baseline, before, after }, null, 2));
} else {
    console.log("Notification performance checks passed: one dismissal callback, zero periodic state updates, hover/timeout/cleanup preserved.");
}
