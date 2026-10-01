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

function load(path: string, modules: Record<string, unknown>) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    const exports: { default?: Record<string, unknown>; } = {};
    runInNewContext(outputText, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
    assert.ok(exports.default);
    return exports.default;
}

test("home typing stays current when the account or private-channel list changes", () => {
    let currentUser = "first";
    let channels = ["dm"];
    let result: boolean | undefined;
    const TypingStore = { getTypingUsers: (id: string) => id === "dm" ? { first: 1 } : {} };
    const UserStore = { getCurrentUser: () => ({ id: currentUser }) };
    const PrivateChannelSortStore = { getPrivateChannelIds: () => channels };
    const subscriptions = new Map<object, () => void>();
    const plugin = load(process.env.AUDIT_HOME_TYPING_SOURCE ?? "src/equicordplugins/homeTyping/index.tsx", {
        "./styles.css": {}, "react/jsx-runtime": {}, "@utils/constants": { Devs: {} }, "@utils/css": { classNameFactory: () => () => "class" },
        "@utils/types": { __esModule: true, default: (p: unknown) => p },
        "@webpack": { findComponentByCodeLazy() {}, findStoreLazy: () => PrivateChannelSortStore },
        "@webpack/common": { TypingStore, UserStore,
            useStateFromStores: (stores: object[], select: () => boolean) => {
                const update = () => { result = select(); };
                stores.forEach(store => subscriptions.set(store, update));
                update(); return result;
            }
        }
    });
    const isTyping = plugin.isTyping;
    assert.equal(typeof isTyping, "function");
    if (typeof isTyping !== "function") return;
    isTyping(); assert.equal(result, false);
    currentUser = "second"; subscriptions.get(UserStore)?.(); assert.equal(result, true);
    channels = []; subscriptions.get(PrivateChannelSortStore)?.(); assert.equal(result, false);
    channels = ["dm"]; subscriptions.get(PrivateChannelSortStore)?.(); assert.equal(result, true);
});

test("Nitro upsell overrides survive connections for every actual premium tier and stop restores normal behavior", () => {
    const state: { premiumTypeActual: number; premiumTypeOverride?: number; } = { premiumTypeActual: 0 };
    const plugin = load(process.env.AUDIT_UPSELL_SOURCE ?? "src/equicordplugins/noNitroUpsell/index.ts", {
        "@utils/constants": { Devs: {} }, "@utils/types": { __esModule: true, default: (p: unknown) => p },
        "@webpack/common": { OverridePremiumTypeStore: { getState: () => state } }
    });
    const { start, stop, flux } = plugin;
    assert.equal(typeof start, "function"); assert.equal(typeof stop, "function");
    assert.ok(flux && typeof flux === "object" && "CONNECTION_OPEN" in flux && typeof flux.CONNECTION_OPEN === "function");
    if (typeof start !== "function" || typeof stop !== "function") return;
    start(); assert.equal(state.premiumTypeOverride, 2);
    for (const tier of [0, 1, 2]) {
        state.premiumTypeActual = tier; state.premiumTypeOverride = undefined;
        flux.CONNECTION_OPEN(); assert.equal(state.premiumTypeOverride, 2);
    }
    stop(); assert.equal(state.premiumTypeOverride, undefined);
});
