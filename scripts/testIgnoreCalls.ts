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

interface CallEvent {
    type: string;
    channelId: string;
    messageId?: string;
    region?: string;
    ringing?: string[];
    ongoingRings?: string[];
}

interface Node {
    props: { children: (Node | ((props: object) => Node))[]; onClick?(): void; action?(): void; checked?: boolean; };
}

function fixture(ignored = "ignored") {
    const source = readFileSync(process.env.AUDIT_IGNORE_CALLS_SOURCE ?? "src/equicordplugins/ignoreCalls/index.tsx", "utf8");
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const interceptors: ((event: CallEvent) => void)[] = [];
    const dispatched: CallEvent[] = [];
    let changeSetting: (value: string) => void = () => {};
    const store = new Proxy({ permanentlyIgnoredUsers: ignored }, {
        set(target, _key, value: string) { target.permanentlyIgnoredUsers = value; changeSetting(value); return true; }
    });
    const calls = { first: { channelId: "first", ringing: ["self", "other"], messageId: "first-message", region: "first-region" } };
    let currentUserId = "self";
    let hookCalls = 0;
    const exports: { default?: { start?(): void; stop?(): void; renderIgnore(channel: { id: string; }): Node | null; contextMenus: Record<string, (children: Node[], props: { channel: { id: string; }; }) => void>; flux?: { CALL_UPDATE?(event: CallEvent): void; CONNECTION_OPEN?(): void; }; }; } = {};
    const React = { createElement: (_type: unknown, props: object, ...children: unknown[]) => ({ props: { ...props, children } }), useState: (value: unknown) => { hookCalls++; return [value, () => {}]; } };
    const modules: Record<string, unknown> = {
        "./styles.css": {}, "@api/ContextMenu": {}, "@api/Settings": { definePluginSettings: (def: { permanentlyIgnoredUsers: { onChange?(value: string): void; }; }) => { changeSetting = def.permanentlyIgnoredUsers.onChange ?? (() => {}); return { store, use: () => store }; } },
        "@components/Button": { Button: "button" }, "@components/ErrorBoundary": { __esModule: true, default: "boundary" },
        "@utils/constants": { Devs: {}, EquicordDevs: {} }, "@utils/css": { classNameFactory: () => (name: string) => name },
        "@utils/types": { __esModule: true, default: (p: unknown) => p, OptionType: {} }, "@webpack": { findComponentByCodeLazy: () => "icon" },
        "@webpack/common": { React, Menu: {}, Tooltip: "tooltip", CallStore: { getCall: (id: keyof typeof calls) => calls[id], getCalls: () => Object.values(calls) },
            FluxDispatcher: { _interceptors: interceptors, addInterceptor: (cb: (event: CallEvent) => void) => interceptors.push(cb), dispatch: (event: CallEvent) => { dispatched.push(event); if (event.channelId === "first" && event.ringing) calls.first.ringing = event.ringing; } },
            UserStore: { getCurrentUser: () => ({ id: currentUserId }) } }
    };
    runInNewContext(outputText, { exports, React, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    const plugin = exports.default; assert.ok(plugin); plugin.start?.();
    return { plugin, dispatched, interceptors, store, hookCalls: () => hookCalls,
        configure(value: string) { store.permanentlyIgnoredUsers = value; },
        menu(channelId: string) { const children: Node[] = []; plugin.contextMenus["gdm-context"](children, { channel: { id: channelId } }); return children[0].props.children as Node[]; },
        receive(event: CallEvent) { interceptors.forEach(cb => cb(event)); plugin.flux?.CALL_UPDATE?.(event); return event; },
        account(id: string) { currentUserId = id; plugin.flux?.CONNECTION_OPEN?.(); }
    };
}

test("ignored call renders do not dispatch updates", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) assert.equal(f.plugin.renderIgnore({ id: "ignored" }), null);
    assert.equal(f.dispatched.length, 0);
    f.plugin.stop?.();
});

