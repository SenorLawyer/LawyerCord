/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("voice indicators ignore unrelated updates and subscribe to the displayed user, channel and permissions", () => {
    const states: Record<string, { userId: string; channelId: string; mute: boolean; }> = {
        first: { userId: "first", channelId: "voice", mute: false }, other: { userId: "other", channelId: "other", mute: false }
    };
    const voiceStore = { getVoiceStateForUser: (id: string) => states[id], getVoiceStatesForChannel: (id: string) => Object.values(states).filter(state => state.channelId === id) };
    const channelStore = { getChannel: (id: string) => ({ id, isDM: () => false, isMultiUserDM: () => false, isPrivate: () => false }) };
    let permitted = true;
    const permissionStore = { can: () => permitted };
    const userStore = { getUser: (id: string) => ({ id }) };
    const subscriptions: { stores: unknown[]; select: () => unknown; value: unknown; deps?: unknown[]; equal?: (a: unknown, b: unknown) => boolean; }[] = [];
    const React = { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props, children }) };
    const mocks: Record<string, unknown> = {
        "@api/PluginManager": { isPluginEnabled: () => false }, "@components/BaseText": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@plugins/showHiddenChannels": { __esModule: true, default: { name: "ShowHiddenChannels" } },
        "@utils/css": { classNameFactory: () => () => "" }, "@utils/misc": { classes: () => "" },
        "@webpack": { findByPropsLazy: () => ({ selectVoiceChannel: () => {} }), findCssClassesLazy: () => ({}) },
        "@webpack/common": {
            React, VoiceStateStore: voiceStore, ChannelStore: channelStore, PermissionStore: permissionStore,
            UserStore: userStore, PermissionsBits: { VIEW_CHANNEL: 1n, CONNECT: 2n }, Tooltip: "tooltip", UserSummaryItem: "users",
            Parser: { parse: (value: string) => value },
            lodash: { isEqual: isDeepStrictEqual }, useMemo: (factory: () => unknown) => factory(),
            useStateFromStores: (stores: unknown[], select: () => unknown, deps?: unknown[], equal?: (a: unknown, b: unknown) => boolean) => {
                const value = select(); subscriptions.push({ stores, select, value, deps, equal }); return value;
            }
        }
    };
    const { outputText } = transpileModule(readFileSync("src/plugins/userVoiceShow/components.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { VoiceChannelIndicator } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    const node = VoiceChannelIndicator({ userId: "first" });
    const voiceSubscriptions = subscriptions.filter(sub => sub.stores.includes(voiceStore));
    states.other.mute = true;
    assert.equal(voiceSubscriptions.filter(sub => !(sub.equal ?? Object.is)(sub.value, sub.select())).length, 0);
    assert.ok(voiceSubscriptions.every(sub => sub.deps?.includes("first")));
    states.first.mute = true;
    assert.equal(voiceSubscriptions.filter(sub => !(sub.equal ?? Object.is)(sub.value, sub.select())).length, 1);
    assert.ok(subscriptions.some(sub => sub.stores.includes(channelStore) && sub.deps?.includes("voice")));
    assert.ok(subscriptions.some(sub => sub.stores.includes(permissionStore)));
    permitted = false;
    const permissionSubscription = subscriptions.find(sub => sub.stores.includes(permissionStore));
    assert.ok(permissionSubscription);
    assert.equal(permissionSubscription.equal?.(permissionSubscription.value, permissionSubscription.select()), false);
    const start = subscriptions.length;
    node.props.text.type(node.props.text.props);
    const tooltip = subscriptions.slice(start);
    assert.ok(tooltip.some(sub => sub.stores.includes(userStore) && sub.stores.includes(voiceStore) && sub.deps?.includes("voice")));
});
