/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createSourceFile, isExportDeclaration, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("the shared button follows initialization of its compatibility module", () => {
    const source = createSourceFile("components.ts", readFileSync("src/webpack/common/components.ts", "utf8"), ScriptTarget.Latest, true);
    const declaration = source.statements.find(node =>
        isExportDeclaration(node) && node.getText(source).includes("ButtonCompat as Button") ||
        isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === "Button")
    );
    assert.ok(declaration);
    const code = transpileModule(`import { ButtonCompat } from "button";\n${declaration.getText(source)}`, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    const buttonModule: { ButtonCompat?: { Sizes: { SMALL: string; }; }; } = {};
    const exports: { Button?: typeof buttonModule.ButtonCompat; } = {};
    runInNewContext(code, { exports, require: () => buttonModule });
    buttonModule.ButtonCompat = { Sizes: { SMALL: "small" } };
    assert.equal(exports.Button, buttonModule.ButtonCompat);
    assert.equal(exports.Button?.Sizes.SMALL, "small");
});

test("modals do not resolve Discord components until their chunks are ready", () => {
    let ready = false;
    let resolved = 0;
    const exports: Record<string, (props: object) => unknown> = {};
    const modules: Record<string, unknown> = {
        "@utils/react": { useAwaiter: () => [ready] },
        "./react": { React: { createElement: (component: () => unknown) => component() } },
        "@webpack": {
            extractAndLoadChunksLazy: () => async () => { ready = true; return true; },
            findExportedComponentLazy: (name: string) => () => { assert.equal(ready, true); resolved++; return name; },
            findByCodeLazy: () => null,
            mapMangledModuleLazy: () => ({}),
            filters: { byCode: () => null }
        }
    };
    const code = transpileModule(readFileSync("src/webpack/common/modals.ts", "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(code, { exports, require: (name: string) => modules[name] });
    assert.equal(exports.Modal({}), null);
    assert.equal(exports.ConfirmModal({}), null);
    assert.equal(resolved, 0);
    ready = true;
    assert.equal(exports.Modal({}), "Modal");
    assert.equal(exports.ConfirmModal({}), "ConfirmModal");
    assert.equal(resolved, 2);
});