test("ignored call events remove only the current user's ringing before stores run", () => {
    const f = fixture();
    for (const type of ["CALL_CREATE", "CALL_UPDATE"]) {
        const event = f.receive({ type, channelId: "ignored", ringing: ["self", "other"], ongoingRings: ["other", "self"], region: "region", messageId: "message" });
        assert.deepEqual(Array.from(event.ringing ?? []), ["other"]);
        assert.deepEqual(Array.from(event.ongoingRings ?? []), ["other"]);
        assert.equal(event.messageId, "message"); assert.equal(event.region, "region");
    }
    const regular = f.receive({ type: "CALL_UPDATE", channelId: "regular", ringing: ["self"] });
    assert.deepEqual(regular.ringing, ["self"]);
    f.account("next");
    const changed = f.receive({ type: "CALL_UPDATE", channelId: "ignored", ringing: ["self", "next"] });
    assert.deepEqual(Array.from(changed.ringing ?? []), ["self"]);
    assert.equal(f.dispatched.length, 0); f.plugin.stop?.(); assert.equal(f.interceptors.length, 0);
});

test("manual call dismissal uses that channel's live call rather than the last event", () => {
    const f = fixture();
    f.receive({ type: "CALL_UPDATE", channelId: "second", ringing: ["self", "unrelated"], messageId: "second-message", region: "second-region" });
    const node = f.plugin.renderIgnore({ id: "first" }); assert.ok(node);
    const tooltip = node.props.children[0] as Node;
    const render = tooltip.props.children[0] as (props: object) => Node;
    render({}).props.onClick?.();
    assert.equal(f.dispatched.length, 1);
    const event = f.dispatched[0];
    assert.equal(event.channelId, "first"); assert.equal(event.messageId, "first-message"); assert.equal(event.region, "first-region");
    assert.deepEqual(Array.from(event.ringing ?? []), ["other"]);
    f.plugin.stop?.();
});

test("already ringing ignored calls are dismissed on start or a setting change", () => {
    const f = fixture("first");
    assert.equal(f.dispatched.length, 1);
    assert.deepEqual(Array.from(f.dispatched[0].ringing ?? []), ["other"]);
    for (let i = 0; i < 100; i++) f.plugin.renderIgnore({ id: "first" });
    assert.equal(f.dispatched.length, 1);
    f.plugin.stop?.(); f.configure("first"); assert.equal(f.dispatched.length, 1);
    const g = fixture(); g.configure("first"); assert.equal(g.dispatched.length, 1);
    assert.equal(g.plugin.renderIgnore({ id: "first" }), null);
    g.plugin.stop?.();
});

test("temporary call ignores stay local and clear on account connection changes", () => {
    const f = fixture();
    const temporary = f.menu("first")[1]; assert.equal(temporary.props.checked, false);
    temporary.props.action?.(); assert.equal(f.menu("first")[1].props.checked, true);
    assert.equal(f.hookCalls(), 0); assert.equal(f.store.permanentlyIgnoredUsers, "ignored");
    const ignored = f.receive({ type: "CALL_UPDATE", channelId: "first", ringing: ["self", "other"] });
    assert.deepEqual(Array.from(ignored.ringing ?? []), ["other"]);
    f.account("next"); assert.equal(f.menu("first")[1].props.checked, false);
    const regular = f.receive({ type: "CALL_UPDATE", channelId: "first", ringing: ["next", "other"] });
    assert.deepEqual(regular.ringing, ["next", "other"]);
    f.plugin.stop?.();
});

test("permanent toggles preserve intervening edits from another menu", () => {
    const f = fixture(); const first = f.menu("first")[2];
    f.configure("ignored, second"); first.props.action?.();
    assert.equal(f.store.permanentlyIgnoredUsers, "ignored, second, first");
    const event = f.receive({ type: "CALL_UPDATE", channelId: "first", ringing: ["self", "other"] });
    assert.deepEqual(Array.from(event.ringing ?? []), ["other"]);
    f.menu("first")[2].props.action?.();
    assert.equal(f.store.permanentlyIgnoredUsers, "ignored, second");
    f.plugin.stop?.();
});
