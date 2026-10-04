/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

import type { MessageSendListener } from "../src/api/MessageEvents";
import type { CompressionItem } from "../src/equicordplugins/mediaCompressor";
import type { CloudUpload } from "../packages/discord-types/src/modules/CloudUpload";

function fixture() {
    let account = "owner";
    let uploads: CloudUpload[] = [];
    let limits = { file: 100, total: 200 };
    let listener: MessageSendListener | undefined;
    let modalClose: (() => void) | undefined;
    let modals = 0;
    let warnings = 0;
    let starts = 0;
    let removed = 0;
    let priority = 0;
    class Upload {
        item: { file: File; platform: number; origin: string; };
        channelId: string;
        filename: string;
        status = "NOT_STARTED";
        spoiler = false;
        description = "";
        origin = "picker";
        constructor(item: { file: File; platform: number; origin: string; }, channelId: string) { this.item = item; this.channelId = channelId; this.filename = item.file.name; }
        upload() { starts++; return Promise.resolve(); }
        removeFromMsgDraft() { removed++; }
    }
    const modules: Record<string, unknown> = {
        "react/jsx-runtime": { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) },
        "@components/Flex": {}, "@components/Paragraph": {},
        "@components/ErrorBoundary": { __esModule: true, default: { wrap: (value: unknown) => value } },
        "@utils/constants": { EquicordDevs: {} },
        "@utils/types": { __esModule: true, default: (value: unknown) => value },
        "@api/MessageEvents": {
            addMessagePreSendListener(value: MessageSendListener, options: { priority: number; cancelOnError: boolean; }) { listener = value; priority = options.priority; assert.equal(options.cancelOnError, true); },
            removeMessagePreSendListener(value: MessageSendListener) { assert.equal(listener, value); listener = undefined; }
        },
        "@webpack": { filters: { byCode: () => () => true }, mapMangledModuleLazy: () => ({ get: () => ({ getMaxFileSize: () => limits.file, getMaxTotalAttachmentSize: () => limits.total }) }) },
        "@webpack/common": {
            CloudUploader: Upload, DraftType: { ChannelMessage: 0 },
            UploadAttachmentStore: { getUploads: () => uploads },
            UserStore: { getCurrentUser: () => ({ id: account }) },
            FluxDispatcher: { dispatch: (event: { uploads: CloudUpload[]; }) => { uploads = event.uploads; } },
            Alerts: { show: () => { warnings++; } },
            openModal: (_render: unknown, options: { onCloseCallback: () => void; }) => { modals++; modalClose = options.onCloseCallback; return "modal"; },
            closeModal: () => modalClose?.()
        },
        "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: 1 } },
        "@ffmpeg/ffmpeg": {}, "@utils/ffmpeg": {},
        "./modal": { CompressionModal: () => null }
    };
    function load(path: string) {
        const code = transformSync(readFileSync(`src/equicordplugins/mediaCompressor/${path}`, "utf8"), { loader: path.endsWith("tsx") ? "tsx" : "ts", format: "cjs" }).code;
        return runInNewContext(`${code};module.exports`, { module: { exports: {} }, File, AbortController, Map, Number, Error, require: (id: string) => { assert.ok(id in modules, id); return modules[id]; } });
    }
    const compressor = load("compress.ts") as typeof import("../src/equicordplugins/mediaCompressor/compress");
    modules["./compress"] = compressor;
    const index = load("index.tsx") as typeof import("../src/equicordplugins/mediaCompressor");
    modules["./index"] = index;
    const modal = load("modal.tsx") as typeof import("../src/equicordplugins/mediaCompressor/modal");
    function add(size: number, name = "image.png", type = "image/png") {
        const upload = new Upload({ file: new File([new Uint8Array(size)], name, { type }), platform: 1, origin: "picker" }, "channel") as CloudUpload;
        uploads.push(upload);
        return upload;
    }
    return {
        ...index, ...modal, ...compressor, add,
        get uploads() { return uploads; }, get starts() { return starts; }, get removed() { return removed; },
        get modals() { return modals; }, get warnings() { return warnings; }, get priority() { return priority; },
        setLimits: (value: typeof limits) => { limits = value; }, switchAccount: () => { account = "other"; },
        clear: () => { uploads = []; },
        close: () => modalClose?.(),
        send: () => { assert.ok(listener); return listener("channel", {} as Parameters<MessageSendListener>[1], { uploads } as Parameters<MessageSendListener>[2], {} as Parameters<MessageSendListener>[3]); }
    };
}

test("media stays local in message drafts, including shift upload; other contexts keep their behavior", () => {
    const f = fixture();
    const media = f.add(120);
    f.default.startDraftUpload(media, 0);
    assert.equal(f.starts, 0);
    assert.equal(f.default.shouldCheckSize(media.item.file, 0), false);
    assert.equal(f.default.shouldStage([media.item.file], 0), true);
    f.default.startDraftUpload(media, 1);
    assert.equal(f.starts, 1);
    assert.equal(f.default.shouldCheckSize(media.item.file, 1), true);
    const document = f.add(120, "document.pdf", "application/pdf");
    f.default.startDraftUpload(document, 0);
    assert.equal(f.starts, 2);
    assert.equal(f.default.shouldCheckSize(document.item.file, 0), true);
});

