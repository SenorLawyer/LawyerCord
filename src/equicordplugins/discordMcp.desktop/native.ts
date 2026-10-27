/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import type { IpcMainInvokeEvent } from "electron";
import { watch } from "fs";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "fs/promises";
import { homedir, platform } from "os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "path";

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
const MAX_RESPONSE_SIZE = 4 * 1024 * 1024;
const MAX_ERROR_LENGTH = 2_000;
const DOWNLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DOWNLOADS_MAX_TOTAL_SIZE = 500 * 1024 * 1024;
const MAX_UPLOAD_DIRECTORIES = 20;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const allowedTools = new Set<string>(DISCORD_MCP_TOOL_NAMES);

let initialization: Promise<void> | null = null;
let bridgeSecret = "";
let sentMessages = new Set<string>();
let ledgerWrite = Promise.resolve();
let attachmentDownloads = 0;

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
    const write = ledgerWrite.then(() =>
        atomicWrite(SENT_LEDGER_PATH, `${JSON.stringify([...sentMessages], null, 2)}\n`)
    );
    ledgerWrite = write.catch(() => undefined);
    return write;
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

async function sweepDownloads(keep?: string): Promise<void> {
    const cutoff = Date.now() - DOWNLOAD_MAX_AGE_MS;
    const remaining: Array<{ path: string; mtimeMs: number; size: number; }> = [];
    for (const entry of await readdir(DOWNLOADS_DIR, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(DOWNLOADS_DIR, entry.name);
        try {
            const info = await stat(path);
            if (path !== keep && info.mtimeMs < cutoff) await rm(path, { force: true });
            else remaining.push({ path, mtimeMs: info.mtimeMs, size: info.size });
        } catch { }
    }

    let total = remaining.reduce((sum, file) => sum + file.size, 0);
    for (const file of remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= DOWNLOADS_MAX_TOTAL_SIZE) break;
        if (file.path === keep) continue;
        await rm(file.path, { force: true }).catch(() => undefined);
        total -= file.size;
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
            await Promise.all([loadSentLedger(), cleanupStaleQueueFiles(), sweepDownloads()]);
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

async function respondWithError(id: string, error: string): Promise<void> {
    await atomicWrite(join(RESPONSES_DIR, `${id}.json`), JSON.stringify({ id, ok: false, error })).catch(() => undefined);
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
            if (!allowedTools.has(parsed.tool)) {
                await respondWithError(parsed.id, "Unsupported Discord MCP tool");
                continue;
            }
            if (!Number.isFinite(parsed.createdAt) || Math.abs(Date.now() - parsed.createdAt) > MAX_REQUEST_AGE_MS) {
                await respondWithError(parsed.id, "The request expired before Discord picked it up. Check that your system clock is correct.");
                continue;
            }
            requests.push(parsed);
        } catch { }
        finally { await rm(claimedPath, { force: true }).catch(() => undefined); }
    }

    return requests;
}

const WATCH_FALLBACK_POLL_MS = 250;

function watchForRequests(timeoutMs: number): { signal: Promise<void>; cancel(): void; } {
    let finish = () => { };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    const signal = new Promise<void>(resolve => {
        let finished = false;
        finish = () => {
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
            timer = setTimeout(finish, Math.min(timeoutMs, WATCH_FALLBACK_POLL_MS));
        }
    });
    return { signal, cancel: finish };
}

export async function takeRequests(_: IpcMainInvokeEvent, waitMs = 10_000): Promise<BridgeRequest[]> {
    await ensureInitialized();
    const boundedWaitMs = Number.isFinite(waitMs) ? Math.max(0, Math.min(30_000, waitMs)) : 10_000;
    const watcher = boundedWaitMs > 0 ? watchForRequests(boundedWaitMs) : null;
    try {
        const available = await claimRequests();
        if (available.length > 0 || !watcher) return available;
        await watcher.signal;
        return await claimRequests();
    } finally {
        watcher?.cancel();
    }
}

export async function writeResponse(_: IpcMainInvokeEvent, response: BridgeResponse): Promise<void> {
    await ensureInitialized();
    if (!isRecord(response) || typeof response.id !== "string" || !REQUEST_ID.test(response.id) || typeof response.ok !== "boolean")
        throw new Error("Invalid Discord MCP response");
    const body = JSON.stringify({
        id: response.id,
        ok: response.ok,
        ...(response.ok ? { result: response.result } : { error: String(response.error ?? "Discord MCP request failed").slice(0, MAX_ERROR_LENGTH) }),
    });
    if (body.length > MAX_RESPONSE_SIZE) throw new Error("Discord MCP response is too large");
    await atomicWrite(join(RESPONSES_DIR, `${response.id}.json`), body);
}

