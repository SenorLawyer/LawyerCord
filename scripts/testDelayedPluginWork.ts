/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path: string, names: string[], globals: string[], context: Record<string, unknown>) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")
        || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && globals.includes(d.name.text)));
    const plugin = source.statements.find(ts.isExportAssignment);
    assert.ok(plugin && ts.isCallExpression(plugin.expression));
    const definition = plugin.expression.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(definition));
    const methods = definition.properties.filter(node => ts.isMethodDeclaration(node) && ["start", "stop"].includes(node.name.getText(source)));
    const text = declarations.map(node => node.getText(source)).join("\n") + "\nconst plugin = {" + methods.map(node => node.getText(source)).join(",") + "};\n({plugin," + names.filter(name => declarations.some(node => ts.isFunctionDeclaration(node) && node.name?.text === name)).join(",") + "})";
    return runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
}

for (const mode of ["normal", "stop", "restart"]) {
    test(`SidebarChat pending DM popout respects ${mode}`, async () => {
        let finish: (value: string) => void = () => {};
        let opens = 0;
        const lookup = new Promise<string>(resolve => finish = resolve);
        const channel = { id: "dm", name: "DM", isPrivate: () => true, getRecipientId: () => null };
        const api = load("src/equicordplugins/sidebarChat/index.tsx", ["clearPersistedPopoutRestore", "waitForChannelStore", "waitForChannel", "waitForDmChannel", "openPopoutFromUserMenu", "openPopout", "closePopout", "getChannelTitle", "canOpenPopout"], ["stopPersistedPopoutRestore", "restoringPersistedPopouts", "popoutGeneration", "pendingPopoutWaits"], {
            ChannelActionCreators: { getOrEnsurePrivateChannel: () => lookup }, ChannelStore: { getChannel: () => channel },
            PopoutActions: { open: () => opens++, setAlwaysOnTop() {}, close() {} },
            getOpenPopoutWindowKeys: () => [], getPopoutWindowKey: (id: string) => id, isPopoutWindowOpen: () => false,
            syncPersistedPopoutWindows() {}, restorePersistedPopouts() {}, settings: { store: {} }, setTimeout, clearTimeout, Date
        });
        await api.plugin.start();
        const pending = api.openPopoutFromUserMenu("user");
        if (mode !== "normal") api.plugin.stop();
        if (mode === "restart") await api.plugin.start();
        finish("dm");
        await pending;
        assert.equal(opens, mode === "normal" ? 1 : 0);
        if (mode === "restart") { await api.openPopoutFromUserMenu("user"); assert.equal(opens, 1); }
    });

    test(`XSOverlay pending avatar respects ${mode}`, async () => {
        let finish: (value: unknown) => void = () => {};
        let sends = 0;
        const response = new Promise(resolve => finish = resolve);
        const api = load("src/plugins/xsOverlay/index.tsx", ["getCachedAvatarIcon", "sendMsgNotif", "sendToOverlay", "stopSocket", "calculateHeight", "calculateTimeout", "start"], ["socket", "socketGeneration", "notificationGeneration", "avatarIconCache", "MAX_AVATAR_ICON_CACHE_SIZE"], {
            settings: { store: { preferUDP: true } }, IS_WEB: false, Native: { sendToOverlay: () => sends++ },
            fetch: () => response, connectSocket: async () => {}, logger: { error() {} },
            FileReader: class { result = "data:image/png;base64,a"; onload = () => {}; readAsDataURL() { this.onload(); } }
        });
        await api.start();
        const message = { author: { id: "fixture", avatar: "fixture" } };
        api.sendMsgNotif("fixture", "fixture", message);
        if (mode !== "normal") api.plugin.stop();
        if (mode === "restart") await api.start();
        finish({ blob: async () => ({}) });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.equal(sends, mode === "normal" ? 1 : 0);
        if (mode === "restart") {
            api.sendMsgNotif("fixture", "fixture", message);
            for (let i = 0; i < 20; i++) await Promise.resolve();
            assert.equal(sends, 1);
        }
    });
}

