#!/usr/bin/node
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readdir, readFile, stat } from "fs/promises";
import { basename, relative, resolve } from "path";

import JSZip from "jszip";

const targets = process.argv.slice(2);
const releaseTargets = targets.length > 0 ? targets : ["dist"];
const sensitiveRuntimePath = /(?:^|\/)(?:discord-mcp|control-panel)(?:\/|$)/iu;
const discordCredentialPatterns = [
    /\bmfa\.[A-Za-z0-9_-]{20,}\b/gu,
    /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/gu,
    /["'](?:discord[_-]?)?token["']\s*:\s*["'][A-Za-z0-9._-]{20,}["']/giu,
];
const failures = [];

function normalized(path) {
    return path.replaceAll("\\", "/");
}

function inspectName(path, origin) {
    if (sensitiveRuntimePath.test(normalized(path)))
        failures.push(`${origin}: contains private MCP or control-panel runtime data at ${path}`);
}

function inspectBytes(bytes, origin) {
    const source = bytes.toString("utf8");
    for (const pattern of discordCredentialPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(source)) {
            failures.push(`${origin}: contains a Discord credential-shaped value`);
            return;
        }
    }
}

async function inspectZip(path, origin) {
    const zip = await JSZip.loadAsync(await readFile(path));
    for (const [entryName, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        inspectName(entryName, `${origin} (${basename(path)})`);
        inspectBytes(await entry.async("nodebuffer"), `${origin} (${entryName})`);
    }
}

async function inspectFile(path, origin) {
    inspectName(relative(".", path), origin);
    if (path.toLowerCase().endsWith(".zip")) await inspectZip(path, origin);
    else inspectBytes(await readFile(path), origin);
}

async function inspectTarget(target) {
    const path = resolve(target);
    const metadata = await stat(path);
    if (metadata.isFile()) {
        await inspectFile(path, target);
        return;
    }
    if (!metadata.isDirectory()) throw new Error(`${target} is not a file or directory`);

    const pending = [path];
    while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const entryPath = resolve(directory, entry.name);
            if (entry.isDirectory()) pending.push(entryPath);
            else if (entry.isFile()) await inspectFile(entryPath, normalized(relative(path, entryPath)));
        }
    }
}

for (const target of releaseTargets) await inspectTarget(target);

if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    throw new Error(`Release credential audit failed with ${failures.length} finding(s)`);
}

console.log(`Release credential audit passed for ${releaseTargets.join(", ")}`);
