/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const levels = ["info", "low", "moderate", "high", "critical"];
const args = process.argv.slice(2);
const level = args[1] ?? "moderate";
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--audit-level");
assert.ok(levels.includes(level), "Choose a valid audit severity.");
assert.ok(process.env.npm_execpath, "Run this check with pnpm auditDependencies.");

const verified = spawnSync(process.execPath, ["scripts/testBracesSecurity.mjs"], { stdio: "inherit" });
assert.equal(verified.status, 0, "The dependency patch verification failed. No advisory exception was applied.");

const audit = spawnSync(process.execPath, [process.env.npm_execpath, "audit", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
assert.ok(audit.status === 0 || audit.status === 1, audit.stderr || "The dependency audit could not run.");
const report = JSON.parse(audit.stdout);
assert.ok(report && typeof report === "object" && !report.error && report.advisories && typeof report.advisories === "object" && !Array.isArray(report.advisories), "The registry did not return a valid dependency audit.");
let failures = 0;
for (const advisory of Object.values(report.advisories)) {
    assert.ok(advisory && typeof advisory === "object" && levels.includes(advisory.severity), "The registry returned an invalid advisory.");
    if (advisory.github_advisory_id === "GHSA-vfj7-8cjw-p6xm" && advisory.module_name === "braces"
        && Array.isArray(advisory.findings) && advisory.findings.length > 0
        && advisory.findings.every(finding => finding.version === "3.0.3" && finding.dev === true
            && Array.isArray(finding.paths) && finding.paths.length > 0 && finding.paths.every(path => typeof path === "string" && path.endsWith(">braces")))) {
        console.log("Verified local mitigation: GHSA-vfj7-8cjw-p6xm in braces 3.0.3. The pinned upstream depth-limit patch passed its regression checks.");
        continue;
    }
    if (levels.indexOf(advisory.severity) >= levels.indexOf(level)) {
        failures++;
        console.error(`${advisory.severity}: ${advisory.title} (${advisory.github_advisory_id ?? advisory.module_name})`);
    }
}
if (failures) {
    console.error(`${failures} unmitigated advisories meet the ${level} audit threshold.`);
    process.exitCode = 1;
} else {
    console.log(`No unmitigated vulnerabilities at or above ${level}.`);
}
