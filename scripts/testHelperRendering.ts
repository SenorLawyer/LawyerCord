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

function loadHelper(file: string) {
    let scans = 0;
    let hooks = 0;
    const registry = new Proxy({
        Short: { name: "Short" }, LongerName: { name: "LongerName" },
        Core: { name: "Core", isDependency: true }, BuiltIn: { name: "BuiltIn", required: true },
        Consumer: { name: "Consumer", dependencies: ["Core"] }
    }, { ownKeys: target => { scans++; return Reflect.ownKeys(target); } });
    const enabled = new Set(["Consumer"]);
    const mocks: Record<string, unknown> = {
        "./pluginCards.css": {}, "./utils": { toggleEnabled: async () => true },
        "@api/PluginManager": { plugins: registry, isPluginEnabled: (id: string) => enabled.has(id), isPluginRequired: (id: string) => id === "Core" || id === "BuiltIn" },
        "@api/Settings": { useSettings: () => { hooks++; } },
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": { WarningIcon: "warning" }, "@components/settings": { AddonCard: "addon" },
        "@components/settings/tabs/plugins": { ExcludedReasons: {}, PluginDependencyList: "dependencies" },
        "@components/settings/tabs/plugins/PluginCard": { PluginCard: "plugin" },
        "@components/TooltipContainer": { TooltipContainer: "tooltipContainer" },
        "@utils/constants": { EQUIBOT_USER_ID: "bot" }, "@utils/Logger": { Logger: class { error() {} } },
        "@utils/misc": { isEquicordGuild: (id: string) => id === "support", isEquicordSupport: (id: string) => id === "staff" },
        "~plugins": { __esModule: true, default: registry, ExcludedPlugins: {} },
        "@webpack/common": {
            React: { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props, children }) },
            Button: { Colors: {}, Sizes: {} }, Tooltip: "tooltip", showToast: () => {}, Toasts: { Type: {} },
            useMemo: (factory: () => unknown) => { hooks++; return factory(); }
        }
    };
    const { outputText } = transpileModule(readFileSync(`src/equicordplugins/equicordHelper/${file}.tsx`, "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const exports = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, URL, React: { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props, children }) },
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; }
    });
    return { exports, enabled, scans: () => scans, hooks: () => hooks };
}

test("support buttons skip registry scans on ordinary messages and preserve longest-name toggles", () => {
    const fixture = loadHelper("pluginButtons");
    const render = (content: string, channel = "support", author = "staff") => fixture.exports.PluginButtons({
        message: { content, channel_id: channel, author: { id: author } }
    });
    for (const args of [["Hello `Short`"], ["enable `Short`", "other"], ["enable `Short`", "support", "other"], ["enable plugins"]]) {
        assert.equal(render(...args as [string, string?, string?]), null);
    }
    assert.equal(fixture.scans(), 0);
    const button = render("Enable `Short` and `LongerName`").children.flat()[0];
    assert.equal(button.children[0], "Enable LongerName");
    assert.equal(button.props.disabled, false);
    fixture.enabled.add("LongerName");
    assert.equal(render("Enable `LongerName`").children.flat()[0].props.disabled, true);
    assert.equal(render("Disable `LongerName`").children.flat()[0].children[0], "Disable LongerName");
    assert.equal(render("Disable `BuiltIn`"), null);
});

test("plugin card hook count is stable for known, missing and required plugins", () => {
    const fixture = loadHelper("pluginCards");
    const render = (name: string) => fixture.exports.ChatPluginCard({ url: `https://equicord.org/plugins/${name}`, description: "" });
    for (const name of ["Short", "Missing", "Core", "BuiltIn"]) {
        const before = fixture.hooks();
        const card = render(name);
        assert.equal(fixture.hooks() - before, 1);
        if (name === "Core") assert.deepEqual(Array.from(card.props.text.props.deps), ["Consumer"]);
        if (name === "BuiltIn") assert.equal(typeof card.props.text, "string");
    }
    fixture.enabled.clear();
    assert.equal(typeof render("Core").props.text, "string");
});
