/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

import { isUploadUrl, MAX_FILE_BYTES, MAX_RESPONSE_BYTES, readResponseBody } from "./request";
import { NativeUploadResult, NestUploadResponse } from "./types";

const requests = new Map<number, Set<AbortController>>();

export function cancelUploads(event: IpcMainInvokeEvent) {
    for (const controller of requests.get(event.sender.id) ?? []) controller.abort();
}

function validateText(value: unknown, maximum = 8192) {
    if (typeof value !== "string" || value.length > maximum || /[\r\n\0]/.test(value)) throw new Error("Invalid upload argument.");
}

function validateFile(buffer: unknown, filename?: unknown) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_FILE_BYTES) throw new Error("Invalid upload file.");
    if (filename !== undefined) validateText(filename, 255);
}

async function request(event: IpcMainInvokeEvent, url: string, options: RequestInit = {}, maximum = MAX_RESPONSE_BYTES): Promise<Response> {
    if (!isUploadUrl(url)) throw new Error("A valid HTTPS URL is required.");
    if (options.headers) {
        const entries = Object.entries(options.headers);
        if (entries.length > 64) throw new Error("Too many upload headers.");
        for (const [key, value] of entries) {
            validateText(key, 256);
            validateText(value);
        }
    }
    const controller = new AbortController();
    const active = requests.get(event.sender.id) ?? new Set<AbortController>();
    if (active.size >= 4) throw new Error("Too many active uploads.");
    requests.set(event.sender.id, active);
    active.add(controller);
    const abort = () => controller.abort();
    event.sender.once("destroyed", abort);
    event.sender.once("render-process-gone", abort);
    const timeout = setTimeout(() => controller.abort(), 300_000);
    try {
        for (let redirects = 0; ; redirects++) {
            const response = await fetch(url, { ...options, redirect: "manual", signal: controller.signal });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                const location = response.headers.get("location");
                const next = location && new URL(location, url).href;
                if (redirects >= 5 || !isUploadUrl(next) || ((options.headers || options.method && options.method !== "GET") && new URL(next).origin !== new URL(url).origin)) throw new Error("Invalid upload redirect.");
                if (response.status === 303 || ([301, 302].includes(response.status) && options.method === "POST")) options = { ...options, method: "GET", body: undefined };
                url = next;
                continue;
            }
            const body = await readResponseBody(response, maximum, controller.signal);
            return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
    } finally {
        clearTimeout(timeout);
        event.sender.removeListener("destroyed", abort);
        event.sender.removeListener("render-process-gone", abort);
        active.delete(controller);
        if (!active.size) requests.delete(event.sender.id);
    }
}

