/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("Remembered users changed during a save remain dirty for the next save", async () => {
    const writes: (() => void)[] = [];
    const code = transpileModule(readFileSync("src/equicordplugins/iRememberYou/components/data.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
    const { Data } = runInNewContext(code + "\nexports;", {
        exports: {}, require(name: string) {
            return name === "@api/DataStore" ? { set: () => new Promise<void>(resolve => writes.push(resolve)) } : {};
        }
    });
    const data = new Data();
    data.usersCollection = {};
    const user = { id: "1", username: "first", discriminator: "0", getAvatarURL: () => "avatar" };
    data.processUsersToCollection([{ user }]);
    const first = data.updateStorage();
    data.processUsersToCollection([{ user: { ...user, username: "second" } }]);
    writes[0]();
    await first;
    const second = data.updateStorage();
    assert.equal(writes.length, 2);
    writes[1]();
    await second;
});
