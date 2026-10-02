/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

function compile(source: string): string {
    return transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.React, jsxFactory: "createElement" }
    }).outputText;
}

test("A stalled notification keeps a bounded backlog of the most recent requests", async () => {
    const queueExports: { Queue?: new (limit?: number) => { size: number; }; } = {};
    runInNewContext(compile(readFileSync("src/utils/Queue.ts", "utf8")), {
        exports: queueExports,
        require: () => ({ Logger: class { error(error: unknown) { throw error; } } })
    });
    assert.ok(queueExports.Queue);
    interface Frame { title: string; onClose(): void; }
    const frames: Frame[] = [];
    let persisted = 0;
    const exports: { showNotification?: (data: { title: string; body: string; permanent: boolean; }) => Promise<void>; queue?: { size: number; }; } = {};
    const source = readFileSync("src/api/Notifications/Notifications.tsx", "utf8") + "\nexports.queue = NotificationQueue;";
    runInNewContext(compile(source), {
        exports,
        window: { addEventListener() { } },
        document: { createElement: () => ({}), body: { append() { } }, hasFocus: () => true },
        createElement: (_component: unknown, props: Frame) => props,
        require: (id: string) => {
            if (id === "@api/Settings") return { Settings: { notifications: { useNative: "never" } } };
            if (id === "@utils/Queue") return queueExports;
            if (id === "@webpack/common") return { WindowStore: { isFocused: () => true }, createRoot: () => ({ render: (frame: Frame | null) => { if (frame) frames.push(frame); } }) };
            if (id === "./NotificationComponent") return { default: "NotificationComponent" };
            if (id === "./notificationLog") return { persistNotification: () => persisted++, openNotificationLogModal() { } };
            throw new Error(`Unexpected module ${id}`);
        }
    });
    assert.ok(exports.showNotification);
    assert.ok(exports.queue);
    for (let index = 0; index < 500; index++) {
        await exports.showNotification({ title: `notification-${index}`, body: "A synthetic notification.", permanent: true });
    }
    await setImmediate();
    assert.equal(persisted, 500);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].title, "notification-0");
    assert.ok(exports.queue.size <= 100, `Stalled backlog retained ${exports.queue.size} notification closures`);
    frames[0].onClose();
    await setImmediate();
    assert.equal(frames[1].title, "notification-400");
    for (let index = 1; index <= 100; index++) {
        frames[index].onClose();
        await setImmediate();
    }
    assert.equal(frames.at(-1)?.title, "notification-499");
    assert.equal(exports.queue.size, 0);
});
