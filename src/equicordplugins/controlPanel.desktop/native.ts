/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { createHash, randomBytes, randomUUID } from "crypto";
import { app, type IpcMainInvokeEvent, safeStorage, session, shell } from "electron";
import dashboardHtml from "file://dashboard.html?minify";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { join } from "path";

import { createChainedEvidence, searchIndexedMessages } from "./core";
import type {
    ControlPanelSnapshot,
    IndexedDiscordMessage,
    PrivacyInventoryEntry,
} from "./types";

interface ControlConfig {
    schemaVersion: 1;
    secret: string;
    preferredPort: number;
    approvedChannelIds: string[];
}

interface PersistedIndex {
    schemaVersion: 1;
    messages: IndexedDiscordMessage[];
}

interface NetworkObservation {
    domain: string;
    method: string;
    resourceType: string;
    statusCode: number;
    timestamp: string;
    url: string;
}

const CONTROL_DIR = join(DATA_DIR, "control-panel");
const CONFIG_PATH = join(CONTROL_DIR, "config.json");
const INDEX_PATH = join(CONTROL_DIR, "semantic-index.bin");
const EXPORTS_DIR = join(CONTROL_DIR, "evidence");
const DEFAULT_PORT = 47_831;
const MAX_MESSAGES = 20_000;
const MAX_NETWORK_EVENTS = 2_000;
const SNOWFLAKE = /^\d{17,20}$/;

let config: ControlConfig | null = null;
let snapshot: ControlPanelSnapshot | null = null;
let privacyInventory: PrivacyInventoryEntry[] = [];
let messages = new Map<string, IndexedDiscordMessage>();
const networkEvents: NetworkObservation[] = [];
let server: Server | null = null;
let serverUrl = "";
let initialization: Promise<void> | null = null;
let serverInitialization: Promise<void> | null = null;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
let networkObserverInstalled = false;
let storageStatus: "encrypted" | "memory-only" | "loading" = "loading";

function json(value: unknown): string {
    return JSON.stringify(value);
}

async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, value, { mode: 0o600 });
    await rename(temporaryPath, path);
}

function secureStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() &&
        !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
}

async function loadConfig(): Promise<ControlConfig> {
    try {
        const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<ControlConfig>;
        if (
            parsed.schemaVersion === 1 &&
            typeof parsed.secret === "string" &&
            parsed.secret.length >= 32 &&
            Number.isInteger(parsed.preferredPort) &&
            Array.isArray(parsed.approvedChannelIds)
        ) {
            return {
                schemaVersion: 1,
                secret: parsed.secret,
                preferredPort: parsed.preferredPort!,
                approvedChannelIds: parsed.approvedChannelIds.filter((id): id is string => SNOWFLAKE.test(String(id))),
            };
        }
    } catch { }

    const created: ControlConfig = {
        schemaVersion: 1,
        secret: randomBytes(32).toString("base64url"),
        preferredPort: DEFAULT_PORT,
        approvedChannelIds: [],
    };
    await atomicWrite(CONFIG_PATH, `${JSON.stringify(created, null, 2)}\n`);
    return created;
}

async function loadIndex(): Promise<void> {
    if (!secureStorageAvailable()) {
        storageStatus = "memory-only";
        return;
    }

    try {
        const encrypted = await readFile(INDEX_PATH);
        const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as PersistedIndex;
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages)) throw new Error("unsupported index");
        messages = new Map(parsed.messages.slice(-MAX_MESSAGES).map(message => [message.id, message]));
    } catch { }
    storageStatus = "encrypted";
}

function persistIndexSoon(): void {
    if (storageStatus !== "encrypted") return;
    if (persistenceTimer) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => {
        persistenceTimer = null;
        const value: PersistedIndex = {
            schemaVersion: 1,
            messages: [...messages.values()].slice(-MAX_MESSAGES),
        };
        void atomicWrite(INDEX_PATH, safeStorage.encryptString(JSON.stringify(value)));
    }, 500);
}

function installNetworkObserver(): void {
    if (networkObserverInstalled || !app.isReady()) return;
    networkObserverInstalled = true;
    session.defaultSession.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, details => {
        let parsed: URL;
        try { parsed = new URL(details.url); }
        catch { return; }
        if (parsed.hostname === "127.0.0.1" && parsed.port === String(new URL(serverUrl).port)) return;
        networkEvents.push({
            domain: parsed.hostname,
            method: details.method,
            resourceType: details.resourceType,
            statusCode: details.statusCode,
            timestamp: new Date(details.timestamp).toISOString(),
            url: `${parsed.origin}${parsed.pathname}`,
        });
        if (networkEvents.length > MAX_NETWORK_EVENTS)
            networkEvents.splice(0, networkEvents.length - MAX_NETWORK_EVENTS);
    });
}

