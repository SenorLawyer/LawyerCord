/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { Queue } from "../src/utils/Queue";

function fixture() {
    const requests: string[] = [];
    const updates: unknown[] = [];
    let resolveRequest: ((value: { body: object; }) => void) | undefined;
    const firstRequest = new Promise<{ body: object; }>(resolve => { resolveRequest = resolve; });
    const cleanups: (() => void)[] = [];
    const modules = {
        __esModule: true, default: (plugin: unknown) => plugin, Devs: {}, Queue,
        Constants: { UserFlags: {}, Endpoints: { USER: (id: string) => id } },
        UserStore: { getUser: () => undefined, getCurrentUser: () => ({ id: "account" }) },
        UserProfileStore: { getUserProfile: () => undefined },
        FluxDispatcher: { dispatch: (event: unknown) => updates.push(event) },
        RestAPI: { get: ({ url }: { url: string; }) => { requests.push(url); return requests.length === 1 ? firstRequest : Promise.resolve({ body: { id: url } }); } },
        sleep: async () => {}, isNonNullish: (value: unknown) => value != null,
        useState: (value: unknown) => [value, () => {}], useRef: (value: unknown) => ({ current: value }),
        useEffect: (effect: () => (() => void)) => cleanups.push(effect())
    };
    const source = readFileSync(process.env.AUDIT_VALID_USER_SOURCE ?? "src/plugins/validUser/index.tsx", "utf8") + "\nexport { MentionWrapper, fetching };";
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } });
    const api = runInNewContext(`${outputText}\nexports;`, { exports: {}, require: () => modules,
        React: { createElement: (_type: unknown, props: unknown, ...children: unknown[]) => ({ props, children }) }
    }) as { MentionWrapper(props: unknown): { children: { props: { onMouseEnter(): void; }; }[]; }; fetching: Set<string>; default: { start?(): void; stop?(): void; }; };
    api.default.start?.();
    return { requests, updates, api,
        hover(id: string) {
            const node = api.MentionWrapper({ data: { content: id }, props: {}, parse: () => [{ props: { children: `<@${id}>` } }] });
            node.children[0].props.onMouseEnter();
        },
        release() { resolveRequest?.({ body: { id: requests[0] } }); },
        unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
    };
}

test("Overflowed unknown mention lookups do not retain dropped user IDs after repeated navigation", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.hover(String(1000 + i));
    await setImmediate();
    f.release();
    await setImmediate();
    assert.equal(f.api.fetching.size, 0);
    const before = f.requests.length;
    f.hover("1001");
    await setImmediate();
    assert.equal(f.requests.length, before + 1, "A dropped lookup must be retryable on the next hover.");
});

test("Stopping or unmounting mention lookups drops queued and late results", async () => {
    for (const stop of [false, true]) {
        const f = fixture();
        f.hover("1000");
        await setImmediate();
        for (let i = 1; i <= 10; i++) f.hover(String(1000 + i));
        if (stop) f.api.default.stop?.();
        else f.unmount();
        f.release();
        await setImmediate();
        assert.equal(f.requests.length, 1);
        assert.equal(f.updates.length, 0);
        assert.equal(f.api.fetching.size, 0);
    }
});
