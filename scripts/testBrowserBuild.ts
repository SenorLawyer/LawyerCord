/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ScriptTarget } from "typescript";

const source = createSourceFile("buildWeb.mjs", readFileSync("scripts/build/buildWeb.mjs", "utf8"), ScriptTarget.Latest, true);
const code = source.statements.filter(node =>
    isFunctionDeclaration(node) && node.name?.text === "buildExtension" ||
    isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "appendCssRuntime")
).map(node => node.getText(source)).join("\n");

test("browser packaging replaces stale output without unused editor bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "lawyercord-browser-build-"));
    const at = (path: string) => {
        const result = resolve(root, path);
        assert.ok(result.startsWith(root + sep), "build writes must stay inside the fixture");
        return result;
    };
    const css = ".fixture { color: red; }";
    const files = {
        "dist/browser/extension.js": "renderer",
        "dist/browser/extension.css": "styles",
        "dist/browser/fixture-unpacked/stale.js": "old release",
        "dist/LawyerCord.user.css": css,
        "dist/LawyerCord.user.js": "",
        "browser/manifest.json": '{"manifest_version":3}',
        "browser/icon.png": "icon"
    };
    try {
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(at(path), ".."), { recursive: true });
            await writeFile(at(path), content);
        }
        await runInNewContext(`${code}\nPromise.all([appendCssRuntime, buildExtension("fixture-unpacked", ["manifest.json", "icon.png"])]);`, {
            VERSION: "1.2.3", Buffer, TextEncoder, join,
            console: { info() { } },
            readFile: (path: string, encoding: BufferEncoding) => readFile(at(path), encoding),
            appendFile: (path: string, content: string) => appendFile(at(path), content),
            rm: (path: string, options: Parameters<typeof rm>[1]) => rm(at(path), options),
            mkdir: (path: string, options: Parameters<typeof mkdir>[1]) => mkdir(at(path), options),
            writeFile: (path: string, content: Buffer) => writeFile(at(path), content)
        });
        await assert.rejects(readFile(at("dist/browser/fixture-unpacked/stale.js")), { code: "ENOENT" });
        assert.equal(await readFile(at("dist/browser/fixture-unpacked/dist/LawyerCord.js"), "utf8"), "renderer");
        assert.deepEqual(JSON.parse(await readFile(at("dist/browser/fixture-unpacked/manifest.json"), "utf8")), { manifest_version: 3, version: "1.2.3" });
        const unsafeWindow = { _vcUserScriptRendererCss: "" };
        runInNewContext(await readFile(at("dist/LawyerCord.user.js"), "utf8"), { unsafeWindow });
        assert.equal(unsafeWindow._vcUserScriptRendererCss, css);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