export async function uploadToNest(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    authToken: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        validateText(authToken);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://nest.rip/api/files/upload", {
            method: "POST",
            headers: {
                "Authorization": authToken
            },
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const data = await response.json() as NestUploadResponse;
        if (data.fileURL) {
            return { success: true, url: data.fileURL };
        }
        return { success: false, error: "No URL returned from upload" };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToEzHost(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    key: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        validateText(key);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://api.e-z.host/files", {
            method: "POST",
            headers: {
                key
            },
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const data = await response.json() as { success: boolean; error?: string; imageUrl?: string; rawUrl?: string; };
        if (!data || !data.success) {
            return { success: false, error: data?.error || "Upload failed" };
        }
        if (data.imageUrl || data.rawUrl) {
            return { success: true, url: data.imageUrl || data.rawUrl };
        }
        return { success: false, error: "No URL returned from upload" };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadTo0x0(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://0x0.st", {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url: text };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToS3(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    uploadUrl: string,
    headers: Record<string, string>
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer);
        const response = await request(_, uploadUrl, {
            method: "PUT",
            headers,
            body: new Blob([fileBuffer])
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        return { success: true, url: uploadUrl };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToCatbox(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    userhash?: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        if (userhash !== undefined) validateText(userhash);
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        if (userhash) {
            formData.append("userhash", userhash);
        }
        formData.append("fileToUpload", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://catbox.moe/user/api.php", {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url: text };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToLitterbox(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    expiry: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        validateText(expiry);
        const formData = new FormData();
        formData.append("reqtype", "fileupload");
        formData.append("time", expiry);
        formData.append("fileToUpload", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://litterbox.catbox.moe/resources/internals/api.php", {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const text = (await response.text()).trim();
        if (!text) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url: text };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToGofile(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    token?: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        if (token !== undefined) validateText(token);
        const formData = new FormData();
        if (token?.trim()) {
            formData.append("token", token.trim());
        }
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://upload.gofile.io/uploadfile", {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const data = await response.json() as {
            status?: string;
            error?: string;
            data?: { downloadPage?: string; code?: string; };
        };
        if (data.status !== "ok") {
            return { success: false, error: data.error || "Upload failed" };
        }
        const url = data.data?.downloadPage || (data.data?.code ? `https://gofile.io/d/${data.data.code}` : "");
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToTmpfiles(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://tmpfiles.org/api/v1/upload", {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const data = await response.json() as { status?: string; data?: { url?: string; }; };
        const rawUrl = data.data?.url || "";
        if (!rawUrl || data.status !== "success") {
            return { success: false, error: "No URL returned from upload" };
        }
        const url = rawUrl.includes("tmpfiles.org/") && !rawUrl.includes("/dl/")
            ? rawUrl.replace(/tmpfiles\.org\/(\d+)/, "tmpfiles.org/dl/$1")
            : rawUrl;
        return { success: true, url };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToBuzzheavier(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        const response = await request(_, `https://w.buzzheavier.com/${encodeURIComponent(filename)}`, {
            method: "PUT",
            body: new Blob([fileBuffer])
        });
        const text = await response.text();
        if (!response.ok) {
            return { success: false, error: `Upload failed: ${response.status} ${text}` };
        }
        try {
            const data = JSON.parse(text) as { code?: number; data?: { id?: string; }; };
            if (data.code === 201 && data.data?.id) {
                return { success: true, url: `https://buzzheavier.com/${data.data.id}` };
            }
        } catch {
            if (!isUploadUrl(text.trim())) return { success: false, error: "Invalid upload response." };
        }
        const url = text.trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToTempSh(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://temp.sh/upload", {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        const url = (await response.text()).trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToFilebin(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        const binId = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
        const uploadUrl = `https://filebin.net/${binId}/${encodeURIComponent(filename)}`;
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, uploadUrl, {
            method: "POST",
            body: formData
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        return { success: true, url: `https://filebin.net/${binId}/${encodeURIComponent(filename)}` };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToPixelVault(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    uploadKey: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        validateText(uploadKey);
        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer]), filename);
        const response = await request(_, "https://pixelvault.co/", {
            method: "POST",
            headers: {
                Authorization: uploadKey
            },
            body: formData
        });
        const text = await response.text();
        let data: { resource?: string; url?: string; } | null = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!response.ok) {
            return { success: false, error: `Upload failed: ${response.status} ${text}` };
        }
        const url = data?.resource || data?.url || text.trim();
        if (!url) {
            return { success: false, error: "No URL returned from upload" };
        }
        return { success: true, url };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function uploadToPixelDrain(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    filename: string,
    apiKey?: string
): Promise<NativeUploadResult> {
    try {
        validateFile(fileBuffer, filename);
        if (apiKey !== undefined) validateText(apiKey);
        const headers: Record<string, string> = {};
        if (apiKey?.trim()) {
            headers.Authorization = `Basic ${Buffer.from(`:${apiKey.trim()}`).toString("base64")}`;
        }
        const response = await request(_, `https://pixeldrain.com/api/file/${encodeURIComponent(filename)}`, {
            method: "PUT",
            headers,
            body: new Blob([fileBuffer])
        });
        const text = await response.text();
        let data: { id?: string; message?: string; } | null = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!response.ok) {
            return { success: false, error: data?.message || `Upload failed: ${response.status} ${text}` };
        }
        if (!data?.id) {
            return { success: false, error: data?.message || "No URL returned from upload" };
        }
        return { success: true, url: `https://pixeldrain.com/u/${data.id}` };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

function isValidHttpsUrl(url: string): boolean {
    return isUploadUrl(url);
}

export async function uploadToWebdav(
    _: IpcMainInvokeEvent,
    fileBuffer: ArrayBuffer,
    uploadUrl: string,
    headers: Record<string, string>
): Promise<NativeUploadResult> {
    if (!isValidHttpsUrl(uploadUrl)) {
        return { success: false, error: "Invalid or non-HTTPS upload URL" };
    }

    try {
        validateFile(fileBuffer);
        const response = await request(_, uploadUrl, {
            method: "PUT",
            headers,
            body: new Blob([fileBuffer])
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} ${errorText}` };
        }
        return { success: true, url: uploadUrl };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function createWebdavShare(
    _: IpcMainInvokeEvent,
    ocsUrl: string,
    headers: Record<string, string>,
    body: string
): Promise<NativeUploadResult> {
    if (!isValidHttpsUrl(ocsUrl)) {
        return { success: false, error: "Invalid or non-HTTPS share endpoint URL" };
    }

    try {
        validateText(body, 65536);
        const response = await request(_, ocsUrl, {
            method: "POST",
            headers,
            body
        });
        const text = await response.text();
        if (!response.ok) {
            return { success: false, error: `Share creation failed: ${response.status} ${text.slice(0, 200)}` };
        }
        let data: { ocs?: { data?: { token?: string; }; }; };
        try {
            data = JSON.parse(text);
        } catch {
            return { success: false, error: `Invalid share response: ${text.slice(0, 200)}` };
        }
        const token = data?.ocs?.data?.token;
        if (!token) {
            return { success: false, error: "No share token in server response" };
        }
        return { success: true, url: token };
    } catch {
        return { success: false, error: "The request failed." };
    }
}

export async function fetchFile(
    _: IpcMainInvokeEvent,
    url: string
): Promise<{ success: boolean; data?: ArrayBuffer; contentType?: string; error?: string; }> {

    try {
        const response = await request(_, url, {}, MAX_FILE_BYTES);
        if (!response.ok) {
            return { success: false, error: `Fetch failed: ${response.status} ${response.statusText}` };
        }
        const data = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") || "";
        return { success: true, data, contentType };
    } catch {
        return { success: false, error: "The request failed." };
    }

}
