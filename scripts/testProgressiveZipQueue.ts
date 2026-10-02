/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function compile(path: string, append = ""): string {
    return transpileModule(readFileSync(path, "utf8") + append, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    }).outputText;
}

test("Cancelled queued ZIP uploads release their work while another compressor is stalled", async () => {
    const queueExports = runInNewContext(compile("src/utils/Queue.ts") + "\nexports;", {
        exports: {}, require: () => ({ Logger: class { error(error: unknown) { throw error; } } })
    });
    const workers: Stream[] = [];
    class Stream {
        ondata(_error: Error | null, _chunk: Uint8Array, _final: boolean) { }
        push() { workers.push(this); }
        terminate() { }
    }
    const api = runInNewContext(compile("src/utils/zip.ts", "\nexport { queue };") + "\nexports;", {
        exports: {}, File, DOMException, performance,
        require: (id: string) => {
            if (id === "@utils/Queue") return queueExports;
            if (id === "@utils/misc") return { sleep: () => Promise.resolve() };
            if (id === "fflate") return {
                AsyncZipDeflate: Stream, ZipDeflate: Stream,
                Zip: class {
                    constructor(private emit: (error: Error | null, chunk: Uint8Array) => void) { }
                    add(stream: Stream) { stream.ondata = this.emit; }
                    end() { }
                    terminate() { }
                }
            };
            throw new Error(`Unexpected module ${id}`);
        }
    }) as { createZipFile(name: string, files: Record<string, Uint8Array>, signal: AbortSignal): Promise<File>; queue: { size: number; }; };
    const active = api.createZipFile("active.zip", { "active.txt": new Uint8Array(65536) }, new AbortController().signal);
    await setImmediate();
    assert.equal(workers.length, 1);
    let settled = 0;
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const pending = controllers.map((controller, index) => api.createZipFile(`${index}.zip`, { "queued.txt": new Uint8Array(65536) }, controller.signal)
        .then(() => settled++, () => settled++));
    assert.ok(api.queue.size <= 4, `Retained ${api.queue.size} queued file payloads`);
    controllers.forEach(controller => controller.abort());
    await setTimeout(30);
    assert.equal(settled, 20, "Cancelled uploads still wait behind the stalled worker");
    assert.equal(api.queue.size, 0);
    assert.equal(workers.length, 1);
    workers[0].ondata(null, new Uint8Array([1]), true);
    await active;
    await Promise.all(pending);
});
