/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface PreviewMessage { id: string; channel_id: string; content: string; }
function fixture() {
    const cached = new Map<string, PreviewMessage>();
    let userId = "account";
    let cursor = 0;
    let writes = 0;
    let conversions = 0;
    let errors = 0;
    const state: unknown[] = [];
    const effects: { deps?: unknown[]; cleanup?: () => void; }[] = [];
    const nextEffects: (() => void)[] = [];
    const requests: { options: { query: { around: string; }; }; resolve(value: { body: unknown; }): void; reject(error: Error): void; }[] = [];
    function useState(initial: unknown) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value: unknown) => { state[index] = value; writes++; }];
    }
    function useEffect(callback: () => (() => void) | undefined, deps?: unknown[]) {
        const index = cursor++;
        const previous = effects[index];
        if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
        nextEffects.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: callback() }; });
    }
    const mocks: Record<string, unknown> = {
        "./style.css": {}, "@api/Settings": { definePluginSettings: () => ({ store: { display: "auto" }, use: () => ({ display: "auto" }) }) },
        "@api/UserSettings": { getUserSettingLazy: () => ({ useSetting: () => false }) },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } }, "@utils/constants": { Devs: {} },
        "@utils/Logger": { Logger: class { error() { errors++; } } },
        "@utils/misc": { isObject: (value: unknown) => value !== null && typeof value === "object" },
        "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
        "@webpack": { findComponentByCodeLazy: () => "message" },
        "@webpack/common": { useEffect, useState, useStateFromStores: (_stores: unknown[], selector: () => unknown) => selector(),
            UserStore: { getCurrentUser: () => userId ? { id: userId } : undefined },
            MessageStore: { getMessage: (channel: string, id: string) => cached.get(`${channel}/${id}`),
                getMessages: () => ({ receiveMessage: (message: PreviewMessage) => { conversions++; return { get: () => message }; } }) },
            Constants: { Endpoints: { MESSAGES: (channel: string) => channel } },
            RestAPI: { get: (options: { query: { around: string; }; }) => new Promise((resolve, reject) => { requests.push({ options, resolve, reject }); }) }
        }
    };
    const { outputText } = transpileModule(readFileSync(process.env.AUDIT_MESSAGE_TOOLTIP_SOURCE ?? "src/equicordplugins/messageLinkTooltip/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const api = runInNewContext(`${outputText}\n({ plugin: exports.default, useMessage });`, {
        exports: {}, console, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    }) as { plugin: { start?(): void; stop?(): void; }; useMessage(channel: string, id: string): PreviewMessage | null | undefined; };
    api.plugin.start?.();
    return { cached, requests, api,
        render(channel = "channel", id = "target") { cursor = 0; const result = api.useMessage(channel, id); for (const effect of nextEffects.splice(0)) effect(); return result; },
        unmount() { for (const effect of effects) effect?.cleanup?.(); },
        account(value: string) { userId = value; }, counts: () => ({ writes, conversions, errors }) };
}

const target = (content = "remote"): PreviewMessage => ({ id: "target", channel_id: "channel", content });

test("Missing message previews start only one request across repeated pending renders", () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.render();
    assert.equal(f.requests.length, 1);
});

test("Message previews follow store replacements and never reuse fallback from another target", async () => {
    const f = fixture();
    f.render();
    f.requests[0].resolve({ body: [target()] });
    await setImmediate();
    assert.equal(f.render()?.content, "remote");
    f.cached.set("channel/target", target("current stored value"));
    assert.equal(f.render()?.content, "current stored value");
    assert.equal(f.render("other", "target"), undefined);
    assert.equal(f.requests.length, 2);
});

test("Message previews reject nearby responses and settle failed requests without a render retry loop", async () => {
    const f = fixture();
    f.render();
    f.requests[0].resolve({ body: [{ ...target(), id: "nearby" }] });
    await setImmediate();
    assert.equal(f.render(), null);
    assert.equal(f.counts().conversions, 0);
    assert.equal(f.requests.length, 1);
    f.render("other", "missing");
    f.requests[1].reject(new Error("Cannot load preview"));
    await setImmediate();
    assert.equal(f.render("other", "missing"), null);
    assert.equal(f.counts().errors, 1);
    assert.equal(f.requests.length, 2);
});

test("Late message preview responses cannot convert or publish after unmount, stop, account or target changes", async () => {
    for (const boundary of ["unmount", "stop", "account", "target"] as const) {
        const f = fixture();
        f.render();
        if (boundary === "unmount") f.unmount();
        if (boundary === "stop") f.api.plugin.stop?.();
        if (boundary === "account") f.account("other");
        if (boundary === "target") f.render("other", "missing");
        f.requests[0].resolve({ body: [target()] });
        await setImmediate();
        assert.equal(f.counts().conversions, 0, boundary);
        assert.equal(f.counts().writes, 0, boundary);
    }
});
