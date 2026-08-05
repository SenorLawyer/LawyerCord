/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { IpcMainInvokeEvent } from "electron";
import { watch } from "fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { homedir, platform } from "os";
import { basename, dirname, extname, join } from "path";

import { DISCORD_MCP_TOOL_NAMES, isDiscordSnowflake, sentMessageKey } from "./policy";

interface BridgeRequest {
    id: string;
    secret: string;
    tool: string;
    arguments?: unknown;
    createdAt: number;
}

interface BridgeResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

interface BridgeConfig {
    schemaVersion: 1;
    secret: string;
    queueDirectory: string;
    createdAt: string;
}

interface DownloadResult {
    path: string;
    filename: string;
    contentType: string;
    size: number;
    sha256: string;
    data: Uint8Array;
}

interface AttachmentData {
    contentType: string;
    data: Buffer;
}

const MCP_CLIENTS = ["codex", "claudeDesktop", "claudeCode", "gemini", "cursor"] as const;

type McpClient = typeof MCP_CLIENTS[number];

interface McpSetupResult {
    client: McpClient;
    path: string;
}

const BRIDGE_DIR = join(DATA_DIR, "discord-mcp");
const REQUESTS_DIR = join(BRIDGE_DIR, "requests");
const RESPONSES_DIR = join(BRIDGE_DIR, "responses");
const DOWNLOADS_DIR = join(BRIDGE_DIR, "downloads");
const CONFIG_PATH = join(BRIDGE_DIR, "config.json");
const SENT_LEDGER_PATH = join(BRIDGE_DIR, "sent-messages.json");
const SERVER_PATH = join(BRIDGE_DIR, "server.mjs");
const SERVER_SOURCE_PATH = join(__dirname, "discord-mcp-server.mjs");
const MAX_REQUEST_SIZE = 64 * 1024;
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const MAX_REQUEST_AGE_MS = 5 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const allowedTools = new Set<string>(DISCORD_MCP_TOOL_NAMES);

let initialization: Promise<void> | null = null;
let bridgeSecret = "";
let sentMessages = new Set<string>();
let ledgerWrite = Promise.resolve();

function equalSecret(candidate: unknown): boolean {
    if (typeof candidate !== "string") return false;
    const expected = Buffer.from(bridgeSecret);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function atomicWrite(path: string, value: string): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    try { await chmod(path, 0o600); } catch { }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverConfig(): Record<string, unknown> {
    return {
        command: process.execPath,
        args: [SERVER_PATH],
        env: { ELECTRON_RUN_AS_NODE: "1" },
    };
}

async function writeJsonConfig(path: string): Promise<void> {
    let config: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(parsed)) throw new Error("Configuration root must be an object.");
        config = parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const existingServers = config.mcpServers;
    if (existingServers !== undefined && !isRecord(existingServers))
        throw new Error("mcpServers must be an object.");

    const servers = existingServers ?? {};
    servers["lawyercord-discord"] = serverConfig();
    config.mcpServers = servers;
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
}

function tomlString(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

async function writeCodexConfig(): Promise<string> {
    const path = join(homedir(), ".codex", "config.toml");
    let config = "";
    try {
        config = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const section = [
        "[mcp_servers.lawyercord-discord]",
        `command = ${tomlString(process.execPath)}`,
        `args = [${tomlString(SERVER_PATH)}]`,
        "",
        "[mcp_servers.lawyercord-discord.env]",
        "ELECTRON_RUN_AS_NODE = \"1\"",
        "",
    ].join("\n");
    const withoutExisting = config.replace(/^\[mcp_servers\.lawyercord-discord(?:\.env)?\][\s\S]*?(?=^\[[^\]]+\]|(?![\s\S]))/gim, "").trimEnd();
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, `${withoutExisting}${withoutExisting ? "\n\n" : ""}${section}`);
    return path;
}

async function ensureBridgeServer(): Promise<void> {
    const source = await readFile(SERVER_SOURCE_PATH, "utf8");
    await atomicWrite(SERVER_PATH, source);
}

function claudeDesktopConfigPath(): string {
    switch (platform()) {
        case "darwin": return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
        case "win32": return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
        default: return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
    }
}

