/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync("src/main/patcher.ts", "utf8");
const calls: string[][] = [];
const commandLine = {
    appendSwitch(...args: string[]) {
        assert.equal(this, commandLine);
        calls.push(args);
    }
};
runInNewContext(source.slice(source.indexOf("    const originalAppend"), source.indexOf("    // disable renderer backgrounding")), { app: { commandLine } });

for (const flags of ["Existing", "Existing,WidgetLayering", "", undefined]) {
    commandLine.appendSwitch("disable-features", ...(flags === undefined ? [] : [flags]));
    assert.deepEqual(calls.pop(), ["disable-features", flags ? "Existing,WidgetLayering,UseEcoQoSForBackgroundProcess" : "WidgetLayering,UseEcoQoSForBackgroundProcess"]);
}
commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
assert.deepEqual(calls.pop(), ["autoplay-policy", "no-user-gesture-required"]);
