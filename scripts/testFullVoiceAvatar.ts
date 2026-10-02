/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

function loadPlugin(file: string) {
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText;
    return runInNewContext(`${code}\nexports.default;`, {
        exports: {},
        require: (name: string) => ({
            "@utils/constants": { EquicordDevs: {}, Devs: {} },
            "@utils/misc": { getUserAvatarUrl: () => "https://fixture.invalid/avatar.webp" },
            "@utils/types": { __esModule: true, default: (value: unknown) => value, OptionType: {} },
            "@webpack/common": {
                UserStore: { getUser: () => ({ id: "user" }) },
                VoiceStateStore: { getVoiceStateForUser: () => ({ channelId: "voice" }) },
                ChannelStore: { getChannel: () => ({ guild_id: "guild" }) },
                ChannelRTCStore: { getSpeakingParticipants: () => [] }
            },
            "@api/Settings": { definePluginSettings: () => ({ store: {} }) },
            "@utils/css": { classNameFactory: () => () => "" },
            "@utils/Logger": { Logger: class {} },
            "@webpack": { proxyLazyWebpack: () => ({}) }
        })[name]
    });
}

test("full voice avatars target the tile style without mutating Discord props", () => {
    const plugin = loadPlugin("src/equicordplugins/fullVcPfp/index.tsx");
    const replacement = plugin.patches[0].replacement;
    const original = '(function(){let helper=function(e,t){return e};function Tile(e){let s={...e.style,width:128},r=null;return jsx("div",{style:s,ref:r,"data-selenium-video-tile":true,children:e.children})}return {helper,Tile}})()';
    const patched = original.replace(canonicalizeMatch(replacement.match), replacement.replace);
    assert.notEqual(patched, original);
    const render = runInNewContext(patched, { jsx: (_type: unknown, props: unknown) => props, $self: plugin });
    const style = Object.freeze({ height: 128 });
    const children = Object.freeze({ content: "Avatar" });
    for (const participantUserId of ["user", undefined]) {
        const props = Object.freeze({ style, children, participantUserId, className: "renamed-discord-class" });
        assert.equal(render.helper(props), props);
        const tile = render.Tile(props);
        assert.equal(tile.style.width, 128);
        assert.equal(tile.style.height, 128);
        assert.equal(tile.style["--full-res-avatar"], participantUserId ? "url(https://fixture.invalid/avatar.webp)" : undefined);
        assert.equal(tile.children, children);
        assert.equal(props.style, style);
        assert.deepEqual(style, { height: 128 });
    }
});

test("full voice avatars and USRBG preserve each other's styles in either patch order", () => {
    const avatar = loadPlugin("src/equicordplugins/fullVcPfp/index.tsx");
    const banner = loadPlugin("src/plugins/usrbg/index.tsx");
    banner.getVoiceBackgroundStyles = () => ({ backgroundImage: 'url("https://fixture.invalid/banner.webp")' });
    const original = '(function Tile(e){let s={height:128},r=null;return jsx("div",{style:s,ref:r,"data-selenium-video-tile":true})})';
    for (const plugins of [[avatar, banner], [banner, avatar]]) {
        let patched = original;
        for (const [index, plugin] of plugins.entries()) {
            const replacement = plugin.patches.find((patch: { find: string; }) => patch.find.includes("data-selenium-video-tile")).replacement;
            const next = patched.replace(canonicalizeMatch(replacement.match), replacement.replace.replaceAll("$self", `plugins[${index}]`));
            assert.notEqual(next, patched);
            patched = next;
        }
        const render = runInNewContext(patched, { jsx: (_type: unknown, props: unknown) => props, plugins });
        const tile = render({ participantUserId: "user" });
        assert.equal(tile.style.height, 128);
        assert.equal(tile.style["--full-res-avatar"], "url(https://fixture.invalid/avatar.webp)");
        assert.equal(tile.style.backgroundImage, 'url("https://fixture.invalid/banner.webp")');
    }
});