async function readOrCreateConfig(): Promise<BridgeConfig> {
    try {
        const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<BridgeConfig>;
        if (parsed.schemaVersion === 1 && typeof parsed.secret === "string" && parsed.secret.length >= 32)
            return parsed as BridgeConfig;
    } catch { }

    const config: BridgeConfig = {
        schemaVersion: 1,
        secret: randomBytes(32).toString("base64url"),
        queueDirectory: BRIDGE_DIR,
        createdAt: new Date().toISOString(),
    };
    await atomicWrite(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    return config;
}

async function loadSentLedger(): Promise<void> {
    try {
        const parsed = JSON.parse(await readFile(SENT_LEDGER_PATH, "utf8"));
        if (!Array.isArray(parsed)) return;
        sentMessages = new Set(parsed.filter((entry): entry is string =>
            typeof entry === "string" && /^\d{17,20}:\d{17,20}$/.test(entry)
        ).slice(-10_000));
    } catch { }
}

function persistSentLedger(): Promise<void> {
    ledgerWrite = ledgerWrite.then(() =>
        atomicWrite(SENT_LEDGER_PATH, `${JSON.stringify([...sentMessages], null, 2)}\n`)
    );
    return ledgerWrite;
}

async function cleanupStaleQueueFiles(): Promise<void> {
    const cutoff = Date.now() - MAX_REQUEST_AGE_MS;
    for (const directory of [REQUESTS_DIR, RESPONSES_DIR]) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const path = join(directory, entry.name);
            try {
                if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
            } catch { }
        }
    }
}

async function ensureInitialized(): Promise<void> {
    if (!initialization) {
        initialization = (async () => {
            await Promise.all([
                mkdir(REQUESTS_DIR, { recursive: true }),
                mkdir(RESPONSES_DIR, { recursive: true }),
                mkdir(DOWNLOADS_DIR, { recursive: true }),
            ]);
            await ensureBridgeServer();
            bridgeSecret = (await readOrCreateConfig()).secret;
            await Promise.all([loadSentLedger(), cleanupStaleQueueFiles()]);
        })();
    }
    return initialization;
}

export async function initializeBridge(_: IpcMainInvokeEvent): Promise<{
    queueDirectory: string;
    allowedTools: readonly string[];
    sentMessageCount: number;
}> {
    await ensureInitialized();
    return {
        queueDirectory: BRIDGE_DIR,
        allowedTools: DISCORD_MCP_TOOL_NAMES,
        sentMessageCount: sentMessages.size,
    };
}

export async function configureMcpClients(_: IpcMainInvokeEvent, clients: unknown): Promise<McpSetupResult[]> {
    await ensureInitialized();
    if (!Array.isArray(clients) || clients.length === 0 || clients.some(client => !MCP_CLIENTS.includes(client as McpClient)))
        throw new Error("Choose at least one supported MCP client.");

    const selected = [...new Set(clients as McpClient[])];
    const results: McpSetupResult[] = [];
    for (const client of selected) {
        let path: string;
        switch (client) {
            case "codex": path = await writeCodexConfig(); break;
            case "claudeDesktop":
                path = claudeDesktopConfigPath();
                await writeJsonConfig(path);
                break;
            case "claudeCode":
                path = join(homedir(), ".claude.json");
                await writeJsonConfig(path);
                break;
            case "gemini":
                path = join(homedir(), ".gemini", "settings.json");
                await writeJsonConfig(path);
                break;
            case "cursor":
                path = join(homedir(), ".cursor", "mcp.json");
                await writeJsonConfig(path);
                break;
        }
        results.push({ client, path });
    }
    return results;
}

async function claimRequests(): Promise<BridgeRequest[]> {
    const requests: BridgeRequest[] = [];
    const entries = (await readdir(REQUESTS_DIR, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20);

    for (const entry of entries) {
        const sourcePath = join(REQUESTS_DIR, entry.name);
        const claimedPath = `${sourcePath}.${randomUUID()}.processing`;
        try {
            await rename(sourcePath, claimedPath);
            if ((await stat(claimedPath)).size > MAX_REQUEST_SIZE) continue;
            const parsed = JSON.parse(await readFile(claimedPath, "utf8")) as BridgeRequest;
            if (!REQUEST_ID.test(parsed.id)) continue;
            if (!equalSecret(parsed.secret)) continue;
            if (!allowedTools.has(parsed.tool)) continue;
            if (!Number.isFinite(parsed.createdAt) || Math.abs(Date.now() - parsed.createdAt) > MAX_REQUEST_AGE_MS) continue;
            requests.push(parsed);
        } catch { }
        finally { await rm(claimedPath, { force: true }).catch(() => undefined); }
    }

    return requests;
}

function waitForRequestSignal(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let watcher: ReturnType<typeof watch> | undefined;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            watcher?.close();
            resolve();
        };

        try {
            watcher = watch(REQUESTS_DIR, { persistent: false }, (_event, filename) => {
                if (!filename || filename.toString().endsWith(".json")) finish();
            });
            watcher.once("error", finish);
            timer = setTimeout(finish, timeoutMs);
        } catch {
            finish();
        }
    });
}

