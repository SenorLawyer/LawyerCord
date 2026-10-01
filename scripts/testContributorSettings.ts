/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { SettingsStore } from "../src/shared/SettingsStore";

function fixture() {
    const source = readFileSync(process.env.AUDIT_CONTRIBUTOR_SOURCE ?? "src/components/settings/tabs/plugins/ContributorModal.tsx", "utf8");
    const start = source.indexOf(") {", source.indexOf("function ContributorModal")) + 3;
    const end = source.indexOf("    const ContributedHyperLink", start);
    assert.ok(start >= 3 && end > start);
    const settingsSource = readFileSync("src/api/Settings.ts", "utf8").replaceAll("\r\n", "\n");
    const hookStart = settingsSource.indexOf("export function useSettings(");
    const hookEnd = settingsSource.indexOf("\n}", hookStart) + 2;
    assert.ok(hookStart >= 0 && hookEnd > hookStart);
    const { outputText } = transpileModule(`${settingsSource.slice(hookStart, hookEnd)}\nfunction render(user) { ${source.slice(start, end)} return { profile, plugins }; }`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const store = new SettingsStore({ plugins: { Authored: { enabled: false, value: 0 }, Other: { enabled: false }, NotRelated: { enabled: false, value: 0 } }, theme: "dark" });
    const cleanups: (() => void)[] = [];
    const selectorDeps: unknown[][] = [];
    let updates = 0;
    let fetches = 0;
    let warnings = 0;
    let fetching = false;
    const render = runInNewContext(`${outputText}\nrender;`, {
        exports: {},
        React: { useReducer: () => [null, () => { updates++; }] },
        Settings: store.store, SettingsStore: store,
        useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
        useMemo: (callback: () => unknown) => callback(),
        useStateFromStores: (_stores: unknown[], selector: () => unknown, deps?: unknown[]) => { selectorDeps.push(deps ?? []); return selector(); },
        UserProfileStore: { getUserProfile: (id: string) => fetching ? undefined : { userId: id, connectedAccounts: [] } },
        fetchUserProfile: () => { fetches++; return Promise.reject(new Error("Profile unavailable")); },
        logger: { warn() { warnings++; } },
        Plugins: {
            Authored: { name: "Authored", authors: [{ id: "first", name: "First" }] },
            Other: { name: "Other", authors: [{ id: "second", name: "Second" }] },
            HiddenAPI: { name: "HiddenAPI", authors: [{ id: "first", name: "First" }] }
        },
        PluginMeta: {}, VencordDevsById: { first: {}, second: {} }, EquicordDevsById: {}
    }) as (user: { id: string; username: string; bot: boolean; }) => { plugins: { name: string; }[]; profile: { userId: string; } | undefined; };
    return { store, selectorDeps, updates: () => updates, fetches: () => fetches, warnings: () => warnings,
        render(id = "first") { cleanups.splice(0).forEach(cleanup => cleanup()); return render({ id, username: id, bot: false }); },
        fetch() { fetching = true; },
        unmount() { cleanups.splice(0).forEach(cleanup => cleanup()); }
    };
}

test("contributor cards subscribe to displayed enable flags rather than every settings change", () => {
    const f = fixture();
    assert.deepEqual(Array.from(f.render().plugins, plugin => plugin.name), ["Authored"]);
    for (let i = 1; i <= 100; i++) f.store.store.plugins.NotRelated.value = i;
    f.store.store.theme = "light";
    f.store.store.plugins.Authored.value = 1;
    assert.equal(f.updates(), 0);
    f.store.store.plugins.Authored.enabled = true;
    assert.equal(f.updates(), 1);
    f.render("second");
    f.store.store.plugins.Authored.enabled = false;
    assert.equal(f.updates(), 1);
    f.store.store.plugins.Other.enabled = true;
    assert.equal(f.updates(), 2);
    f.unmount(); f.store.store.plugins.Other.enabled = false;
    assert.equal(f.updates(), 2);
});

test("contributor profile subscriptions retain their displayed user dependency", () => {
    const f = fixture(); f.render(); f.render("second");
    assert.deepEqual(Array.from(f.selectorDeps[0]), ["first"]);
    assert.deepEqual(Array.from(f.selectorDeps[1]), ["second"]);
    f.unmount();
});

test("contributor profile lookup failures are handled", async () => {
    const f = fixture(); f.fetch(); f.render();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(f.fetches(), 1);
    assert.equal(f.warnings(), 1);
    f.unmount();
});
