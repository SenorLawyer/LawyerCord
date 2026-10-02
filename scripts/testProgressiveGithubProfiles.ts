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

for (const component of ["ProfileTabComponent", "ProfilePopoutComponent"]) {
    test(`${component} cancels old profile work and ignores late results`, async () => {
        const effects: (() => (() => void) | void)[] = [];
        const writes: unknown[] = [];
        const requests: { signal?: AbortSignal; resolve(value: unknown): void; }[] = [];
        let cleaned = false;
        const compile = (path: string) => transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } }).outputText;
        const api = runInNewContext(compile("src/equicordplugins/githubRepos/githubApi.ts") + "\nexports;", {
            exports: {}, fetch: (_url: string, options?: RequestInit) => new Promise(resolve => requests.push({ signal: options?.signal ?? undefined, resolve })),
            require: () => ({ Logger: class { error() {} } })
        });
        const React = { createElement: () => null };
        const loaded = runInNewContext(compile(`src/equicordplugins/githubRepos/components/${component}.tsx`) + "\nexports;", {
            exports: {}, React, AbortController,
            require(name: string) {
                if (name.endsWith("githubApi")) return api;
                if (name === "@webpack/common") return { React, useEffect: (effect: () => (() => void) | void) => effects.push(effect), useState: (initial: unknown) => [initial, (value: unknown) => { if (cleaned) writes.push(value); }], UserProfileStore: { getUserProfile: () => ({ connectedAccounts: [{ type: "github", name: "fixture", id: "1" }] }) } };
                if (name === "@webpack") return { findCssClassesLazy: () => ({}) };
                return { cl: () => "", settings: { store: {} } };
            }
        });
        loaded[component]({ id: "a" });
        const cleanup = effects[0]();
        assert.equal(requests.length, 1);
        cleaned = true;
        cleanup?.();
        requests[0].resolve({ ok: true, json: async () => ({ login: "old", public_repos: 1 }) });
        await setImmediate();
        assert.equal(requests[0].signal?.aborted, true);
        assert.equal(requests.length, 1);
        assert.equal(writes.length, 0);
    });
}
