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

interface Node {
    type: string | ((props: Record<string, unknown>) => Node);
    props: Record<string, unknown>;
    children: Node[];
}

function fixture(token: string | null = "handshake") {
    let cursor = 0;
    let aborts = 0;
    let controllers = 0;
    let sequence = 0;
    let account = "first";
    let closes = 0;
    const controller = new AbortController();
    const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void; }[] = [];
    const effects: (() => void)[] = [];
    const timers = new Map<number, { callback: () => void; duration: number; }>();
    const frames = new Map<number, () => void>();
    const requests: { resolve: () => void; reject: () => void; body: unknown; }[] = [];
    const React = {
        createElement: (type: Node["type"], props: Node["props"], ...children: Node[]) => ({ type, props: props ?? {}, children }),
        useState: (value: unknown) => {
            const index = cursor++;
            slots[index] ??= { value };
            return [slots[index].value, (next: unknown) => { slots[index].value = next; }];
        },
        useRef: (value: unknown) => {
            const index = cursor++;
            slots[index] ??= { value: { current: value } };
            return slots[index].value;
        },
        useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
            const index = cursor++;
            if (!slots[index] || deps.some((value, i) => !Object.is(value, slots[index].deps?.[i])))
                effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
        }
    };
    const mocks: Record<string, unknown> = {
        "@components/BaseText": { BaseText: "text" }, "@components/Button": { Button: "button", TextButton: "text-button" },
        "@equicordplugins/loginWithQR/images": { images: { deviceImage: {} } },
        "@utils/discord": { getIntlMessage: (name: string) => name },
        "@webpack": { findByPropsLazy: () => ({ Controller: class {
            constructor() { controllers++; }
            start() {} get() { return { progress: "0%" }; }
        } }) },
        "@webpack/common": { ...React, UserStore: { getCurrentUser: () => ({ id: account }) }, Modal: "modal", openModal: (factory: (props: Node["props"]) => Node) => factory({ onClose: () => { closes++; } }),
            RestAPI: { post: ({ body }: { body: unknown; }) => new Promise<void>((resolve, reject) => requests.push({ body, resolve, reject: () => reject(new Error("Request failure")) })) } },
        "..": { cl: (...values: unknown[]) => values.filter(Boolean).join(" ") }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_QR_CONFIRM_SOURCE ?? "src/equicordplugins/loginWithQR/ui/modals/VerifyModal.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { default: open } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, React,
        setTimeout: (callback: () => void, duration: number) => { timers.set(++sequence, { callback, duration }); return sequence; },
        clearTimeout: (id: number) => timers.delete(id),
        requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: (id: number) => frames.delete(id),
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const node = open(token, (confirmed: boolean) => { if (!confirmed) aborts++; }, controller.signal, "first");
    const Component = node.type;
    if (typeof Component !== "function") throw new Error("Missing verification component.");
    let button: Node | undefined;
    const walk = (node: Node | undefined) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "button" && node.props.onPointerDown) {
            button = node;
            if (node.props.ref) (node.props.ref as { current: unknown; }).current = { style: { setProperty() {} } };
        }
        node.children.forEach(walk);
    };
    const event = { button: 0, isPrimary: true, pointerId: 1, currentTarget: { setPointerCapture() {} } };
    const invoke = (name: string, value: unknown = event) => { const callback = button?.props[name]; assert.equal(typeof callback, "function", name); (callback as (event: unknown) => void)(value); };
    return { timers, frames, requests, aborts: () => aborts, controllers: () => controllers,
        render() { cursor = 0; button = undefined; const result = Component(node.props); walk(result); effects.splice(0).forEach(effect => effect()); return result; },
        press() { invoke("onPointerDown"); }, release() { invoke("onPointerUp"); }, cancel() { invoke("onPointerCancel"); }, blur() { invoke("onBlur"); }, loseCapture() { invoke("onLostPointerCapture"); },
        keyDown(key: string, repeat = false) { invoke("onKeyDown", { key, repeat, preventDefault() {} }); },
        keyUp(key: string) { invoke("onKeyUp", { key, preventDefault() {} }); },
        abort() { controller.abort(); }, closes: () => closes,
        switchAccount() { account = "second"; },
        tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(({ callback }) => callback()); },
        unmount() { slots.forEach(slot => slot?.cleanup?.()); }
    };
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("QR confirmation does not schedule an idle frame loop or construct animation controllers", () => {
    const f = fixture();
    f.render();
    f.render();
    assert.equal(f.controllers(), 0);
    assert.equal(f.frames.size, 0);
    f.unmount();
    assert.equal(f.frames.size, 0);
    assert.equal(f.aborts(), 1);
});

