/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const stylelintRequire = createRequire(require.resolve("stylelint"));
const micromatchRequire = createRequire(stylelintRequire.resolve("micromatch"));
const braces = micromatchRequire("braces");
const patchHash = "37f95f7d660c05bfd44d4b429ca49ceeede99dcff68389f81ee9b995a8ea24d2";

function nested(depth, open = "{", close = "}") {
    return open.repeat(depth) + "a,b" + close.repeat(depth);
}

function nestedAst(depth) {
    let node = { type: "text", value: "a" };
    for (let index = 0; index < depth; index++) node = { type: "brace", nodes: [node] };
    return { type: "root", nodes: [node] };
}

test("the advisory exception is bound to the reviewed patch and every locked braces resolution", () => {
    const patch = readFileSync("patches/braces@3.0.3.patch");
    assert.equal(createHash("sha256").update(patch).digest("hex"), patchHash);
    const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
    assert.doesNotMatch(workspace, /ignoreGhsas|ignoreCves|ignoreUnfixable/);
    assert.match(workspace, /^patchedDependencies:\r?\n +braces@3\.0\.3: patches\/braces@3\.0\.3\.patch$/m);
    const lock = readFileSync("pnpm-lock.yaml", "utf8");
    assert.match(lock, new RegExp(`^patchedDependencies:\\r?\\n +braces@3\\.0\\.3: ${patchHash}$`, "m"));
    const lockedBraces = [...lock.matchAll(/^ {2}braces@([^:\r\n]+):$/gm)].map(match => match[1]);
    assert.deepEqual(lockedBraces.sort(), ["3.0.3", `3.0.3(patch_hash=${patchHash})`]);
    const resolutions = [...lock.matchAll(/^ +braces: (.+)$/gm)].map(match => match[1].trim());
    assert.ok(resolutions.length > 0);
    assert.ok(resolutions.every(version => version === `3.0.3(patch_hash=${patchHash})`));
    assert.equal(micromatchRequire("braces/package.json").version, "3.0.3");
});

for (const method of ["parse", "compile", "expand", "stringify"]) {
    test(`${method} rejects excessive brace and parenthesis depth before stack exhaustion`, () => {
        for (const [open, close] of [["{", "}"], ["(", ")"], ["{(", ")}"]]) {
            const pattern = nested(4100 / open.length, open, close);
            assert.ok(pattern.length < 10000);
            assert.throws(() => braces[method](pattern), /exceeds max depth/);
            assert.throws(() => braces[method](pattern, { maxDepth: 100000 }), /exceeds max depth/);
        }
    });
}

for (const method of ["compile", "expand", "stringify"]) {
    test(`${method} also rejects caller-supplied deeply nested ASTs`, () => {
        assert.throws(() => braces[method](nestedAst(4100)), /exceeds max depth/);
        assert.throws(() => braces[method](nestedAst(101), { maxDepth: Infinity }), /exceeds max depth/);
    });
}

test("the permitted boundary and a stricter caller limit are respected", () => {
    for (const method of ["parse", "compile", "expand", "stringify"]) {
        assert.doesNotThrow(() => braces[method](nested(100)));
        assert.throws(() => braces[method](nested(101)), /exceeds max depth/);
        assert.doesNotThrow(() => braces[method](nested(2), { maxDepth: 2 }));
        assert.throws(() => braces[method](nested(2), { maxDepth: 1 }), /exceeds max depth/);
    }
});

test("normal glob compilation, ranges, escaped and quoted braces keep their behavior", () => {
    assert.deepEqual(braces("src/{api,components}/{*.ts,*.tsx}"), ["src/(api|components)/(*.ts|*.tsx)"]);
    assert.deepEqual(braces.expand("src/{api,components}/{a,b}.ts"), ["src/api/a.ts", "src/api/b.ts", "src/components/a.ts", "src/components/b.ts"]);
    assert.deepEqual(braces.expand("{001..003}"), ["001", "002", "003"]);
    assert.equal(braces.compile(String.raw`\{literal\}`), "{literal}");
    assert.equal(braces.compile(`'${nested(4100)}'`), nested(4100));
    const pattern = "src/{api,{components,utils}}/{a,b}.ts";
    assert.equal(braces.compile(braces.parse(pattern)), braces.compile(pattern));
    assert.equal(braces.stringify(braces.parse(pattern)), pattern);
});
