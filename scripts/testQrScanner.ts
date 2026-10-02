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

function fixture() {
    let cursor = 0;
    let sequence = 0;
    let account = "first";
    let decodeCount = 0;
    let encodedReads = 0;
    let code = "https://discord.com/ra/fingerprint";
    const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void; }[] = [];
    const effects: (() => void)[] = [];
    const timers = new Map<number, () => void>();
    const listeners = new Map<string, (event: unknown) => void>();
    const urls = new Set<string>();
    const canvases: { width: number; height: number; }[] = [];
    const requests: { url: string; body: unknown; resolve: (result: unknown) => void; reject: () => void; }[] = [];
    const verifications: { token: string | null; complete: (confirmed: boolean) => void; signal?: AbortSignal; accountId?: string; }[] = [];
    const sessions = new Set<AbortController>();
    const plugin = { started: true, qrModalOpen: false };
    const images: { onload: (() => void) | null; onerror: (() => void) | null; src: string; }[] = [];
    const readers: { result: string; callbacks: Map<string, () => void>; }[] = [];
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
        "@components/BaseText": { BaseText: "text" }, "@components/Icons": { QrCodeIcon: "icon" },
        "@components/settings": { wrapTab: (component: unknown) => component },
        "@equicordplugins/loginWithQR": { __esModule: true, default: plugin, scans: sessions },
        "@equicordplugins/loginWithQR/images": { images: { cross: "cross" } },
        "@utils/Logger": { Logger: class { warn() {} } },
        "@webpack/common": { ...React, UserStore: { getCurrentUser: () => ({ id: account }) },
            RestAPI: { post: ({ url, body }: { url: string; body: unknown; }) => new Promise((resolve, reject) => requests.push({ url, body, resolve, reject: () => reject(new Error("Request failed")) })) } },
        jsqr: { __esModule: true, default: () => { decodeCount++; return code ? { data: code, location: {
            topLeftCorner: { x: 20, y: 20 }, topRightCorner: { x: 100, y: 20 }, bottomLeftCorner: { x: 20, y: 100 }, bottomRightCorner: { x: 100, y: 100 }
        } } : null; } },
        "..": { cl: (...values: unknown[]) => values.filter(Boolean).join(" "), Spinner: "spinner", SpinnerTypes: { WANDERING_CUBES: "wanderingCubes" } },
        "./VerifyModal": { __esModule: true, default: (token: string | null, complete: (confirmed: boolean) => void, signal?: AbortSignal, accountId?: string) => verifications.push({ token, complete, signal, accountId }) }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_QR_SCANNER_SOURCE ?? "src/equicordplugins/loginWithQR/ui/modals/QrModal.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { default: Component } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, React, AbortController, DOMException,
        URL: { createObjectURL: () => { const url = `blob:${++sequence}`; urls.add(url); return url; }, revokeObjectURL: (url: string) => urls.delete(url) },
        Image: class {
            width = 3200; height = 1600; src = "";
            onload: (() => void) | null = null; onerror: (() => void) | null = null;
            constructor() { images.push(this); }
            addEventListener(name: string, callback: () => void) { if (name === "load") this.onload = callback; if (name === "error") this.onerror = callback; }
        },
        FileReader: class {
            result = "data:image/png;base64,test"; callbacks = new Map<string, () => void>();
            constructor() { readers.push(this); }
            addEventListener(name: string, callback: () => void) { this.callbacks.set(name, callback); }
            readAsDataURL() { encodedReads++; }
        },
        document: { addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
            removeEventListener: (name: string, callback: (event: unknown) => void) => { if (listeners.get(name) === callback) listeners.delete(name); },
            createElement: () => {
                const canvas = { width: 0, height: 0, remove() {}, getContext: () => ({ drawImage() {}, getImageData: () => {
                    canvases.push({ width: canvas.width, height: canvas.height });
                    return { data: new Uint8ClampedArray(4), width: canvas.width, height: canvas.height };
                } }) };
                return canvas;
            } },
        setTimeout: (callback: () => void) => { timers.set(++sequence, callback); return sequence; }, clearTimeout: (id: number) => timers.delete(id),
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    let input: Node | undefined;
    const walk = (node: Node | undefined) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "input") input = node;
        node.children.flat().forEach(walk);
    };
    return { timers, urls, requests, verifications, sessions, listeners, images, canvases, reads: () => encodedReads, decodes: () => decodeCount,
        render() { cursor = 0; input = undefined; const result = Component({}); walk(result); effects.splice(0).forEach(effect => effect()); return result; },
        image() { assert.ok(input); (input.props.onChange as (event: unknown) => void)({ target: { files: [{ type: "image/png" }], value: "chosen" } }); },
        load() { readers.forEach(reader => reader.callbacks.get("load")?.()); images.forEach(image => image.onload?.()); },
        failImage() { images.forEach(image => image.onerror?.()); },
        paste(text: string) { listeners.get("paste")?.({ preventDefault() {}, clipboardData: { items: [{ kind: "string", type: "text/plain", getAsString: (callback: (value: string) => void) => callback(text) }] } }); },
        tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
        stop() { plugin.started = false; sessions.forEach(controller => controller.abort()); sessions.clear(); },
        switchAccount() { account = "second"; sessions.forEach(controller => controller.abort()); sessions.clear(); },
        badCode() { code = "https://example.com/ra/fingerprint"; },
        unmount() { slots.forEach(slot => slot?.cleanup?.()); }
    };
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("QR image callbacks cannot scan or request after closing or stopping", async () => {
    for (const action of ["unmount", "stop", "switchAccount"] as const) {
        const f = fixture(); f.render(); f.image(); f[action](); f.load(); await settle(); f.tick(); await settle();
        assert.equal(f.decodes(), 0, action);
        assert.equal(f.requests.length, 0, action);
        assert.equal(f.urls.size, 0, action);
        assert.equal(f.sessions.size, 0, action);
    }
});