test("compression budgets respect both the native per-file and combined limits", () => {
    const f = fixture();
    f.add(160); f.add(80); f.add(50, "notes.txt", "text/plain");
    const plan = f.planCompression(f.uploads, { file: 100, total: 200 });
    assert.deepEqual(Array.from(plan, item => item.limit), [100, 50]);
    for (const file of [20, 50, 100, 250, 500, 1024]) {
        f.setLimits({ file, total: 2000 });
        assert.equal(f.getLimits("channel").file, file);
    }
});

test("send opens one modal and cancels before encryption or upload; closing never sends", async () => {
    const f = fixture();
    f.setLimits({ file: 5000, total: 10000 }); f.add(6000);
    f.default.start();
    assert.ok(f.priority > 1_000_000);
    assert.equal((await f.send())?.cancel, true);
    assert.equal((await f.send())?.cancel, true);
    assert.equal(f.modals, 1);
    assert.equal(f.starts, 0);
    f.close();
    assert.equal(f.starts, 0);
    assert.equal((await f.send())?.cancel, true);
    assert.equal(f.modals, 2);
    f.default.stop();
});

test("in-limit media passes and invalid native limits cancel safely", async () => {
    const f = fixture(); f.add(80); f.default.start();
    assert.equal(await f.send(), undefined);
    f.setLimits({ file: NaN, total: 200 });
    assert.equal((await f.send())?.cancel, true);
    assert.equal(f.warnings, 1);
    f.default.stop();
});

test("replacement preserves order, captions, spoiler and edited name without uploading", () => {
    const f = fixture(); const first = f.add(160); const second = f.add(20);
    first.spoiler = true; first.description = "Alt text"; first.filename = "Renamed.png";
    const items = f.planCompression(f.uploads, { file: 100, total: 200 });
    f.replaceFiles("channel", items, [new File([new Uint8Array(90)], "image.webp", { type: "image/webp" })], "owner", new AbortController().signal);
    assert.equal(f.uploads[0].description, "Alt text");
    assert.equal(f.uploads[0].spoiler, true);
    assert.equal(f.uploads[0].filename, "Renamed.webp");
    assert.equal(f.uploads[1], second);
    assert.equal(f.uploads[0].item.file.size, 90);
    assert.equal(f.starts, 0); assert.equal(f.removed, 1);
});

test("cancellation, changed drafts, account changes and lower limits never replace originals", () => {
    for (const change of ["cancel", "draft", "account", "limit", "started"]) {
        const f = fixture(); const original = f.add(160);
        const items: CompressionItem[] = f.planCompression(f.uploads, { file: 100, total: 200 });
        const controller = new AbortController();
        if (change === "cancel") controller.abort();
        if (change === "draft") f.clear();
        if (change === "account") f.switchAccount();
        if (change === "limit") f.setLimits({ file: 50, total: 200 });
        if (change === "started") original.status = "STARTED";
        assert.throws(() => f.replaceFiles("channel", items, [new File([new Uint8Array(90)], "image.webp")], "owner", controller.signal));
        assert.equal(f.starts, 0); assert.equal(f.removed, 0);
        assert.equal(original.item.file.size, 160);
    }
});

test("video budget reserves audio and container space and rejects unusable targets", () => {
    const f = fixture();
    const budget = f.videoBudget(20 * 1024 * 1024, 120);
    assert.ok((budget.video + budget.audio) * 120 / 8 < 20 * 1024 * 1024);
    assert.throws(() => f.videoBudget(1024, 3600));
});

test("current Discord admission and draft-store patches match each intended site", () => {
    const f = fixture();
    const admission = 'function a(e,t,n){let T=t.getGuildId(),D=Array.from(e);if((0,S.fJ)({files:D,guildId:T}))return void L(t,D);if(t.type!==N.GUILD_VOICE||c.open(t.id),_)a.A.addFiles({files:y,channelId:t.id,draftType:n});}';
    const store = '({UPLOAD_ATTACHMENT_ADD_FILES:function(e){let{draftType:i}=e;let t=new o.bK(e,n,s.length,a);t.upload()},UPLOAD_ATTACHMENT_SET_FILE:function(e){let{draftType:r}=e;let l=new o.bK(i,t,void 0,a);l.upload()}})';
    f.default.patches?.forEach((patch, index) => {
        let code = index ? store : admission;
        const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
        for (const replacement of replacements) {
            assert.equal(typeof replacement.replace, "string");
            const regex = new RegExp(replacement.match.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"), replacement.match.flags);
            const changed = code.replace(regex, String(replacement.replace));
            assert.notEqual(changed, code);
            code = changed;
        }
        assert.doesNotThrow(() => new Function("$self", `return (${code});`));
    });
});
