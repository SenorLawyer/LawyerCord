/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext, Script } from "node:vm";

import ts from "typescript";

import { canonicalizeMatch } from "../src/utils/patches";

interface Replacement {
    match: RegExp;
    replace: string;
}

interface FixturePatch {
    find: string;
    replacement: Replacement | Replacement[];
}

const source = ts.createSourceFile("index.tsx", readFileSync("src/equicordplugins/clickableRoles/index.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find(ts.isExportAssignment);
assert.ok(declaration && ts.isCallExpression(declaration.expression));
const options = declaration.expression.arguments[0];
assert.ok(ts.isObjectLiteralExpression(options));
const property = options.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(source) === "patches");
assert.ok(property && ts.isPropertyAssignment(property));
const patches: FixturePatch[] = runInNewContext(`(${property.initializer.getText(source)})`);

function applyAndCompile(factory: string, patch: FixturePatch) {
    factory = "0," + (factory.startsWith("(") ? "" : "function") + factory.slice(factory.indexOf("("));
    new Script(factory);
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    for (const replacement of replacements) {
        const match = canonicalizeMatch(replacement.match);
        assert.equal([...factory.matchAll(new RegExp(match.source, "g"))].length, 1);
        factory = factory.replace(match, replacement.replace);
        new Script(factory);
    }
    return factory;
}

test("role pill wrappers compile after each replacement and preserve JSX arguments", () => {
    for (const jsx of ["jsx", "jsxs"]) {
        const args = '("div",{children:[(0,t.jsx)("span",{})]},"role-key")';
        const factory = `function(e){let l=e.role,C="blue",v=l.colorString??C;return(0,t.${jsx})${args}}`;
        const patched = applyAndCompile(factory, patches[0]);
        assert.ok(patched.includes("$self.wrapRolePill(arguments[0],"));
        assert.ok(patched.endsWith(`${args}}`));
    }
});

test("role group wrappers compile independently and target only the role memo", () => {
    for (const fields of ["id:t,title:s,count:r,guildId:a", "guildId:a,count:r,title:s,id:t"]) {
        const unrelated = 'i.memo(function(e){let{title:t,count:c}=e;return t})';
        const role = `function(e){let{${fields}}=e;return t}`;
        const patched = applyAndCompile(`function(){let other=${unrelated},role=i.memo(${role});return role}`, patches[1]);
        assert.ok(patched.includes(unrelated));
        assert.ok(patched.includes(`$self.wrapRoleGroup(fn)))(${role})`));
    }
});

const liveFixture = process.env.CLICKABLE_ROLES_FACTORY_FIXTURE;
if (liveFixture) {
    const factories: Record<string, unknown> = JSON.parse(readFileSync(liveFixture, "utf8"));
    for (const [index, id] of [166005, 946228].entries()) {
        test(`live factory ${id} matches once and compiles after each replacement without execution`, () => {
            const factory = factories[String(id)];
            assert.ok(typeof factory === "string");
            assert.ok(factory.includes(canonicalizeMatch(patches[index].find)));
            applyAndCompile(factory, patches[index]);
        });
    }
}
