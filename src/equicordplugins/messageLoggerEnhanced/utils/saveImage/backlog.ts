/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";

import { Flogger, Native } from "../..";
import { completeAttachmentWork, getAttachmentWorkPage, setAttachmentWorkListener } from "../../db";
import { downloadAttachment } from "./ImageManager";

let ownerId: string | undefined;
let lifetime = new AbortController();
let running: Promise<void> | undefined;
let cancellation: Promise<void> = Promise.resolve();
let nextId: string | undefined;
let dirtyId: string | undefined;
let throughId: string | undefined;
let exhausted = false;
let active: { messageId: string; controller: AbortController; } | undefined;

function cancelActive() {
    active?.controller.abort();
    cancellation = cancellation.then(() => Native.cancelNativeAttachmentDownloads()).catch(error => {
        Flogger.error("Failed to cancel attachment downloads", error);
    });
}

export function stopAttachmentBacklog() {
    ownerId = undefined;
    lifetime.abort();
    setAttachmentWorkListener(undefined);
    cancelActive();
}

export function startAttachmentBacklog(accountId: string) {
    stopAttachmentBacklog();
    ownerId = accountId;
    lifetime = new AbortController();
    nextId = dirtyId = throughId = undefined;
    exhausted = false;
    setAttachmentWorkListener((messageId, hasWork) => {
        if (!messageId || active?.messageId === messageId) cancelActive();
        if (!hasWork) return;
        if (messageId && (!dirtyId || messageId < dirtyId)) dirtyId = messageId;
        if (messageId && throughId && messageId > throughId) throughId = messageId;
        if (messageId && exhausted) {
            nextId = throughId = messageId;
            exhausted = false;
        }
        wake();
    });
    wake();
}

function wake() {
    if (!ownerId || running || exhausted) return;
    const accountId = ownerId;
    const { signal } = lifetime;
    running = (async () => {
        while (!signal.aborted) {
            await cancellation;
            if (signal.aborted) return;
            if (dirtyId) {
                if ((!nextId && throughId) || (nextId && dirtyId < nextId)) nextId = dirtyId;
                dirtyId = undefined;
            }
            const page = await getAttachmentWorkPage(accountId, nextId, throughId);
            if (signal.aborted) return;
            nextId = page.nextId;
            if (page.job) {
                const controller = new AbortController();
                active = { messageId: page.job.messageId, controller };
                const jobSignal = AbortSignal.any([signal, controller.signal]);
                try {
                    const path = await downloadAttachment(page.job.attachment, jobSignal);
                    if (!jobSignal.aborted) await completeAttachmentWork(page.job, path, jobSignal);
                } catch (error) {
                    if (!jobSignal.aborted) {
                        Flogger.error("Failed to cache attachment", error);
                        await completeAttachmentWork(page.job, undefined, jobSignal);
                    }
                } finally {
                    active = undefined;
                }
            } else if (!nextId && !dirtyId) {
                exhausted = true;
                return;
            }
            await sleep(0);
        }
    })().catch(error => {
        if (signal.aborted) return;
        exhausted = true;
        Flogger.error("Failed to process attachment backlog", error);
    }).finally(() => {
        running = undefined;
        wake();
    });
}
