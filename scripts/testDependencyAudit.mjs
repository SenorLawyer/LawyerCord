/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "lawyercord-audit-"));
after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "lawyercord-audit-"));
    rmSync(directory, { recursive: true, force: true });
});
const manager = join(directory, "pnpm.cjs");
const known = {
    github_advisory_id: "GHSA-vfj7-8cjw-p6xm", module_name: "braces", title: "Deep nesting", severity: "high",
    findings: [{ version: "3.0.3", dev: true, paths: [".>stylelint>micromatch>braces"] }]
};

function run(report, level = "moderate", status = 1) {
    writeFileSync(manager, `process.stdout.write(${JSON.stringify(typeof report === "string" ? report : JSON.stringify(report))}); process.exitCode = ${status};`);
    return spawnSync(process.execPath, ["scripts/auditDependencies.mjs", "--audit-level", level], {
        env: { ...process.env, npm_execpath: manager }, encoding: "utf8"
    });
}

test("only the verified exact advisory and patched development version are excepted", () => {
    const accepted = run({ advisories: { known } });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Verified local mitigation/);
    for (const changed of [
        { ...known, module_name: "another-package" },
        { ...known, github_advisory_id: "GHSA-other-issue" },
        { ...known, findings: [{ version: "3.0.2", dev: true, paths: [".>stylelint>braces"] }] },
        { ...known, findings: [{ version: "3.0.3", dev: false, paths: [".>braces"] }] }
    ]) assert.equal(run({ advisories: { changed } }).status, 1);
});

test("unrelated advisories still fail at the caller's original severity threshold", () => {
    const unrelated = { ...known, github_advisory_id: "GHSA-other-issue", severity: "low" };
    assert.equal(run({ advisories: { known, unrelated } }, "moderate").status, 0);
    assert.equal(run({ advisories: { known, unrelated } }, "low").status, 1);
    assert.equal(run({ advisories: { known, unrelated: { ...unrelated, severity: "critical" } } }).status, 1);
});

test("registry failures, malformed output and audit process errors cannot pass", () => {
    for (const report of ["not JSON", { error: { message: "Registry unavailable" } }, {}, { advisories: [] }, { advisories: { unexpected: {} } }])
        assert.equal(run(report).status, 1);
    assert.equal(run({ advisories: {} }, "moderate", 2).status, 1);
});

test("a clean registry report passes without claiming an advisory was mitigated", () => {
    const result = run({ advisories: {} }, "moderate", 0);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Verified local mitigation/);
});