test("QR hold cancellation survives rerenders and modal close", () => {
    for (const action of ["release", "cancel", "blur", "loseCapture", "unmount"] as const) {
        const f = fixture();
        f.render();
        f.press();
        assert.equal(f.timers.size, 1);
        assert.equal([...f.timers.values()][0].duration, 1250);
        f.render();
        f[action]();
        f.tick();
        assert.equal(f.requests.length, 0, action);
        assert.equal(f.timers.size, 0);
    }
});

test("successful QR confirmation is retained by the modal cleanup", async () => {
    const f = fixture();
    f.render();
    f.press();
    f.tick();
    f.requests[0].resolve();
    await settle();
    f.render();
    f.unmount();
    assert.equal(f.aborts(), 0);
});

test("QR login submits once after a full hold and successful close does not cancel the handshake", async () => {
    const f = fixture();
    f.render();
    f.press();
    f.press();
    assert.equal(f.timers.size, 1);
    f.tick();
    f.render();
    f.press();
    f.tick();
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(f.requests[0].body), JSON.stringify({ handshake_token: "handshake" }));
    f.requests[0].resolve();
    await settle();
    f.render();
    f.unmount();
    assert.equal(f.aborts(), 0);
});

test("closing during a QR request cancels the handshake and ignores its late completion", async () => {
    const f = fixture();
    f.render();
    f.press();
    f.tick();
    f.unmount();
    assert.equal(f.aborts(), 1);
    f.requests[0].resolve();
    await settle();
    assert.equal(f.aborts(), 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.frames.size, 0);
});

test("failed QR confirmation shows failure and missing handshakes never submit", async () => {
    const f = fixture();
    f.render();
    f.press();
    f.tick();
    f.requests[0].reject();
    await settle();
    const result = f.render();
    assert.ok(JSON.stringify(result).includes("QR_CODE_NOT_FOUND"));
    f.unmount();
    assert.equal(f.aborts(), 1);
    const missing = fixture(null);
    missing.render();
    missing.tick();
    assert.equal(missing.requests.length, 0);
    assert.equal(missing.frames.size, 0);
});

test("keyboard confirmation requires a full hold and ignores key repeats", async () => {
    for (const key of [" ", "Enter"]) {
        const f = fixture(); f.render();
        f.keyDown(key); f.keyUp(key); f.tick();
        assert.equal(f.requests.length, 0);
        f.keyDown(key); f.keyDown(key, true);
        assert.equal(f.timers.size, 1);
        f.tick();
        assert.equal(f.requests.length, 1);
        f.requests[0].resolve(); await settle(); f.unmount();
        assert.equal(f.aborts(), 0);
    }
});

test("aborted QR scans close verification and account changes invalidate a pending hold", () => {
    const f = fixture(); f.render(); f.press(); f.abort(); f.tick();
    assert.equal(f.closes(), 1);
    assert.equal(f.requests.length, 0);
    f.unmount(); assert.equal(f.aborts(), 1);
    const changed = fixture(); changed.render(); changed.press(); changed.switchAccount(); changed.tick();
    assert.equal(changed.requests.length, 0);
    changed.unmount();
});

test("QR confirmation cannot apply a response from the preceding account", async () => {
    const f = fixture(); f.render(); f.press(); f.tick(); f.switchAccount();
    f.requests[0].resolve(); await settle();
    assert.ok(!JSON.stringify(f.render()).includes("QR_CODE_LOGIN_SUCCESS"));
    f.unmount(); assert.equal(f.aborts(), 1);
});
