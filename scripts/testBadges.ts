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
