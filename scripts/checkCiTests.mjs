#!/usr/bin/node
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from "fs/promises";

const notInCi = {
    test: "local aggregate of the CI steps",
    test: "local aggregate of the CI steps",
    testSecureMessagingLive: "live test against real Discord",
    testDiscordMcpLive: "live test against real Discord",
    testAutomationEditorLive: "live test against a running Discord client",
    testWeb: "local dev convenience",
};

const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
const workflow = await readFile(".github/workflows/ci.yml", "utf8");
const ciWords = new Set(workflow.split(/[^A-Za-z0-9_:-]+/u));
const missing = Object.keys(scripts).filter(name => name.startsWith("test") && !(name in notInCi) && !ciWords.has(name));
const stale = Object.keys(notInCi).filter(name => !(name in scripts));

for (const name of missing) console.error(`package.json script ${name} never runs in .github/workflows/ci.yml`);
for (const name of stale) console.error(`${name} is allowlisted in scripts/checkCiTests.mjs but missing from package.json`);
if (missing.length > 0 || stale.length > 0) process.exit(1);
console.log("Every test script runs in CI or is an allowlisted live test");
