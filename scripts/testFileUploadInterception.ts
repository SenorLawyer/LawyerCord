/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

interface UploadEvent {
    type: string;
    draftType: number;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
}

function fixture() {
    const path = process.env.AUDIT_FILE_INTERCEPTION_SOURCE ?? "src/equicordplugins/fileUpload/index.tsx";
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: path, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX }
    });
    let busy = false;
    let cancellations = 0;
    let account = "account";
    let fail: ((files: File[]) => void) | undefined;
    const restored: UploadEvent[] = [];
    const uploaded: File[][] = [];
    const interceptors: unknown[] = [];
    const listeners = new Map<string, unknown>();
    const modules: Record<string, unknown> = {
        "./styles.css": {}, "@api/ContextMenu": {}, "react/jsx-runtime": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (component: unknown) => component } },
        "@components/Icons": {}, "@utils/constants": { Devs: {}, EquicordDevs: {} },
        "@utils/css": { classNameFactory: () => () => "" },
        "@utils/types": { __esModule: true, default: (plugin: object) => plugin },
        "@webpack": { findByPropsLazy: () => ({ getUserMaxFileSize: () => 100 }) },
        "@webpack/common": {
            DraftType: { ChannelMessage: 0 }, UserStore: { getCurrentUser: () => ({ id: account }) }, SelectedChannelStore: { getChannelId: () => "channel" },
            FluxDispatcher: { dispatch: (event: UploadEvent) => restored.push(event), addInterceptor: (listener: unknown) => interceptors.push(listener), _interceptors: interceptors }
        },
        "./settings": { settings: { store: { bypassDiscordUpload: true, bypassDiscordUploadOnlyOverLimit: false, autoUploadPastedFiles: true } } },
        "./types": {}, "./utils/getMediaUrl": {},
        "./utils/upload": {
            isConfigured: () => true, isUploadInProgress: () => busy,
            isFileTypeAllowed: (file: File) => file.name.endsWith(".png"),
            uploadProvidedFiles: async (files: File[], _force: boolean, onFailure?: (files: File[]) => void) => { fail = onFailure; if (busy) return false; uploaded.push(files); return true; },
            cancelCurrentUpload: () => { cancellations++; }, logger: {}
        }
    };
    const exports = runInNewContext(outputText + "\n({ plugin: exports.default, interceptUploadAddFiles, handlePaste });", {
        exports: {}, File, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
        document: {
            addEventListener: (name: string, listener: unknown) => listeners.set(name, listener),
            removeEventListener: (name: string, listener: unknown) => { assert.equal(listeners.get(name), listener); listeners.delete(name); }
        }
    }) as { plugin: { start(): void; stop(): void; shouldBypassDiscordUploadSizeCheck(): boolean; }; interceptUploadAddFiles(event: UploadEvent): void; handlePaste(event: object): void; };
    return { ...exports, restored, fail: (files: File[]) => fail?.(files), switchAccount: () => account = "other", uploaded, listeners, interceptors, setBusy: () => { busy = true; }, get cancellations() { return cancellations; } };
}

test("FileUpload retains disallowed files and wrapper metadata while intercepting each allowed file once", () => {
    const f = fixture();
    const allowed = new File(["image"], "photo.png"); const denied = new File(["text"], "notes.txt");
    const deniedUpload = { id: "upload", item: { file: denied } }; const opaque = { id: "opaque" };
    const deniedItem = { file: denied, metadata: "keep" };
    const payload = { type: "UPLOAD_ATTACHMENT_ADD_FILES", draftType: 0,
        files: [allowed, denied], uploads: [{ file: allowed }, deniedUpload, opaque], items: [{ item: { file: allowed } }, deniedItem] };
    f.interceptUploadAddFiles(payload);
    assert.equal(f.uploaded.length, 1); assert.deepEqual(Array.from(f.uploaded[0]), [allowed]);
    assert.deepEqual(Array.from(payload.files), [denied]);
    assert.deepEqual(Array.from(payload.uploads), [deniedUpload, opaque]);
    assert.deepEqual(Array.from(payload.items), [deniedItem]);
});

test("busy FileUpload leaves Discord batches intact and does not swallow mixed or busy clipboard files", () => {
    const allowed = new File(["image"], "photo.png"); const denied = new File(["text"], "notes.txt");
    const f = fixture(); assert.equal(f.plugin.shouldBypassDiscordUploadSizeCheck(), true); f.setBusy();
    assert.equal(f.plugin.shouldBypassDiscordUploadSizeCheck(), false);
    const files = [allowed]; const payload = { type: "UPLOAD_ATTACHMENT_ADD_FILES", draftType: 0, files };
    f.interceptUploadAddFiles(payload); assert.equal(payload.files, files); assert.equal(f.uploaded.length, 0);
    let swallowed = 0;
    f.handlePaste({ clipboardData: { files: [allowed] }, preventDefault: () => swallowed++, stopPropagation() {} });
    assert.equal(swallowed, 0);
    const mixed = fixture();
    mixed.handlePaste({ clipboardData: { files: [allowed, denied] }, preventDefault: () => swallowed++, stopPropagation() {} });
    assert.equal(swallowed, 0); assert.equal(mixed.uploaded.length, 0);
    mixed.handlePaste({ clipboardData: { files: [allowed] }, preventDefault: () => swallowed++, stopPropagation() {} });
    assert.equal(swallowed, 1); assert.equal(mixed.uploaded.length, 1);
});

test("FileUpload stop cancels work and releases the exact dispatcher and paste listeners", () => {
    const f = fixture(); f.plugin.start(); assert.equal(f.interceptors.length, 1); assert.equal(f.listeners.size, 1);
    f.plugin.stop(); assert.equal(f.cancellations, 1); assert.equal(f.interceptors.length, 0); assert.equal(f.listeners.size, 0);
    f.plugin.stop(); assert.equal(f.cancellations, 2);
});


test("Failed intercepted files return to the original draft with their metadata", () => {
    const f = fixture();
    const first = new File(["first"], "first.png");
    const failed = new File(["failed"], "failed.png");
    const wrapper = { id: "failed", item: { file: failed }, description: "Keep this" };
    f.interceptUploadAddFiles({ type: "UPLOAD_ATTACHMENT_ADD_FILES", draftType: 0, files: [first], uploads: [wrapper] });
    f.fail([failed]);
    assert.equal(f.restored.length, 1);
    assert.deepEqual(Array.from(f.restored[0].uploads as unknown[]), [wrapper]);
    assert.deepEqual(Array.from(f.restored[0].files as unknown[]), []);
    f.switchAccount();
    f.fail([failed]);
    assert.equal(f.restored.length, 1);
});
