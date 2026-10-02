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

import { normalizeStoredGuildIcons } from "../src/equicordplugins/clientsideGuildIcons/iconStorage";

function pending<T>() {
    let resolve: (value: T) => void = () => assert.fail("Promise not initialized");
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(initial: Record<string, unknown> = {}) {
    const pickers: ReturnType<typeof pending<File>>[] = [];
    const writes: { commit: () => void; }[] = [];
    const activeUrls = new Set<string>();
    let persisted = initial;
    let nextUrl = 0;
    const write = (transform: (value: Record<string, unknown>) => Record<string, unknown>) => new Promise<void>(resolve => {
        writes.push({ commit: () => { persisted = transform(persisted); resolve(); } });
    });
    const mocks: Record<string, unknown> = {
        "@api/DataStore": {
            get: async () => persisted,
            set: (_key: string, value: Record<string, unknown>) => write(() => value),
            update: (_key: string, transform: (value: Record<string, unknown>) => Record<string, unknown>) => write(transform)
        },
        "@components/Icons": {}, "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@utils/web": { chooseFile: () => { const picker = pending<File>(); pickers.push(picker); return picker.promise; } },
        "./iconStorage": {
            normalizeStoredGuildIcons,
            readStoredGuildIcons: (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value : {}
        },
        "@webpack/common": {
            FluxDispatcher: { dispatch: () => {} }, GuildStore: { getGuild: () => undefined },
            Toasts: { genId: () => "toast", show: () => {}, Type: { SUCCESS: "success", FAILURE: "failure" } },
            Menu: { MenuGroup: "group", MenuItem: "item" }
        }
    };
    const { outputText } = transpileModule(readFileSync("src/equicordplugins/clientsideGuildIcons/index.tsx", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React }
    });
    const { default: plugin } = runInNewContext(`${outputText}\nexports;`, {
        exports: {}, require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; },
        React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
        URL: {
            createObjectURL: () => { const url = `blob:${++nextUrl}`; activeUrls.add(url); return url; },
            revokeObjectURL: (url: string) => activeUrls.delete(url)
        }
    });
    function change(id: string) {
        const children: { children: { props: { action: () => void; }; }[]; }[] = [];
        plugin.contextMenus["guild-context"](children, { guild: { id, name: id } });
        children[0].children[0].props.action();
        return pickers[pickers.length - 1];
    }
    return { plugin, change, writes, activeUrls, stored: () => persisted };
}

function icon() {
    return Object.assign(new Blob(["image"], { type: "image/png" }), { name: "icon.png" }) as File;
}

test("overlapping guild icon saves preserve both guilds", async () => {
    const h = harness();
    await h.plugin.start();
    const firstIcon = icon();
    const secondIcon = icon();
    h.change("first").resolve(firstIcon);
    h.change("second").resolve(secondIcon);
    await flush();
    assert.equal(h.writes.length, 2);
    h.writes[0].commit();
    h.writes[1].commit();
    await flush();
    assert.equal(h.stored().first, firstIcon);
    assert.equal(h.stored().second, secondIcon);
    assert.equal(h.activeUrls.size, 2);
    h.plugin.stop();
    assert.equal(h.activeUrls.size, 0);
});

test("an old picker cannot save after stop and restart", async () => {
    const h = harness();
    await h.plugin.start();
    const picker = h.change("guild");
    h.plugin.stop();
    await h.plugin.start();
    picker.resolve(icon());
    await flush();
    assert.equal(h.writes.length, 0);
    assert.equal(h.activeUrls.size, 0);
});

test("a pending icon write cannot recreate URLs after stop", async () => {
    const h = harness();
    await h.plugin.start();
    h.change("guild").resolve(icon());
    await flush();
    assert.equal(h.writes.length, 1);
    h.plugin.stop();
    h.writes[0].commit();
    await flush();
    assert.equal(h.activeUrls.size, 0);
    assert.equal(Object.keys(h.plugin.data.icons).length, 0);
});

test("an extension-identified image retains its MIME type across restart", async () => {
    const h = harness();
    await h.plugin.start();
    h.change("guild").resolve(Object.assign(new Blob(["image"]), { name: "icon.JPG" }) as File);
    await flush();
    h.writes[0].commit();
    await flush();
    assert.equal((h.stored().guild as Blob).type, "image/jpeg");
    h.plugin.stop();
    await h.plugin.start();
    assert.equal(h.activeUrls.size, 1);
    h.plugin.stop();
});

test("loading legacy icons does not overwrite storage during startup", async () => {
    const original = { guild: "data:image/png;base64,aW1hZ2U=", invalid: "not-an-image" };
    const h = harness(original);
    await h.plugin.start();
    assert.equal(h.activeUrls.size, 1);
    assert.equal(h.writes.length, 0);
    assert.equal(h.stored(), original);
    h.plugin.stop();
});