async function ensureInitialized(): Promise<void> {
    initialization ??= (async () => {
        await Promise.all([
            mkdir(CONTROL_DIR, { recursive: true }),
            mkdir(EXPORTS_DIR, { recursive: true }),
        ]);
        config = await loadConfig();
        await loadIndex();
    })();
    return initialization;
}

function send(response: ServerResponse, status: number, body: string, contentType = "application/json; charset=utf-8"): void {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        "Content-Type": contentType,
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
    });
    response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > 64 * 1024) throw new Error("Request body is too large");
        chunks.push(buffer);
    }
    if (!total) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object expected");
    return parsed as Record<string, unknown>;
}

async function createEvidenceExport(body: Record<string, unknown>) {
    const requestedChannels = Array.isArray(body.channelIds)
        ? body.channelIds.map(String).filter(id => SNOWFLAKE.test(id))
        : [];
    if (!requestedChannels.length) throw new Error("Choose at least one indexed channel");
    const approved = new Set(config!.approvedChannelIds);
    if (requestedChannels.some(channelId => !approved.has(channelId)))
        throw new Error("Evidence export is limited to explicitly approved semantic-index channels");

    const from = typeof body.from === "string" && body.from ? Date.parse(body.from) : Number.NEGATIVE_INFINITY;
    const to = typeof body.to === "string" && body.to ? Date.parse(body.to) : Number.POSITIVE_INFINITY;
    const redact = body.redact !== false;
    const anonymize = body.anonymize === true;
    const selected = [...messages.values()]
        .filter(message => requestedChannels.includes(message.channelId))
        .filter(message => {
            const timestamp = Date.parse(message.timestamp);
            return timestamp >= from && timestamp <= to;
        })
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));

    const exportId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const directory = join(EXPORTS_DIR, exportId);
    await mkdir(directory, { recursive: true });

    const evidence = createChainedEvidence(selected, redact, anonymize);
    const evidenceBody = evidence.body;
    const evidenceHash = createHash("sha256").update(evidenceBody).digest("hex");
    await atomicWrite(join(directory, "messages.jsonl"), evidenceBody);

    const manifest = {
        schemaVersion: 1,
        exportId,
        createdAt: new Date().toISOString(),
        generatedBy: `LawyerCord ${app.getVersion()}`,
        source: "encrypted local semantic index",
        filters: { channelIds: requestedChannels, from: Number.isFinite(from) ? new Date(from).toISOString() : null, to: Number.isFinite(to) ? new Date(to).toISOString() : null },
        privacy: { automaticRedaction: redact, anonymizedAuthors: anonymize },
        recordCount: selected.length,
        chain: { algorithm: "SHA-256", genesis: "0".repeat(64), finalHash: evidence.finalHash },
        files: [{ name: "messages.jsonl", bytes: Buffer.byteLength(evidenceBody), sha256: evidenceHash }],
    };
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    await atomicWrite(join(directory, "manifest.json"), manifestBody);
    return {
        ...manifest,
        path: directory,
        manifestSha256: createHash("sha256").update(manifestBody).digest("hex"),
    };
}

function overview() {
    const domainCounts = new Map<string, number>();
    for (const event of networkEvents) domainCounts.set(event.domain, (domainCounts.get(event.domain) ?? 0) + 1);
    return {
        app: {
            name: "LawyerCord",
            version: app.getVersion(),
            uptimeSeconds: Math.round(process.uptime()),
            controlPanelUrl: serverUrl,
        },
        storage: {
            status: storageStatus,
            indexedMessages: messages.size,
            approvedChannels: config!.approvedChannelIds.length,
            path: CONTROL_DIR,
        },
        snapshot,
        network: {
            requestCount: networkEvents.length,
            domainCount: domainCounts.size,
            topDomains: [...domainCounts].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([domain, count]) => ({ domain, count })),
            recent: networkEvents.slice(-100).reverse(),
        },
    };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string, url: URL): Promise<void> {
    if (request.method === "GET" && pathname === "/api/overview") return send(response, 200, json(overview()));
    if (request.method === "GET" && pathname === "/api/privacy") {
        const byDomain = new Map<string, number>();
        for (const event of networkEvents) byDomain.set(event.domain, (byDomain.get(event.domain) ?? 0) + 1);
        return send(response, 200, json({ inventory: privacyInventory, observedDomains: [...byDomain].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count) }));
    }
    if (request.method === "GET" && pathname === "/api/channels") {
        return send(response, 200, json({ approvedChannelIds: config!.approvedChannelIds, channels: snapshot?.channels ?? [] }));
    }
    if (request.method === "GET" && pathname === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
        const channelIds = url.searchParams.getAll("channel").filter(id => SNOWFLAKE.test(id));
        if (!query) return send(response, 200, json({ query, results: [] }));
        return send(response, 200, json({
            query,
            model: "LawyerCord local subword-vector v1",
            results: searchIndexedMessages(messages.values(), query, channelIds, config!.approvedChannelIds, 50),
        }));
    }
    if (request.method === "POST" && pathname === "/api/channels") {
        const body = await readBody(request);
        const channelId = String(body.channelId ?? "");
        if (!SNOWFLAKE.test(channelId) || !snapshot?.channels.some(channel => channel.id === channelId))
            throw new Error("Channel is not visible to the authenticated Discord account");
        const approved = body.approved === true;
        const values = new Set(config!.approvedChannelIds);
        approved ? values.add(channelId) : values.delete(channelId);
        config!.approvedChannelIds = [...values];
        if (!approved) {
            for (const [messageId, message] of messages) {
                if (message.channelId === channelId) messages.delete(messageId);
            }
            persistIndexSoon();
        }
        await atomicWrite(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
        return send(response, 200, json({ approvedChannelIds: config!.approvedChannelIds }));
    }
    if (request.method === "POST" && pathname === "/api/evidence") {
        return send(response, 200, json(await createEvidenceExport(await readBody(request))));
    }
    if (request.method === "POST" && pathname === "/api/open-exports") {
        await shell.openPath(EXPORTS_DIR);
        return send(response, 200, json({ opened: true }));
    }
    send(response, 404, json({ error: "Not found" }));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
        const requestUrl = new URL(request.url ?? "/", serverUrl);
        const prefix = `/${config!.secret}`;
        if (requestUrl.pathname === "/") {
            response.writeHead(302, { Location: `${prefix}/` });
            response.end();
            return;
        }
        if (!requestUrl.pathname.startsWith(prefix)) return send(response, 404, "Not found", "text/plain; charset=utf-8");
        const { origin } = request.headers;
        if (origin && origin !== new URL(serverUrl).origin) return send(response, 403, json({ error: "Cross-origin request rejected" }));
        const pathname = requestUrl.pathname.slice(prefix.length) || "/";
        if (request.method === "GET" && pathname === "/")
            return send(response, 200, dashboardHtml, "text/html; charset=utf-8");
        await handleApi(request, response, pathname, requestUrl);
    } catch (error) {
        send(response, 400, json({ error: error instanceof Error ? error.message : "Request failed" }));
    }
}

