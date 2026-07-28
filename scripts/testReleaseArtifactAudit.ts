/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import JSZip from "jszip";

const auditScript = resolve("scripts/auditReleaseArtifacts.mjs");

function runAudit(target: string) {
    return spawnSync(process.execPath, [auditScript, target], {
        encoding: "utf8",
        windowsHide: true,
    });
}

async function main() {
    const root = await mkdtemp(join(tmpdir(), "lawyercord-release-audit-"));
    try {
        const safeDirectory = join(root, "safe");
        await mkdir(safeDirectory);
        await writeFile(join(safeDirectory, "renderer.js"), "console.log('safe release');");
        assert.equal(runAudit(safeDirectory).status, 0, "ordinary release files pass");

        const runtimeDirectory = join(root, "runtime");
        await mkdir(join(runtimeDirectory, "discord-mcp"), { recursive: true });
        await writeFile(join(runtimeDirectory, "discord-mcp", "config.json"), "{}");
        assert.notEqual(runAudit(runtimeDirectory).status, 0, "MCP runtime configuration is rejected");

        const tokenDirectory = join(root, "token");
        await mkdir(tokenDirectory);
        await writeFile(join(tokenDirectory, "bundle.js"), `"token":"${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(30)}"`);
        assert.notEqual(runAudit(tokenDirectory).status, 0, "Discord credential-shaped values are rejected");

        const zip = new JSZip();
        zip.file("control-panel/config.json", "{}");
        const archivePath = join(root, "unsafe.zip");
        await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
        assert.notEqual(runAudit(archivePath).status, 0, "private runtime paths inside archives are rejected");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
    console.log("release credential-audit checks passed");
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
