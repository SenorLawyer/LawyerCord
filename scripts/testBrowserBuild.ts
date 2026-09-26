/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, isVariableStatement, ScriptTarget } from "typescript";

import { stylePlugin } from "./build/common.mjs";

const source = createSourceFile("buildWeb.mjs", readFileSync("scripts/build/buildWeb.mjs", "utf8"), ScriptTarget.Latest, true);
const code = source.statements.filter(node =>
    isFunctionDeclaration(node) && node.name?.text === "buildExtension" ||
    isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "appendCssRuntime")
).map(node => node.getText(source)).join("\n");

test("managed style modules preserve replacement syntax and placeholder names in CSS", async () => {
    const root = await mkdtemp(join(tmpdir(), "lawyercord-managed-style-"));
    const css = ".fixture::after { content: '$& $$ STYLE_NAME STYLE_SOURCE'; }";
    try {
        await writeFile(join(root, "fixture.css"), css);
        await writeFile(join(root, "index.js"), 'import "./fixture.css?managed";');
        const result = await build({
            entryPoints: [join(root, "index.js")],
            bundle: true, write: false, format: "iife", plugins: [stylePlugin]
        });
        const styles = new Map<string, { source: string; name: string; }>();
        runInNewContext(result.outputFiles[0].text, { window: { VencordStyles: styles } });
        assert.equal(styles.size, 1);
        const [name, style] = [...styles][0];
        assert.equal(style.name, name);
        assert.equal(style.source, css);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("browser packaging replaces stale output without unused editor bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "lawyercord-browser-build-"));
    const at = (path: string) => {
        const result = resolve(root, path);
        assert.ok(result.startsWith(root + sep), "build writes must stay inside the fixture");
        return result;
    };
    const css = '.fixture::after { content: "`${missing}\\\\path"; }\n.next { color: red; }';
    const files = {
        "dist/browser/extension.js": "renderer",
        "dist/browser/extension.css": "styles",
        "dist/browser/fixture-unpacked/stale.js": "old release",
        "dist/LawyerCord.user.css": css,
        "dist/LawyerCord.user.js": "",
        "browser/manifest.json": '{"manifest_version":3}',
        "browser/lawyercord-icon.png": "icon"
    };
    try {
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(at(path), ".."), { recursive: true });
            await writeFile(at(path), content);
        }
        await runInNewContext(`${code}\nPromise.all([appendCssRuntime, buildExtension("fixture-unpacked", ["manifest.json", "lawyercord-icon.png"])]);`, {
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
        assert.equal(await readFile(at("dist/browser/fixture-unpacked/lawyercord-icon.png"), "utf8"), "icon");
        assert.deepEqual(JSON.parse(await readFile(at("dist/browser/fixture-unpacked/manifest.json"), "utf8")), { manifest_version: 3, version: "1.2.3" });
        const unsafeWindow = { _vcUserScriptRendererCss: "" };
        runInNewContext(await readFile(at("dist/LawyerCord.user.js"), "utf8"), { unsafeWindow });
        assert.equal(unsafeWindow._vcUserScriptRendererCss, css);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});


test("native plugin discovery respects renderer target and development restrictions", async () => {
    const source = createSourceFile("build.mjs", readFileSync("scripts/build/build.mjs", "utf8"), ScriptTarget.Latest, true);
    const code = source.statements.filter(node => isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "globNativesPlugin")).map(node => node.getText(source)).join("\n");
    const { getPluginTarget } = await import("./utils.mjs");
    const names = ["ordinary", ".staged", "_disabled", "fixture.dev", "fixture.web", "fixture.desktop", "fixture.discordDesktop", "fixture.vesktop", "fixture.equibop"];
    for (const kind of ["discordDesktop", "equibop"]) for (const IS_DEV of [false, true]) for (const IS_REPORTER of [false, true]) {
        let load: () => Promise<{ contents: string; }> = async () => assert.fail("Missing native loader");
        const plugin = runInNewContext(`${code}\nglobNativesPlugin(kind)`, {
            kind, IS_DEV, IS_REPORTER, getPluginTarget, join, resolve,
            exists: async () => true,
            readdir: async () => names.map(name => ({ name })),
            resolvePluginName: async (_dir: string, file: { name: string; }) => file.name
        });
        plugin.setup({ onResolve() {}, onLoad(_options: object, callback: typeof load) { load = callback; } });
        const { contents } = await load();
        for (const name of names) {
            const excluded = kind === "discordDesktop" ? ["fixture.web", "fixture.vesktop", "fixture.equibop"] : ["fixture.discordDesktop"];
            const expected = !name.startsWith(".") && !name.startsWith("_") && (IS_REPORTER || (!excluded.includes(name) && (name !== "fixture.dev" || IS_DEV)));
            assert.equal(contents.includes(`${name}/native`), expected, `${kind} dev=${IS_DEV} reporter=${IS_REPORTER}: ${name}`);
        }
    }
});