export async function recordSentMessage(_: IpcMainInvokeEvent, channelId: string, messageId: string): Promise<void> {
    await ensureInitialized();
    if (!isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) throw new Error("Invalid message identity");
    sentMessages.add(sentMessageKey(channelId, messageId));
    while (sentMessages.size > 10_000) {
        const oldest = sentMessages.values().next();
        if (oldest.done) break;
        sentMessages.delete(oldest.value);
    }
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
        !["https://cdn.discordapp.com", "https://media.discordapp.net"].includes(parsed.origin) ||
        !parsed.pathname.startsWith("/attachments/")
    ) throw new Error("Blocked an untrusted attachment URL");
    return parsed;
}

async function fetchAttachmentData(url: string): Promise<AttachmentData> {
    const parsed = validateAttachmentUrl(url);
    if (attachmentDownloads >= 4) throw new Error("Four attachments are already downloading. Try again when one finishes.");
    attachmentDownloads++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetch(parsed, { redirect: "error", signal: controller.signal });
        reader = response.body?.getReader();
        if (!response.ok || !reader) throw new Error(`Attachment download failed with HTTP ${response.status}`);
        const declaredSize = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_ATTACHMENT_SIZE)
            throw new Error("Attachment exceeds the 25 MB Discord MCP limit");

        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_ATTACHMENT_SIZE) throw new Error("Attachment exceeds the 25 MB Discord MCP limit");
            chunks.push(value);
        }

        return {
            contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
            data: Buffer.concat(chunks, size),
        };
    } finally {
        clearTimeout(timeout);
        controller.abort();
        if (reader) {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
        attachmentDownloads--;
    }
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
    await sweepDownloads(outputPath).catch(() => undefined);

    return {
        path: outputPath,
        filename,
        contentType,
        data: new Uint8Array(data),
        size: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
    };
}

function insideDirectory(parent: string, child: string): boolean {
    const normalize = (value: string) => platform() === "win32" ? value.toLowerCase() : value;
    const offset = relative(normalize(parent), normalize(child));
    return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

async function allowedUploadRoots(directories: unknown): Promise<string[]> {
    if (!Array.isArray(directories) || directories.length > MAX_UPLOAD_DIRECTORIES) throw new Error("Invalid upload folder list");
    const roots = [await realpath(DOWNLOADS_DIR)];
    for (const directory of directories) {
        if (typeof directory !== "string" || directory.length > 1_024 || !isAbsolute(directory)) continue;
        const resolved = resolve(directory);
        if (resolved === parse(resolved).root) continue;
        try {
            if ((await stat(resolved)).isDirectory()) roots.push(await realpath(resolved));
        } catch { }
    }
    return roots;
}

export async function readUploadFile(_: IpcMainInvokeEvent, filePath: unknown, directories: unknown): Promise<{
    name: string;
    data: Uint8Array;
}> {
    await ensureInitialized();
    if (typeof filePath !== "string" || filePath.length < 1 || filePath.length > 1_024 || !isAbsolute(filePath))
        throw new Error("Attachment paths must be full paths");

    const roots = await allowedUploadRoots(directories);
    let resolved: string;
    try { resolved = await realpath(filePath); }
    catch { throw new Error("Attachment file was not found"); }

    const bridge = await realpath(BRIDGE_DIR);
    const downloads = await realpath(DOWNLOADS_DIR);
    const dataDirectory = await realpath(DATA_DIR);
    if (!roots.some(root => insideDirectory(root, resolved)))
        throw new Error("That file is outside the folders allowed in the DiscordMCP settings");
    if ((insideDirectory(bridge, resolved) || insideDirectory(dataDirectory, resolved)) && !insideDirectory(downloads, resolved))
        throw new Error("That file is private to LawyerCord and cannot be sent");

    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Attachment path must be a file");
    if (info.size > MAX_ATTACHMENT_SIZE) throw new Error("Attachment exceeds the 25 MB Discord MCP limit");
    return { name: basename(resolved), data: new Uint8Array(await readFile(resolved)) };
}