test("QR image scan owns one URL, bounds canvas work and cancels the preview delay", async () => {
    const f = fixture(); f.render(); f.image(); f.image(); f.load(); await settle();
    assert.equal(f.reads(), 0);
    assert.equal(f.decodes(), 1);
    assert.equal(f.canvases[0].width, 1280);
    assert.equal(f.canvases[0].height, 640);
    assert.equal(f.urls.size, 1);
    assert.equal(f.timers.size, 1);
    f.unmount(); f.tick(); await settle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.urls.size, 0);
    assert.equal(f.timers.size, 0);
});

test("QR handshake completion stays with its scan and account", async () => {
    for (const action of ["unmount", "stop", "switchAccount"] as const) {
        const f = fixture(); f.render(); f.paste("https://discord.com/ra/fingerprint"); f[action]();
        f.requests[0].resolve({ ok: true, status: 200, body: { handshake_token: "handshake" } }); await settle();
        assert.equal(f.verifications.length, 0, action);
        assert.equal(f.requests.length, action === "switchAccount" ? 1 : 2, action);
        if (f.requests.length === 2) { assert.ok(f.requests[1].url.endsWith("/cancel")); f.requests[1].reject(); await settle(); }
        assert.equal(f.sessions.size, 0);
    }
});

test("QR scan reset releases preview, recovers from failed decoding and rejects other destinations", async () => {
    const f = fixture(); f.render(); f.image(); f.failImage(); await settle();
    assert.ok(!JSON.stringify(f.render()).includes('"spinner"'));
    assert.equal(f.sessions.size, 0);
    assert.equal(f.urls.size, 0);
    f.badCode(); f.image(); f.load(); await settle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.urls.size, 0);
    f.render(); f.paste("https://example.com/ra/fingerprint"); await settle();
    assert.equal(f.requests.length, 0);
    assert.equal(f.sessions.size, 0);
});

test("QR request failure allows another scan and invalid handshakes cannot be confirmed", async () => {
    const f = fixture(); f.render(); f.paste("https://discord.com/ra/first");
    f.requests[0].reject(); await settle();
    assert.equal(f.sessions.size, 0);
    f.render(); f.paste("https://discord.com/ra/second");
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ ok: true, status: 200, body: { handshake_token: 123 } }); await settle();
    assert.equal(f.verifications[0].token, null);
    f.verifications[0].complete(false); await settle();
    assert.equal(f.requests.length, 2);
    f.unmount();
    assert.equal(f.listeners.size, 0);
});

test("QR confirmation reset preserves a successful handshake and cancellation failures are handled", async () => {
    for (const confirmed of [true, false]) {
        const f = fixture(); f.render(); f.image(); f.load(); await settle(); f.tick(); await settle();
        f.requests[0].resolve({ ok: true, status: 200, body: { handshake_token: "handshake" } }); await settle();
        assert.equal(f.verifications.length, 1);
        assert.equal(f.verifications[0].accountId, "first");
        assert.equal(f.verifications[0].signal?.aborted, false);
        assert.equal(f.urls.size, 0);
        f.verifications[0].complete(confirmed); await settle();
        assert.equal(f.sessions.size, 0);
        assert.equal(f.requests.length, confirmed ? 1 : 2);
        if (!confirmed) { f.requests[1].reject(); await settle(); }
        f.render(); f.paste("https://discord.com/ra/next");
        assert.ok(f.requests.at(-1)?.url.endsWith("/remote-auth"));
        f.unmount();
    }
});