for (const mode of ["normal", "stop", "restart"]) {
    test(`XSOverlay connected notification continuation respects ${mode}`, async () => {
        let sends = 0;
        const sockets: FakeSocket[] = [];
        class FakeSocket {
            static OPEN = 1;
            readyState = 0;
            onopen: (() => void) | null = null;
            onclose: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor() { sockets.push(this); }
            close() { this.readyState = 3; this.onclose?.(); }
            send() { sends++; }
            open() { this.readyState = 1; this.onopen?.(); }
        }
        const api = load("src/plugins/xsOverlay/index.tsx", ["sendToOverlay", "connectSocket", "stopSocket", "start"], ["socket", "socketGeneration", "notificationGeneration", "avatarIconCache"], {
            settings: { store: {} }, IS_WEB: true, WebSocket: FakeSocket, setTimeout, clearTimeout, logger: { error() {} }
        });
        const pending = api.sendToOverlay({ title: "fixture" });
        sockets[0].open();
        if (mode !== "normal") api.plugin.stop();
        if (mode === "restart") {
            const starting = api.start();
            sockets[1].open();
            await starting;
        }
        await pending;
        assert.equal(sends, mode === "normal" ? 1 : 0);
        if (mode === "restart") { await api.sendToOverlay({ title: "fresh" }); assert.equal(sends, 1); }
        api.plugin.stop();
    });
}

for (const outcome of ["change", "timeout", "stop", "restart"]) {
    test(`SidebarChat channel wait releases subscription on ${outcome}`, async () => {
        const listeners = new Set<() => void>();
        const timers = new Set<() => void>();
        let channel: { id: string; } | null = null;
        let reads = 0;
        const api = load("src/equicordplugins/sidebarChat/index.tsx", ["clearPersistedPopoutRestore", "waitForChannelStore", "waitForChannel", "waitForDmChannel"], ["stopPersistedPopoutRestore", "restoringPersistedPopouts", "popoutGeneration", "pendingPopoutWaits"], {
            ChannelStore: {
                getChannel: () => { reads++; return channel; }, getDMFromUserId: () => channel?.id,
                addChangeListener: (fn: () => void) => listeners.add(fn), removeChangeListener: (fn: () => void) => listeners.delete(fn)
            },
            setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 2500); timers.add(fn); return fn; },
            clearTimeout: (fn: () => void) => timers.delete(fn),
            getOpenPopoutWindowKeys: () => [], syncPersistedPopoutWindows() {}, restorePersistedPopouts() {}, Date
        });
        const pending = api.waitForChannel("dm", 0);
        assert.equal(listeners.size, 1);
        assert.equal(timers.size, 1);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(reads, 1);
        if (outcome === "change") { channel = { id: "dm" }; for (const listener of listeners) listener(); }
        if (outcome === "timeout") for (const timer of [...timers]) timer();
        if (outcome === "stop" || outcome === "restart") api.plugin.stop();
        if (outcome === "restart") await api.plugin.start();
        assert.equal(await pending, outcome === "change" ? channel : null);
        assert.equal(listeners.size, 0);
        assert.equal(timers.size, 0);
        if (outcome === "restart") {
            const fresh = api.waitForDmChannel("user", 1);
            assert.equal(listeners.size, 1);
            channel = { id: "dm" };
            for (const listener of listeners) listener();
            assert.equal(await fresh, "dm");
            assert.equal(listeners.size, 0);
            assert.equal(timers.size, 0);
        }
    });
}

test("SidebarChat rejected DM creation falls back to store changes", async () => {
    const listeners = new Set<() => void>();
    let dmId: string | undefined;
    let channel: { id: string; name: string; isPrivate: () => boolean; getRecipientId: () => null; } | undefined;
    let opens = 0;
    const api = load("src/equicordplugins/sidebarChat/index.tsx", ["clearPersistedPopoutRestore", "waitForChannelStore", "waitForChannel", "waitForDmChannel", "openPopoutFromUserMenu", "openPopout", "closePopout", "getChannelTitle", "canOpenPopout"], ["stopPersistedPopoutRestore", "restoringPersistedPopouts", "popoutGeneration", "pendingPopoutWaits"], {
        ChannelActionCreators: { getOrEnsurePrivateChannel: async () => { throw new Error("fixture"); } },
        ChannelStore: {
            getChannel: () => channel, getDMFromUserId: () => dmId,
            addChangeListener: (fn: () => void) => listeners.add(fn), removeChangeListener: (fn: () => void) => listeners.delete(fn)
        },
        PopoutActions: { open: () => opens++, setAlwaysOnTop() {}, close() {} },
        getOpenPopoutWindowKeys: () => [], getPopoutWindowKey: (id: string) => id, isPopoutWindowOpen: () => false,
        syncPersistedPopoutWindows() {}, restorePersistedPopouts() {}, settings: { store: {} }, setTimeout, clearTimeout
    });
    const pending = api.openPopoutFromUserMenu("user");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(listeners.size, 1);
    dmId = "dm";
    for (const listener of [...listeners]) listener();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(listeners.size, 1);
    channel = { id: "dm", name: "DM", isPrivate: () => true, getRecipientId: () => null };
    for (const listener of [...listeners]) listener();
    await pending;
    assert.equal(opens, 1);
    assert.equal(listeners.size, 0);
});
