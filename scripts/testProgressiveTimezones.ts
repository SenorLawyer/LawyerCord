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

test("Timezone message rows share system timezone discovery while still observing timezone changes", () => {
    const source = readFileSync("src/equicordplugins/timezones/index.tsx", "utf8");
    const block = source.slice(source.indexOf("export let timezones"), source.indexOf("const classes ="));
    const compiled = transpileModule(block, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    let constructions = 0;
    let zone = "Europe/Amsterdam";
    let now = 1000;
    const api = runInNewContext(`${compiled};exports`, { exports: {}, Date: { now: () => now }, Intl: {
        DateTimeFormat() { constructions++; return { resolvedOptions: () => ({ timeZone: zone }) }; }
    } });
    for (let render = 0; render < 1000; render++) assert.equal(api.getSystemTimezone(), zone);
    assert.equal(constructions, 1);
    now += 60_001;
    zone = "America/New_York";
    assert.equal(api.getSystemTimezone(), zone);
    assert.equal(constructions, 2);
});

const profileOwner = "function N(e){let{user:t,displayProfile:n,guildId:a,pendingBanner:g,overlay:N,className:C,avatarSize:O,avatarOffsetX:R,avatarOffsetY:L,bannerWidth:y,bannerHeight:D,themePadding:v,pendingAccentColor:b,animateOnHoverOrFocusOnly:M=!1}=e,[P,U]=r.useState(!1),w=(0,o.bG)([h.A],()=>h.A.isFocused()),G=A.kt.getSetting(),x=(0,f.Nx)(),{bannerSrc:k,status:F}=(0,p.A)({displayProfile:n,pendingBanner:g,size:y,canAnimate:M||!G?P:w}),B=x?null:k??null,V=(0,c.r)(d.A.unsafe_rawColors.PRIMARY_800).hex(),H=t.getAvatarURL(a,(0,u.FT)(O)),j=(0,l.LX)((0,_.Ay)(H,V,!1)),W=(0,E.A)(b??n?.primaryColor??j).hex,Y={align:\"start\",insetStart:R-v,insetBottom:L+v,radius:(0,m.A)(O)};return(0,i.jsx)(T.A,{fillClassName:s()(S.v,C),bannerSrc:B,backgroundColor:\"COMPLETE\"===F||x?W:d.A.unsafe_rawColors.PRIMARY_800.css,showGifTag:!G&&(0,I.o4)(B),height:D,cutout:Y,overlay:N,onInteractionStart:()=>U(!0),onInteractionEnd:()=>U(!1)})}";
const profileBanner = "function o(e){let{bannerSrc:t,backgroundColor:n,showGifTag:r=!1,height:o,width:d,cutout:c,onInteractionStart:u,onInteractionEnd:_,className:E,fillClassName:A,overlay:h}=e,I={\"--custom-cutout-radius\":`${c.radius}px`,\"--custom-cutout-x\":\"center\"===c.align?\"50%\":`${c.insetStart+c.radius}px`,\"--custom-cutout-y\":`calc(100% - ${c.insetBottom}px)`};return(0,i.jsx)(\"div\",{className:a()(l.vK,E),style:{height:o,width:d??\"100%\"},children:(0,i.jsxs)(\"div\",{className:a()(l.GS,A),style:{...I,backgroundImage:null!=t&&\"\"!==t?`url(${t})`:void 0,backgroundColor:n},onMouseMove:u,onMouseLeave:_,children:[r&&(0,i.jsx)(s.A,{className:l.pH}),h]})})}";

function loadProfile() {
    const source = readFileSync("src/equicordplugins/timezones/index.tsx", "utf8");
    const settings = { store: { showProfileTime: true, showOwnTimezone: true } };
    const render = source.slice(source.indexOf("    renderProfileTimezone:"), source.indexOf("    renderMessageTimezone:"));
    const compiled = transpileModule(`const plugin = {${render}}; plugin;`, {
        compilerOptions: { target: ScriptTarget.ES2022, jsx: 2, jsxFactory: "jsx" }
    }).outputText;
    const plugin = runInNewContext(compiled, {
        settings,
        UserStore: { getCurrentUser: () => ({ id: "self" }) },
        TimestampComponent: "Timestamp",
        jsx: (type: string, props: { userId: string; }) => ({ type, props })
    });
    const patches = runInNewContext(source.slice(source.indexOf("patches: [") + 9, source.indexOf("    toolboxActions:")).trim().replace(/,$/, "")) as { find: string; replacement: { match: RegExp; replace: string; }; }[];
    function patch(factory: string) {
        for (const entry of patches) {
            if (!factory.includes(entry.find)) continue;
            const match = new RegExp(entry.replacement.match.source.replace(/\\i/g, "[A-Za-z_$][\\w$]*"), entry.replacement.match.flags);
            assert.match(factory, match);
            factory = factory.replace(match, entry.replacement.replace);
        }
        return factory;
    }
    return { plugin, settings, patch };
}

for (const bannerSrc of [null, "https://cdn.discordapp.com/banners/123/global.png", "https://cdn.discordapp.com/guilds/456/users/123/banners/guild.png"]) {
    test(`Profile timezone follows the user with banner ${bannerSrc}`, () => {
        const { plugin, settings, patch } = loadProfile();
        const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
        const owner = runInNewContext(`(${patch(profileOwner)})`, {
            i: { jsx }, r: { useState: () => [false, () => {}] },
            o: { bG: () => true }, h: { A: {} }, A: { kt: { getSetting: () => true } },
            f: { Nx: () => false }, p: { A: () => ({ bannerSrc, status: "COMPLETE" }) },
            c: { r: () => ({ hex: () => "black" }) }, d: { A: { unsafe_rawColors: { PRIMARY_800: {} } } },
            u: { FT: () => 80 }, l: { LX: () => "black" }, _: { Ay: () => "black" },
            E: { A: () => ({ hex: "black" }) }, m: { A: () => 40 },
            T: { A: "Banner" }, s: () => () => "banner", S: {}, I: { o4: () => false }
        });
        const leaf = runInNewContext(`(${patch(profileBanner)})`, {
            i: { jsx, jsxs: jsx }, a: () => () => "banner", l: {}, s: { A: "GifTag" }, $self: plugin
        });
        function render(id: string) {
            const banner = owner({ user: { id, getAvatarURL: () => "avatar" }, avatarSize: 80, avatarOffsetX: 0, avatarOffsetY: 0, themePadding: 0 });
            return leaf(banner.props).props.children.props.children[0];
        }
        assert.equal(render("123")?.props.userId, "123");
        assert.equal(render("self")?.props.userId, "self");
        settings.store.showOwnTimezone = false;
        assert.equal(render("self"), null);
        assert.equal(render("123")?.props.userId, "123");
        settings.store.showProfileTime = false;
        assert.equal(render("123"), null);
    });
}