async function startHttpServer(): Promise<void> {
    serverInitialization ??= (async () => {
        await ensureInitialized();
        server = createServer((request, response) => void handleRequest(request, response));
        serverUrl = await new Promise<string>((resolve, reject) => {
            const listen = (port: number) => {
                server!.once("error", error => {
                    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && port === config!.preferredPort) {
                        server!.removeAllListeners("error");
                        listen(0);
                    } else reject(error);
                });
                server!.listen(port, "127.0.0.1", () => {
                    const address = server!.address();
                    if (!address || typeof address === "string") return reject(new Error("Control panel failed to bind"));
                    resolve(`http://127.0.0.1:${address.port}/${config!.secret}/`);
                });
            };
            listen(config!.preferredPort);
        });
        installNetworkObserver();
    })();
    try {
        await serverInitialization;
    } catch (error) {
        serverInitialization = null;
        if (server) {
            server.close();
            server = null;
        }
        throw error;
    }
}

export async function initializeControlPanel(_: IpcMainInvokeEvent): Promise<{ url: string; storageStatus: string; }> {
    await startHttpServer();
    return { url: serverUrl, storageStatus };
}

export async function getControlState(_: IpcMainInvokeEvent): Promise<{ url: string; approvedChannelIds: string[]; }> {
    await startHttpServer();
    return { url: serverUrl, approvedChannelIds: [...config!.approvedChannelIds] };
}

export async function updateSnapshot(_: IpcMainInvokeEvent, value: ControlPanelSnapshot): Promise<void> {
    await startHttpServer();
    snapshot = value;
}

export async function updatePrivacyInventory(_: IpcMainInvokeEvent, value: PrivacyInventoryEntry[]): Promise<void> {
    await startHttpServer();
    privacyInventory = Array.isArray(value) ? value.slice(0, 1_000) : [];
}

export async function indexDiscordMessages(_: IpcMainInvokeEvent, values: IndexedDiscordMessage[]): Promise<{ indexed: number; }> {
    await startHttpServer();
    const approved = new Set(config!.approvedChannelIds);
    let indexed = 0;
    for (const value of values) {
        if (!value || !SNOWFLAKE.test(value.id) || !approved.has(value.channelId) || typeof value.content !== "string") continue;
        messages.delete(value.id);
        messages.set(value.id, value);
        indexed++;
    }
    while (messages.size > MAX_MESSAGES) messages.delete(messages.keys().next().value!);
    if (indexed) persistIndexSoon();
    return { indexed };
}

export async function openControlPanel(_: IpcMainInvokeEvent): Promise<string> {
    await startHttpServer();
    await shell.openExternal(serverUrl);
    return serverUrl;
}

export async function getControlPanelDiagnostics(_: IpcMainInvokeEvent) {
    await startHttpServer();
    return overview();
}

void app.whenReady().then(startHttpServer).catch(error => {
    console.error("[LawyerCord] Failed to start the local control panel", error);
});
