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
    let now = 0;
    let channelId = "initial";
    let notifications = 0;
    const events = new Map<string, (event: object) => void>();
    const modules: Record<string, unknown> = {
        "@api/ChatButtons": { ChatBarButton: "button" },
        "@api/Settings": { definePluginSettings: () => ({ use: () => ({ showIcon: true, showMs: true, iconColor: "green" }) }) },
        "@components/ErrorBoundary": { __esModule: true, default: ({ children }: { children: unknown[]; }) => children[0] },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/discord": { getCurrentChannel: () => ({ id: channelId }) },
        "@utils/lazy": { proxyLazy: (factory: () => unknown) => factory() },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) },
            moment: () => ({ fromNow: () => "just now" }),
            SelectedChannelStore: { getChannelId: () => channelId },
            FluxDispatcher: { subscribe: (type: string, fn: (event: object) => void) => events.set(type, fn), unsubscribe: (type: string) => events.delete(type) },
            zustandCreate: (initial: () => unknown) => {
                let state = initial();
                return Object.assign((select: (state: unknown) => unknown) => select(state), {
                    getState: () => state, setState: (next: unknown) => { state = next; notifications++; }
                });
            }
        }
    };
    const code = transpileModule(readFileSync("src/equicordplugins/messageFetchTimer/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    }).outputText;
    const plugin = runInNewContext(`${code}\nexports.default;`, {
        exports: {}, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        performance: { now: () => now },
        React: { createElement: (type: unknown, props: object, ...children: unknown[]) => ({ type, props, children }) }
    });
    plugin.start?.();
    return {
        plugin, setTime: (value: number) => { now = value; }, updates: () => notifications,
        emit: (type: string) => (plugin.flux?.[type] ?? events.get(type))?.({ channelId }),
        render: () => {
            let view = plugin.chatBarButton.render({ isMainChat: true, channel: { id: channelId } });
            while (view && typeof view.type === "function") view = view.type({ ...view.props, children: view.children });
            return view;
        },
        select: (id: string) => { channelId = id; (plugin.flux?.CHANNEL_SELECT ?? events.get("CHANNEL_SELECT"))?.({ channelId }); }
    };
}

test("fetch timing measures completed loads and ignores incoming messages", () => {
    const f = fixture();
    f.select("channel"); f.emit("LOAD_MESSAGES"); f.setTime(20); f.emit("MESSAGE_CREATE");
    assert.equal(f.render(), null);
    f.setTime(40); f.emit("LOAD_MESSAGES_SUCCESS");
    assert.match(f.render().props.tooltip, /40ms/);
    assert.equal(f.updates(), 1);
    f.setTime(50); f.emit("LOAD_MESSAGES"); f.setTime(80); f.emit("LOAD_MESSAGES_SUCCESS");
    assert.match(f.render().props.tooltip, /30ms/);
    assert.equal(f.updates(), 2);
});

test("fetch timing discards failed, stopped and overlong loads", () => {
    const f = fixture();
    f.select("channel"); f.emit("LOAD_MESSAGES"); f.emit("LOAD_MESSAGES_FAILURE");
    f.setTime(20); f.emit("LOAD_MESSAGES_SUCCESS"); assert.equal(f.render(), null);
    f.emit("LOAD_MESSAGES"); f.setTime(70_000); f.emit("LOAD_MESSAGES_SUCCESS"); assert.equal(f.render(), null);
    f.emit("LOAD_MESSAGES"); f.plugin.stop(); f.setTime(70_010); f.emit("LOAD_MESSAGES_SUCCESS"); assert.equal(f.render(), null);
});
