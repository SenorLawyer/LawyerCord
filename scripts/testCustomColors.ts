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

test("message colors follow the message channel without reading selected-channel state", async () => {
    for (const selected of [undefined, { isDM: () => true, isMultiUserDM: () => false }, { isDM: () => false, isMultiUserDM: () => false }]) {
        let selectedReads = 0;
        let errors = 0;
        const store = { colorInServers: false };
        const mocks: Record<string, unknown> = {
            "./styles.css": {}, "@api/ContextMenu": {}, "@api/DataStore": { get: async () => ({ user: "abcdef" }) },
            "@api/Settings": { definePluginSettings: () => ({ store }), Settings: { plugins: { CustomUserColors: { enabled: true } } } },
            "@utils/constants": { EquicordDevs: {} },
            "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
            "@webpack": { extractAndLoadChunksLazy: () => () => {} }, "./SetColorModal": {},
            "@webpack/common": {
                ChannelStore: { getChannel: () => { selectedReads++; return selected; } },
                SelectedChannelStore: { getChannelId: () => { selectedReads++; return "selected"; } }, Menu: {}
            }
        };
        const { outputText } = transpileModule(readFileSync("src/equicordplugins/customUserColors/index.tsx", "utf8"), {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
        });
        const { default: plugin } = runInNewContext(`${outputText}\nexports;`, {
            exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
            console: { error: () => { errors++; } }
        });
        await plugin.start();
        const props = { colorString: "original", colorStrings: { primaryColor: "original", secondaryColor: "gradient", tertiaryColor: "third" } };
        const context = { message: { author: { id: "user" }, channel_id: "message-channel" }, author: { colorString: "original" }, channel: {} };
        const dm = plugin.wrapMessageColorProps(props, context);
        assert.equal(dm.colorString, "#abcdef");
        assert.equal(dm.colorStrings.secondaryColor, undefined);
        assert.equal(props.colorStrings.secondaryColor, "gradient");
        const server = { ...context, channel: { guild_id: "guild" } };
        assert.equal(plugin.wrapMessageColorProps(props, server), props);
        store.colorInServers = true;
        assert.equal(plugin.wrapMessageColorProps(props, server).colorString, "#abcdef");
        const preview = { ...context, message: { channel_id: "1337", author: { id: "313337" } } };
        assert.equal(plugin.wrapMessageColorProps(props, preview), props);
        assert.equal(selectedReads, 0);
        assert.equal(errors, 0);
        plugin.stop();
    }
});
