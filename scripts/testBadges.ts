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

function loadSource(path: string, mocks: Record<string, object>, globals: Record<string, unknown> = {}, result = "exports") {
    const code = transpileModule(readFileSync(path, "utf8"), {
        fileName: path,
        compilerOptions: { jsx: JsxEmit.React, module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(code + `\n${result};`, {
        exports: {}, ...globals,
        require(name: string) {
            if (name.endsWith(".css")) return {};
            assert.ok(name in mocks, name);
            return mocks[name];
        }
    });
}

const boundary = { __esModule: true, default: { wrap: (component: (props: object) => unknown) => (props: object) => component(props) } };

interface RenderedElement {
    type: unknown;
    props: { key: number; children: RenderedElement; };
}

test("server list boundaries retain their keys when neighbors and priorities change", () => {
    const api: {
        addServerListElement(position: number, component: () => null, priority?: number): void;
        removeServerListElement(position: number, component: () => null): void;
        renderAll(position: number): RenderedElement[];
    } = loadSource("src/api/ServerList.tsx", { "@components/ErrorBoundary": boundary }, {
        React: { createElement: (type: unknown, props: object, children: unknown) => ({ type, props: { ...props, children } }) }
    });
    for (const position of [0, 1, 2]) {
        const first = () => null;
        const second = () => null;
        const inserted = () => null;
        api.addServerListElement(position, first, 10);
        api.addServerListElement(position, second, 0);
        const original = api.renderAll(position);
        const secondKey = original[1].props.key;
        api.removeServerListElement(position, first);
        assert.equal(api.renderAll(position)[0].props.key, secondKey);
        api.addServerListElement(position, inserted, 20);
        assert.equal(api.renderAll(position)[1].props.key, secondKey);
        api.addServerListElement(position, second, 30);
        const reordered = api.renderAll(position);
        assert.equal(reordered[0].props.children.type, second);
        assert.equal(reordered[0].props.key, secondKey);
        assert.notEqual(reordered[0].props.key, reordered[1].props.key);
    }
});

test("badge registration preserves caller objects and dynamic component identity", () => {
    const api = loadSource("src/api/Badges.ts", {
        "@components/ErrorBoundary": boundary,
        "@equicordplugins/globalBadges": { __esModule: true, default: { name: "GlobalBadges" } },
        "@plugins/_api/badges": { __esModule: true, default: { getDonorBadges() {}, getEquicordDonorBadges() {} } },
        "./PluginManager": { isPluginEnabled: () => false }
    });
    const component = () => null;
    const badge = Object.freeze({ id: "static", component });
    api.addProfileBadge(badge);
    api.addProfileBadge({ id: "dynamic", getBadges: () => [{ id: "child", component }] });
    for (let i = 0; i < 3; i++) {
        const rendered = api._getBadges({ userId: "fixture", guildId: "fixture" });
        assert.equal(rendered.length, 2);
        assert.equal(rendered[0].component, component);
        assert.equal(rendered[1].component, component);
        assert.equal(api.removeProfileBadge(badge), true);
        api.addProfileBadge(badge);
    }
});


test("badge refresh remains scheduled after failed startup and handles periodic failures", async () => {
    let tick = () => {};
    let warnings = 0;
    let cleared = 0;
    const { default: plugin } = loadSource("src/plugins/_api/badges/index.tsx", {
        "@api/Badges": { BadgePosition: {} }, "@components/ErrorBoundary": boundary,
        "@components/settings/tabs": {}, "@utils/constants": { Devs: {} }, "@utils/discord": {},
        "@utils/Logger": { Logger: class { warn() { warnings++; } } }, "@utils/misc": {},
        "@utils/types": { __esModule: true, default: (value: object) => value },
        "@webpack/common": {}, "~plugins": {}, "./modals": {},
    }, {
        fetch: async () => { throw new Error("offline"); },
        setInterval: (callback: () => void) => { tick = callback; return 1; },
        clearInterval: (id: number | undefined) => { if (id !== undefined) cleared++; },
    });
    await plugin.start();
    assert.equal(warnings, 1);
    tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings, 2);
    await plugin.stop();
    assert.equal(cleared, 1);
});