export async function takeRequests(_: IpcMainInvokeEvent, waitMs = 10_000): Promise<BridgeRequest[]> {
    await ensureInitialized();
    const immediatelyAvailable = await claimRequests();
    if (immediatelyAvailable.length > 0) return immediatelyAvailable;

    const boundedWaitMs = Number.isFinite(waitMs) ? Math.max(0, Math.min(30_000, waitMs)) : 10_000;
    if (boundedWaitMs > 0) await waitForRequestSignal(boundedWaitMs);
    return claimRequests();
}

export async function writeResponse(_: IpcMainInvokeEvent, response: BridgeResponse): Promise<void> {
    await ensureInitialized();
    if (!response || !REQUEST_ID.test(response.id)) throw new Error("Invalid Discord MCP response ID");
    await atomicWrite(join(RESPONSES_DIR, `${response.id}.json`), JSON.stringify(response));
}

export async function recordSentMessage(_: IpcMainInvokeEvent, channelId: string, messageId: string): Promise<void> {
    await ensureInitialized();
    if (!isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) throw new Error("Invalid message identity");
    sentMessages.add(sentMessageKey(channelId, messageId));
    if (sentMessages.size > 10_000) sentMessages.delete(sentMessages.values().next().value!);
    await persistSentLedger();
}

export async function isSentMessage(_: IpcMainInvokeEvent, channelId: string, messageId: string): Promise<boolean> {
    await ensureInitialized();
    if (!isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) return false;
    return sentMessages.has(sentMessageKey(channelId, messageId));
}

export async function forgetSentMessage(_: IpcMainInvokeEvent, channelId: string, messageId: string): Promise<void> {
    await ensureInitialized();
    if (!isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) return;
    sentMessages.delete(sentMessageKey(channelId, messageId));
    await persistSentLedger();
}

function safeDownloadName(filename: string): string {
    const extension = extname(filename).slice(0, 16).replace(/[^.A-Za-z0-9_-]/g, "");
    const stem = basename(filename, extname(filename)).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "attachment";
    return `${Date.now()}-${randomUUID()}-${stem}${extension}`;
}

function validateAttachmentUrl(url: string): URL {
    const parsed = new URL(url);
    if (
        parsed.protocol !== "https:" ||
        !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname) ||
        !parsed.pathname.startsWith("/attachments/")
    ) throw new Error("Blocked an untrusted attachment URL");
    return parsed;
}

async function fetchAttachmentData(url: string): Promise<AttachmentData> {
    const response = await fetch(validateAttachmentUrl(url));
    if (!response.ok || !response.body) throw new Error(`Attachment download failed with HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_SIZE)
        throw new Error("Attachment exceeds the 25 MB Discord MCP limit");

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ATTACHMENT_SIZE) {
            await reader.cancel();
            throw new Error("Attachment exceeds the 25 MB Discord MCP limit");
        }
        chunks.push(value);
    }

    return {
        contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
        data: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))),
    };
}

export async function fetchDiscordAttachment(_: IpcMainInvokeEvent, url: string): Promise<{
    contentType: string;
    data: Uint8Array;
}> {
    await ensureInitialized();
    if (typeof url !== "string") throw new Error("Invalid attachment URL");
    const result = await fetchAttachmentData(url);
    return { contentType: result.contentType, data: new Uint8Array(result.data) };
}

export async function downloadDiscordAttachment(
    _: IpcMainInvokeEvent,
    url: string,
    filename: string
): Promise<DownloadResult> {
    await ensureInitialized();
    if (typeof url !== "string" || typeof filename !== "string") throw new Error("Invalid attachment");

    const { contentType, data } = await fetchAttachmentData(url);
    const outputName = safeDownloadName(filename);
    const outputPath = join(DOWNLOADS_DIR, outputName);
    await writeFile(outputPath, data, { flag: "wx", mode: 0o600 });

    return {
        path: outputPath,
        filename,
        contentType,
        data: new Uint8Array(data),
        size: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
    };
}
