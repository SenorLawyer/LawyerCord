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

interface Element {
    props: { action(): Promise<void> | void; modalProps: { onClose(): void; }; close(): void; url?: string; };
}

function fixture() {
    const path = process.env.AUDIT_REMIX_SOURCE ?? "src/equicordplugins/remix/index.tsx";
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    let imports = 0;
    let chunks = 0;
    let closes = 0;
    let userId = "first";
    let blocked: Promise<void> | undefined;
    const rendered: Element[] = [];
    const props = { onClose: () => closes++ };
    const modules: Record<string, unknown> = {
        "@api/ContextMenu": { findGroupChildrenByChildId: (_id: string, children: Element[]) => children },
        "@components/Icons": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (plugin: unknown) => plugin },
        "@webpack": { extractAndLoadChunksLazy: () => () => { chunks++; return blocked ?? Promise.resolve(); } },
        "@webpack/common": {
            UserStore: { getCurrentUser: () => ({ id: userId }) }, Menu: { MenuItem: "item" },
            openModalLazy: async (load: () => Promise<(props: object) => Element | null>) => {
                const render = await load(); const node = render(props); if (node) rendered.push(node);
            },
            openModal: (render: (props: object) => Element) => { rendered.push(render(props)); return "key"; },
            closeModal: () => closes++
        },
        "./styles.css?managed": {}, "./RemixModal": { default: "RemixModal" },
        "react/jsx-runtime": { jsx: (_type: unknown, props: object) => ({ props }) }
    };
    const exports: { default?: {
        start(): Promise<void> | void; stop?(): void;
        contextMenus: Record<string, (children: Element[], props: object) => void>;
    }; } = {};
    runInNewContext(outputText, { exports, require: (name: string) => {
        assert.ok(name in modules, name); if (name === "./RemixModal") imports++; return modules[name];
    } });
    assert.ok(exports.default);
    const plugin = exports.default;
    return {
        plugin, rendered, get imports() { return imports; }, get chunks() { return chunks; }, get closes() { return closes; },
        user(id: string) { userId = id; },
        block() { let release = () => {}; blocked = new Promise<void>(resolve => { release = resolve; }); return release; },
        action(message = false) {
            const children: Element[] = []; plugin.contextMenus[message ? "message" : "channel-attach"](children, message ? { itemHref: "https://cdn.example/image.png" } : {});
            assert.equal(children.length, 1); return children[0].props.action();
        }
    };
}

test("Remix loads its editor and Discord chunks only when selected, preserving both menu paths and close behavior", async () => {
    const f = fixture(); await f.plugin.start(); assert.equal(f.imports, 0); assert.equal(f.chunks, 0);
    await f.action(); assert.equal(f.imports, 1); assert.equal(f.chunks, 2); assert.equal(f.rendered.length, 1);
    assert.equal(f.rendered[0].props.url, undefined); f.rendered[0].props.close(); assert.equal(f.closes, 1);
    await f.action(true); assert.equal(f.rendered[1].props.url, "https://cdn.example/image.png");
    f.rendered[1].props.close(); assert.equal(f.closes, 2); f.plugin.stop?.();
});

test("Remix loading cannot open a modal after stop, restart or account replacement", async () => {
    for (const change of ["stop", "restart", "account"]) {
        const f = fixture(); await f.plugin.start(); const release = f.block(); const pending = f.action();
        if (change === "account") f.user("second"); else { f.plugin.stop?.(); if (change === "restart") f.plugin.start(); }
        release(); await pending; assert.equal(f.rendered.length, 0); assert.equal(f.imports, 0);
    }
});
