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

function fixture() {
    const saved = new Map<string, { id: string; }>();
    let counts = 0;
    const mocks: Record<string, unknown> = {
        "@webpack/common": { UserStore: { getCurrentUser: () => ({ id: "account" }) } },
        ".": { settings: { store: { saveImages: false, timeBasedCleanupMinutes: 0, messageLimit: 5 } } },
        "./db": {
            DBMessageStatus: { DELETED: "DELETED" },
            addMessageIDB: async (message: { id: string; }) => { saved.set(message.id, message); },
            db: { count: async () => { counts++; return saved.size; } },
            getOldestMessagesIDB: async (limit: number) => Array.from(saved.keys()).slice(0, limit).map(message_id => ({ message_id })),
            deleteMessagesBulkIDB: async (ids: string[]) => { for (const id of ids) saved.delete(id); }
        }, "./utils": { cleanupMessage: (message: object) => message }, "./utils/saveImage": {}
    };
    const source = process.env.AUDIT_LOG_CLEANUP_SOURCE ?? "src/equicordplugins/messageLoggerEnhanced/LoggedMessageManager.ts";
    const { outputText } = transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } });
    const api = runInNewContext(`${outputText}\nexports;`, { exports: {},
        require: (name: string) => { assert.ok(name in mocks, name); return mocks[name]; } }) as { addMessage(message: { id: string; }, status: string): Promise<void>; };
    return { saved, api, get counts() { return counts; } };
}

test("A burst of logged edits performs shared cleanup and enforces the limit even after a large overflow", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 100 }, (_, i) => f.api.addMessage({ id: String(i) }, "EDITED")));
    assert.equal(f.saved.size, 5);
    assert.deepEqual(Array.from(f.saved.keys()), ["95", "96", "97", "98", "99"]);
    assert.ok(f.counts <= 2, `Performed ${f.counts} counts for one burst`);
});
