/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

async function fixture() {
    const protocols = new Map<string, (request: { url: string; }) => Response | string>();
    const fetches: string[] = [];
    const themes = resolve("fixture-themes");
    const directory = resolve("fixture-dist");
    const source = readFileSync(process.env.AUDIT_PROTOCOL_SOURCE ?? "src/main/index.ts", "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, {
        exports: {}, __dirname: directory, Response, IS_EXTENSION: false, IS_DISCORD_DESKTOP: false,
        require(name: string) {
            if (name === "electron") return {
                app: { whenReady: () => Promise.resolve() },
                protocol: { handle: (scheme: string, handler: (request: { url: string; }) => Response | string) => protocols.set(scheme, handler) },
                net: { fetch: (url: string) => { fetches.push(url); return url; } }
            };
            if (name === "path") return { join };
            if (name === "url") return { pathToFileURL };
            if (name === "./csp") return { initCsp() { } };
            if (name === "./settings") return { RendererSettings: { store: {} } };
            if (name === "./utils/constants") return { IS_VANILLA: false, THEMES_DIR: themes };
            if (name === "./utils/extensions") return {};
            if (name === "./ipcMain") return { ensureSafePath(root: string, child: string) {
                const target = resolve(root, child);
                return target.startsWith(root + sep) ? target : undefined;
            } };
            throw new Error(`Unexpected module ${name}`);
        }
    });
    await Promise.resolve();
    assert.equal(protocols.size, 3);
    return { protocols, fetches, themes, directory };
}

test("Malformed client protocol escapes return not found without reaching filesystem fetch", async () => {
    const f = await fixture();
    for (const [scheme, handler] of f.protocols) {
        for (const path of ["%", "%GG", "%E0%A4", "/themes/%EF"]) {
            const result = handler({ url: `${scheme}://${path}` });
            assert.ok(result instanceof Response);
            assert.equal(result.status, 404);
        }
    }
    assert.deepEqual(f.fetches, []);
});

test("Client protocol retains theme decoding, path validation and source map allowlist", async () => {
    const f = await fixture();
    for (const [scheme, handler] of f.protocols) {
        assert.equal(handler({ url: `${scheme}:///themes/My%20theme.css?v=123` }), pathToFileURL(join(f.themes, "My theme.css")).toString());
        for (const map of ["renderer.js.map", "preload.js.map", "patcher.js.map", "main.js.map"]) {
            assert.equal(handler({ url: `${scheme}://${map}/` }), pathToFileURL(join(f.directory, map)).toString());
        }
        for (const path of ["/themes/../private", "private", "unknown.js.map"]) {
            const result = handler({ url: `${scheme}://${path}` });
            assert.ok(result instanceof Response);
            assert.equal(result.status, 404);
        }
    }
    assert.equal(f.fetches.length, 15);
});
