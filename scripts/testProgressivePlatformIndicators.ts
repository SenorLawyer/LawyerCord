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
    const statuses: Record<string, Record<string, string>> = { other: { desktop: "online" } };
    let writes = 0;
    let sessions = { first: { clientInfo: { client: "desktop" }, status: "online" } };
    const selectors: { read(): unknown; value: unknown; equal?(a: unknown, b: unknown): boolean; }[] = [];
    const settings = { showBots: true, ConsoleIcon: "equicord" };
    const ownStatus = new Proxy(statuses, { set(target, key: string, value: Record<string, string>) { writes++; target[key] = value; return true; } });
    const modules = { __esModule: true, default: (value: unknown) => value, Devs: {}, EquicordDevs: {}, OptionType: {}, migratePluginSetting() {},
        definePluginSettings: () => ({ store: settings }), filters: { byCode() {} }, mapMangledModuleLazy: () => ({}),
        findStoreLazy: () => ({ getSessions: () => sessions }), AuthenticationStore: { getId: () => "self" },
        PresenceStore: { getState: () => ({ clientStatuses: ownStatus }), getClientStatus: (id: string) => ownStatus[id] },
        lodash: { isEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }, classes: () => "",
        useStateFromStores(_stores: unknown[], read: () => unknown, _deps: unknown[], equal?: (a: unknown, b: unknown) => boolean) {
            const value = read(); selectors.push({ read, value, equal }); return value;
        }
    };
    const source = readFileSync(process.env.AUDIT_PLATFORM_SOURCE ?? "src/plugins/platformIndicators/index.tsx", "utf8") + "\nexport { PlatformIndicator };";
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React } });
    const api = runInNewContext(`${outputText}\nexports;`, { exports: {}, require: () => modules, React: { createElement: () => null } }) as { PlatformIndicator(props: unknown): unknown; };
    return { api, statuses, writes: () => writes, setStatus(status: string) { sessions = { first: { clientInfo: { client: "desktop" }, status } }; },
        emit() { let changed = 0; for (const entry of selectors) { const next = entry.read(); if (!(entry.equal ?? Object.is)(entry.value, next)) { changed++; entry.value = next; } } return changed; }
    };
}

test("Mounting own platform indicators does not mutate presence or invalidate earlier indicators on unrelated events", () => {
    const f = fixture();
    for (let cycle = 0; cycle < 100; cycle++) f.api.PlatformIndicator({ user: { id: "self" } });
    assert.equal(f.emit(), 0);
    assert.equal(f.writes(), 0);
    assert.equal(f.statuses.self, undefined);
    f.setStatus("dnd");
    assert.equal(f.emit(), 100);
    assert.equal(f.emit(), 0);
});
