/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";

interface Author { id?: string; name: string; }
interface User { username: string; }

function fixture() {
    const source = readFileSync(process.env.AUDIT_AUTHORS_SOURCE ?? "src/components/settings/tabs/plugins/PluginModal.tsx", "utf8");
    const start = source.indexOf("    useEffect(() => {", source.indexOf("const [authors, setAuthors]"));
    const end = source.indexOf("    function handleResetClick()", start);
    assert.ok(start >= 0 && end > start);
    const { outputText } = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } });
    const requests: { id: string; resolve: (user: User) => void; reject: () => void; }[] = [];
    const dummies: string[] = [];
    let authors: User[] = [];
    let cleanup: (() => void) | undefined;
    return { requests, dummies, authors: () => authors,
        mount(list: Author[]) {
            cleanup?.();
            runInNewContext(outputText, {
                plugin: { authors: list },
                UserUtils: { getUser: (id: string) => new Promise<User>((resolve, reject) => requests.push({ id, resolve, reject: () => reject(new Error("Request failed")) })) },
                makeDummyUser: ({ username }: User) => { dummies.push(username); return { username }; },
                setAuthors: (value: User[] | ((current: User[]) => User[])) => { authors = typeof value === "function" ? value(authors) : value; },
                useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); },
                logger: { warn() {} }
            });
        },
        unmount() { cleanup?.(); }
    };
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("closed plugin modals cannot append late authors or continue loading", async () => {
    const f = fixture(); f.mount([{ id: "1", name: "First" }, { id: "2", name: "Second" }]);
    f.unmount(); f.requests[0].resolve({ username: "First" }); await settle();
    assert.equal(f.authors().length, 0);
    assert.equal(f.requests.length, 1);
});

test("closed plugin modals cannot create dummy users from failed lookups", async () => {
    const f = fixture(); f.mount([{ id: "1", name: "First" }]);
    f.unmount(); f.requests[0].reject(); await settle();
    assert.equal(f.dummies.length, 0);
    assert.equal(f.authors().length, 0);
});

test("changing plugin authors replaces the list and discards prior lookups", async () => {
    const f = fixture(); f.mount([{ id: "1", name: "First" }, { id: "2", name: "Old" }]);
    f.requests[0].resolve({ username: "First" }); await settle();
    assert.equal(f.authors()[0].username, "First");
    f.mount([{ id: "3", name: "New" }]);
    assert.equal(f.authors().length, 0);
    f.requests[1].resolve({ username: "Old" });
    f.requests[2].resolve({ username: "New" }); await settle();
    assert.equal(f.authors().length, 1);
    assert.equal(f.authors()[0].username, "New");
    f.unmount();
});

test("plugin author order and six-avatar bound survive failures and missing IDs", async () => {
    const f = fixture();
    f.mount([{ name: "No ID" }, ...Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Author ${i + 1}` }))]);
    for (let i = 0; i < 5; i++) {
        assert.equal(f.requests[i].id, String(i + 1));
        if (i === 1) f.requests[i].reject(); else f.requests[i].resolve({ username: `Author ${i + 1}` });
        await settle();
    }
    assert.equal(f.requests.length, 5);
    assert.deepEqual(Array.from(f.authors(), user => user.username), ["No ID", "Author 1", "Author 2", "Author 3", "Author 4", "Author 5"]);
    assert.deepEqual(f.dummies, ["No ID", "Author 2"]);
    f.unmount();
});
