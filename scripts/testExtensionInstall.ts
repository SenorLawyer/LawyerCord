/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const { outputText } = transpileModule(readFileSync("src/main/utils/extensions.ts", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
});

test("extension extraction confines paths, cleans failures, and awaits extension loading", async () => {
    for (const path of [posix, win32]) {
        const root = path.resolve("extension-fixture");
        const writes: string[] = [];
        let removed = false;
        let files: Record<string, Uint8Array> = {};
        let writeError = false;
        let loads = 0;
        let releaseLoad: (() => void) | undefined;
        const modules: Record<string, unknown> = {
            electron: { session: { defaultSession: { extensions: { loadExtension() {
                loads++;
                return new Promise<void>(resolve => { releaseLoad = resolve; });
            } } } } },
            fflate: { unzip(_data: Buffer, callback: (error: null, files: Record<string, Uint8Array>) => void) { callback(null, files); } },
            fs: { constants: { F_OK: 0 } },
            "fs/promises": {
                access: async () => { throw new Error("not installed"); },
                mkdir: async () => { },
                rm: async () => { removed = true; },
                writeFile: async (file: string) => {
                    writes.push(file);
                    if (writeError) throw new Error("disk full");
                }
            },
            path, util: { promisify },
            "./constants": { DATA_DIR: root },
            "./crxToZip": { crxToZip: (data: Buffer) => data },
            "./http": { fetchBuffer: async () => Buffer.alloc(0) }
        };
        const { extract, installExt } = runInNewContext(`${outputText}\n({ extract, installExt: exports.installExt });`, {
            exports: {}, require: (name: string) => modules[name], process, console
        });
        const target = path.join(root, "extension");
        files = { "nested/file.js": new Uint8Array(), "empty/": new Uint8Array(), "_metadata/signature": new Uint8Array() };
        await extract(Buffer.alloc(0), target);
        assert.deepEqual(writes, [path.join(target, "nested/file.js")]);
        for (const name of ["../escape.js", "../../extension-other/file.js", ...(path === win32 ? ["..\\escape.js", "C:\\escape.js"] : ["/escape.js"])]) {
            files = { [name]: new Uint8Array() };
            writes.length = 0;
            await assert.rejects(extract(Buffer.alloc(0), target));
            assert.deepEqual(writes, [], "unsafe paths must never reach the filesystem");
        }
        files = { "file.js": new Uint8Array() };
        writeError = true;
        removed = false;
        await assert.rejects(installExt("extension"));
        assert.equal(removed, true);
        assert.equal(loads, 0);
        writeError = false;
        let settled = false;
        const pending = installExt("extension").then(() => { settled = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(loads, 1);
        assert.equal(settled, false, "installation must await Electron's result");
        assert.ok(releaseLoad);
        releaseLoad();
        await pending;
    }
});
