/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type CodexTurn, diffProcesses, type DistributiveOmit, extractQuestion, formatDuration, parseCodexLine, parsePs, parseRobloxLine, parseTasklist, type ProcessInfo, processKey, projectName, type RobloxGame, type SystemEvent } from "@components/settings/tabs/automations/system";
import { DATA_DIR } from "@main/utils/constants";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { type IpcMainInvokeEvent, safeStorage, shell } from "electron";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve, sep } from "path";

const STORAGE_DIR = join(DATA_DIR, "automations");
const KEY_PATH = join(STORAGE_DIR, "openrouter-key.bin");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODEL_CACHE_MS = 60 * 60 * 1000;
/** A model id is "vendor/name", optionally with a ":variant" suffix such as ":free". */
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

export interface OpenRouterModel {
    id: string;
    name: string;
    promptPrice: number;
    completionPrice: number;
    contextLength: number;
}

let modelCache: { models: OpenRouterModel[]; fetchedAt: number; } | null = null;
/** Ids OpenRouter has confirmed exist, so a completion cannot smuggle in an arbitrary URL path. */
let knownModelIds = new Set<string>();

const completions = new Map<string, AbortController>();

interface CompletionInput {
    requestId: string;
    timeoutSeconds: number;
    messages: { role: "user" | "assistant"; content: string; }[];
    model: string;
    systemPrompt: string;
    prompt: string;
    maxTokens: number;
    temperature: number;
    json: boolean;
}

interface CompletionResult {
    success: boolean;
    content?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    error?: string;
}

function secureStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
        && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function atomicWrite(value: Uint8Array): Promise<void> {
    await mkdir(STORAGE_DIR, { recursive: true });
    const temporaryPath = `${KEY_PATH}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, value, { mode: 0o600 });
    await rename(temporaryPath, KEY_PATH);
}

async function readKey(): Promise<string | null> {
    if (!secureStorageAvailable()) return null;
    try {
        return safeStorage.decryptString(await readFile(KEY_PATH));
    } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
    }
}

function completionInput(value: unknown): CompletionInput | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const input = value as Partial<CompletionInput>;
    if (
        typeof input.requestId !== "string"
        || !/^[\w-]{1,80}$/.test(input.requestId)
        || typeof input.timeoutSeconds !== "number" || !Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 300
        || !Array.isArray(input.messages) || input.messages.length > 40
        || !input.messages.every(message => typeof message === "object" && message !== null && (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.length <= 20000)
        || typeof input.model !== "string"
        || !MODEL_ID.test(input.model)
        || input.model.length > 120
        || (knownModelIds.size > 0 && !knownModelIds.has(input.model))
        || typeof input.systemPrompt !== "string"
        || input.systemPrompt.length > 20_000
        || typeof input.prompt !== "string"
        || input.prompt.length === 0
        || input.prompt.length > 100_000
        || typeof input.maxTokens !== "number"
        || !Number.isInteger(input.maxTokens)
        || input.maxTokens < 16
        || input.maxTokens > 4_096
        || typeof input.temperature !== "number"
        || !Number.isFinite(input.temperature)
        || input.temperature < 0
        || input.temperature > 2
        || typeof input.json !== "boolean"
    ) return null;
    const messages = input.messages.map(({ role, content }) => ({ role, content }));
    if (JSON.stringify(messages).length > 100000) return null;
    return { ...input, messages } as CompletionInput;
}

async function responseText(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new Error("OpenRouter returned too much data.");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

function toModel(value: unknown): OpenRouterModel | null {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || !MODEL_ID.test(entry.id)) return null;
    const pricing = typeof entry.pricing === "object" && entry.pricing !== null ? entry.pricing as Record<string, unknown> : {};
    const price = (key: string) => {
        const raw = pricing[key];
        const parsed = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : Number.NaN;
        return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        promptPrice: price("prompt"),
        completionPrice: price("completion"),
        contextLength: typeof entry.context_length === "number" ? entry.context_length : 0,
    };
}

/** The models OpenRouter currently serves. Cached for an hour; no key needed to read it. */
export async function listOpenRouterModels(_event: IpcMainInvokeEvent, refresh?: unknown): Promise<{ success: boolean; models?: OpenRouterModel[]; error?: string; }> {
    if (modelCache && refresh !== true && Date.now() - modelCache.fetchedAt < MODEL_CACHE_MS) {
        return { success: true, models: modelCache.models };
    }
    try {
        const response = await fetch(OPENROUTER_MODELS_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) return { success: false, error: `OpenRouter returned ${response.status} for its model list.` };
        const parsed: unknown = JSON.parse(await responseText(response));
        const data = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).data : null;
        if (!Array.isArray(data)) return { success: false, error: "OpenRouter did not return a model list." };

        const models = data.flatMap(entry => {
            const model = toModel(entry);
            return model ? [model] : [];
        }).sort((left, right) => left.name.localeCompare(right.name));
        if (!models.length) return { success: false, error: "OpenRouter returned no usable models." };

        modelCache = { models, fetchedAt: Date.now() };
        knownModelIds = new Set(models.map(model => model.id));
        return { success: true, models };
    } catch {
        return { success: false, error: "OpenRouter's model list could not be reached." };
    }
}

export async function getOpenRouterStatus(_event: IpcMainInvokeEvent): Promise<{ available: boolean; configured: boolean; error?: string; }> {
    if (!secureStorageAvailable()) return { available: false, configured: false, error: "Secure operating system storage is unavailable." };
    try {
        return { available: true, configured: Boolean(await readKey()) };
    } catch {
        return { available: true, configured: false, error: "Encrypted credential storage could not be read." };
    }
}

export async function setOpenRouterKey(_event: IpcMainInvokeEvent, value: unknown): Promise<{ success: boolean; error?: string; }> {
    if (!secureStorageAvailable()) return { success: false, error: "Secure operating system storage is unavailable." };
    if (typeof value !== "string" || value.trim().length < 20 || value.trim().length > 512)
        return { success: false, error: "Enter a valid OpenRouter API key." };
    try {
        await atomicWrite(safeStorage.encryptString(value.trim()));
        return { success: true };
    } catch {
        return { success: false, error: "The OpenRouter key could not be saved." };
    }
}

export async function clearOpenRouterKey(_event: IpcMainInvokeEvent): Promise<{ success: boolean; error?: string; }> {
    try {
        await unlink(KEY_PATH);
        return { success: true };
    } catch (error) {
        return isMissingFile(error) ? { success: true } : { success: false, error: "The OpenRouter key could not be removed." };
    }
}

export function cancelOpenRouter(event: IpcMainInvokeEvent, requestId: unknown): { success: boolean; } {
    if (typeof requestId !== "string" || !/^[\w-]{1,80}$/.test(requestId)) return { success: false };
    completions.get(`${event.sender.id}:${requestId}`)?.abort();
    return { success: true };
}

export async function completeOpenRouter(_event: IpcMainInvokeEvent, value: unknown): Promise<CompletionResult> {
    const input = completionInput(value);
    if (!input) return { success: false, error: "The AI block configuration is invalid." };
    if (completions.size >= 32) return { success: false, error: "Too many AI requests are active." };
    const requestKey = `${_event.sender.id}:${input.requestId}`;
    if (completions.has(requestKey)) return { success: false, error: "This AI request is already running." };
    const controller = new AbortController();
    completions.set(requestKey, controller);
    let key: string | null;
    try {
        key = await readKey();
    } catch {
        completions.delete(requestKey);
        return { success: false, error: "The OpenRouter key could not be read." };
    }
    if (!key) { completions.delete(requestKey); return { success: false, error: "Add an OpenRouter API key in Automation settings." }; }

    const timeout = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
    try {
        const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/SenorLawyer/LawyerCord",
                "X-OpenRouter-Title": "LawyerCord Automations",
            },
            body: JSON.stringify({
                model: input.model,
                messages: [
                    ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
                    ...input.messages,
                    { role: "user", content: input.prompt },
                ],
                max_tokens: input.maxTokens,
                temperature: input.temperature,
                ...(input.json ? { response_format: { type: "json_object" } } : {}),
            }),
        });
        const text = await responseText(response);
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            return { success: false, error: `OpenRouter returned HTTP ${response.status}.` };
        }
        if (typeof body !== "object" || body === null || Array.isArray(body))
            return { success: false, error: "OpenRouter returned an invalid response." };
        const record = body as Record<string, unknown>;
        if (!response.ok) {
            const { error } = record;
            const errorMessage = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
                ? error.message
                : `OpenRouter returned HTTP ${response.status}.`;
            return { success: false, error: errorMessage.slice(0, 500) };
        }
        const { choices } = record;
        const first = Array.isArray(choices) ? choices[0] : undefined;
        const resultMessage = typeof first === "object" && first !== null && "message" in first ? first.message : undefined;
        const content = typeof resultMessage === "object" && resultMessage !== null && "content" in resultMessage && typeof resultMessage.content === "string"
            ? resultMessage.content
            : undefined;
        if (!content) return { success: false, error: "OpenRouter returned no text." };
        const usage = typeof record.usage === "object" && record.usage !== null ? record.usage as Record<string, unknown> : {};
        return {
            success: true,
            content,
            model: typeof record.model === "string" ? record.model : input.model,
            promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
            completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
        };
    } catch (error) {
        return { success: false, error: error instanceof DOMException && error.name === "AbortError" ? "OpenRouter timed out." : "The OpenRouter request failed." };
    } finally {
        clearTimeout(timeout);
        completions.delete(requestKey);
    }
}

// ---- This computer: running programs, Roblox sessions and Codex turns ----

const HOME = homedir();
const ROBLOX_LOGS = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local"), "Roblox", "logs")
    : join(HOME, "Library", "Logs", "Roblox");
const CODEX_SESSIONS = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "sessions");
const EVENT_LIMIT = 200;
const OUTPUT_CAP = 200_000;
const READ_CAP = 4 * 1024 * 1024;
const ROBLOX_GAMES_URL = "https://games.roblox.com/v1/games?universeIds=";
const ROBLOX_ICONS_URL = "https://thumbnails.roblox.com/v1/games/icons?size=512x512&format=Png&universeIds=";
const ROBLOX_UNIVERSE_URL = "https://apis.roblox.com/universes/v1/places/";

interface CodexSessionHeader {
    sessionId: string;
    cwd: string;
    originator: string;
    subagent: boolean;
}

interface TrackedFile {
    offset: number;
    session?: CodexSessionHeader;
}

const system = {
    busy: false,
    lastError: "",
    events: [] as SystemEvent[],
    nextId: 1,
    processes: new Map<string, number>(),
    processesReady: false,
    lastProcessScan: 0,
    roblox: {
        file: "",
        offset: 0,
        silent: true,
        session: null as { game: RobloxGame; joinedAt: number; } | null,
        pendingJoin: null as { jobId: string; placeId: string; } | null,
    },
    codex: {
        files: new Map<string, TrackedFile>(),
        turns: new Map<string, CodexTurn>(),
        last: null as CodexTurn | null,
        primed: false,
    },
    gameCache: new Map<string, { game: RobloxGame; at: number; }>(),
};

function pushEvent(event: DistributiveOmit<SystemEvent, "id" | "at">): void {
    system.events.push({ ...event, id: system.nextId++, at: Date.now() });
    if (system.events.length > EVENT_LIMIT) system.events.splice(0, system.events.length - EVENT_LIMIT);
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function first(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : undefined;
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function spawnText(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; }> {
    return new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(command, args, { windowsHide: true, shell: false });
        } catch (error) {
            resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : "The program could not be started.", timedOut: false });
            return;
        }
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8").slice(0, OUTPUT_CAP - stdout.length); });
        child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8").slice(0, OUTPUT_CAP - stderr.length); });
        child.on("error", error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr || error.message, timedOut }); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    });
}

async function readProcesses(): Promise<ProcessInfo[]> {
    if (process.platform === "win32") return parseTasklist((await spawnText("tasklist", ["/FO", "CSV", "/NH"], 15_000)).stdout);
    return parsePs((await spawnText("ps", ["-eo", "pid=,rss=,comm="], 15_000)).stdout);
}

async function scanProcesses(): Promise<void> {
    if (Date.now() - system.lastProcessScan < 4_000) return;
    system.lastProcessScan = Date.now();
    const after = new Map<string, number>();
    for (const item of await readProcesses()) {
        const key = processKey(item.name);
        if (!after.has(key)) after.set(key, item.pid);
    }
    if (!after.size) return;
    if (system.processesReady) {
        const { started, exited } = diffProcesses(system.processes, after);
        for (const item of started) pushEvent({ type: "process-start", process: item });
        for (const item of exited) pushEvent({ type: "process-exit", process: item });
    }
    // Roblox closed by the window button never writes a disconnect line, so the process vanishing ends the session.
    // On the first scan that is just old log state, so it ends quietly.
    if (system.roblox.session && process.platform === "win32" && !after.has("robloxplayerbeta.exe")) endRobloxSession(!system.processesReady);
    system.processes = after;
    system.processesReady = true;
}

/** New bytes since the last read, minus any half-written last line, which is picked up next time. */
async function readAppended(path: string, offset: number): Promise<{ lines: string[]; offset: number; }> {
    const handle = await open(path, "r");
    try {
        const { size } = await handle.stat();
        const start = size < offset ? 0 : offset;
        if (size === start) return { lines: [], offset: size };
        const length = Math.min(size - start, READ_CAP);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0A) + 1;
        return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), offset: start + end };
    } finally {
        await handle.close();
    }
}

async function fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return JSON.parse(await responseText(response));
}

async function fetchRobloxGame(universeId: string, placeId: string, jobId: string): Promise<RobloxGame> {
    const cached = system.gameCache.get(universeId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return { ...cached.game, jobId };
    const fallback: RobloxGame = { placeId, universeId, jobId, name: `Place ${placeId}`, description: "", playing: 0, visits: 0, maxPlayers: 0, creator: "", genre: "", icon: "", url: `https://www.roblox.com/games/${placeId}` };
    try {
        const [games, icons] = await Promise.all([fetchJson(ROBLOX_GAMES_URL + universeId), fetchJson(ROBLOX_ICONS_URL + universeId).catch(() => null)]);
        const entry = record(first(record(games).data));
        if (!entry.id) return fallback;
        const rootPlace = entry.rootPlaceId === undefined ? placeId : String(entry.rootPlaceId);
        const game: RobloxGame = {
            placeId: rootPlace,
            universeId: String(entry.id),
            jobId,
            name: str(entry.name) || fallback.name,
            description: str(entry.description).slice(0, 1000),
            playing: num(entry.playing),
            visits: num(entry.visits),
            maxPlayers: num(entry.maxPlayers),
            creator: str(record(entry.creator).name),
            genre: str(entry.genre),
            icon: str(record(first(record(icons).data)).imageUrl),
            url: `https://www.roblox.com/games/${rootPlace}`,
        };
        system.gameCache.set(universeId, { game, at: Date.now() });
        return game;
    } catch {
        return fallback;
    }
}

function endRobloxSession(silent = false): void {
    const { session } = system.roblox;
    if (!session) return;
    system.roblox.session = null;
    const durationMs = Date.now() - session.joinedAt;
    if (!silent && !system.roblox.silent) pushEvent({ type: "roblox-leave", game: session.game, joinedAt: session.joinedAt, durationMs, duration: formatDuration(durationMs) });
}

async function startRobloxSession(placeId: string, universeId: string, jobId: string): Promise<void> {
    endRobloxSession();
    const game = await fetchRobloxGame(universeId, placeId, jobId);
    const joinedAt = Date.now();
    system.roblox.session = { game, joinedAt };
    if (!system.roblox.silent) pushEvent({ type: "roblox-join", game, joinedAt });
}

async function newestRobloxLog(): Promise<string | undefined> {
    let names: string[];
    try { names = await readdir(ROBLOX_LOGS); } catch { return undefined; }
    let best: { path: string; mtime: number; } | undefined;
    for (const name of names) {
        if (!/Player.*\.log$/i.test(name)) continue;
        const path = join(ROBLOX_LOGS, name);
        try {
            const info = await stat(path);
            if (!best || info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs };
        } catch { continue; }
    }
    return best?.path;
}

async function scanRoblox(): Promise<void> {
    const file = await newestRobloxLog();
    if (!file) return;
    const state = system.roblox;
    if (file !== state.file) {
        // The first log seen only tells us where things stand. A newer log after that is a fresh Roblox launch, so it is read in full.
        state.silent = state.file === "";
        state.file = file;
        state.offset = 0;
        state.pendingJoin = null;
    }
    const { lines, offset } = await readAppended(file, state.offset);
    state.offset = offset;
    for (const line of lines) {
        const parsed = parseRobloxLine(line);
        if (!parsed) continue;
        if (parsed.kind === "join") state.pendingJoin = { jobId: parsed.jobId, placeId: parsed.placeId };
        else if (parsed.kind === "universe") {
            const pending = state.pendingJoin;
            state.pendingJoin = null;
            await startRobloxSession(parsed.placeId, parsed.universeId, pending?.placeId === parsed.placeId ? pending.jobId : "");
        } else endRobloxSession();
    }
    state.silent = false;
}

function codexDayFolders(): string[] {
    return [0, 1].map(back => {
        const day = new Date(Date.now() - back * 86_400_000);
        return join(CODEX_SESSIONS, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    });
}

async function codexFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const dir of codexDayFolders()) {
        try {
            for (const name of await readdir(dir)) if (name.endsWith(".jsonl")) files.push(join(dir, name));
        } catch { continue; }
    }
    return files;
}

async function readCodexHeader(file: string): Promise<CodexSessionHeader | undefined> {
    const { lines } = await readAppended(file, 0);
    for (const line of lines.slice(0, 3)) {
        const parsed = parseCodexLine(line);
        if (parsed?.kind === "session") return parsed;
    }
    return undefined;
}

function turnFor(turnId: string, header: CodexSessionHeader | undefined, startedAt: number): CodexTurn {
    const cwd = header?.cwd ?? "";
    return { sessionId: header?.sessionId ?? "", turnId, cwd, project: projectName(cwd), originator: header?.originator ?? "", subagent: header?.subagent ?? false, status: "started", startedAt };
}

async function scanCodex(): Promise<void> {
    const files = await codexFiles();
    for (const file of files) {
        let tracked = system.codex.files.get(file);
        if (!tracked) {
            tracked = { offset: 0 };
            system.codex.files.set(file, tracked);
            // Sessions that already exist when the watch starts are not replayed, only their header is kept.
            if (!system.codex.primed) {
                try {
                    tracked.session = await readCodexHeader(file);
                    tracked.offset = (await stat(file)).size;
                } catch { continue; }
                continue;
            }
        }
        let read: { lines: string[]; offset: number; };
        try { read = await readAppended(file, tracked.offset); } catch { continue; }
        tracked.offset = read.offset;
        for (const line of read.lines) {
            const parsed = parseCodexLine(line);
            if (!parsed) continue;
            if (parsed.kind === "session") { tracked.session = parsed; continue; }
            if (parsed.kind === "started") {
                const turn = turnFor(parsed.turnId, tracked.session, parsed.startedAt);
                system.codex.turns.set(parsed.turnId, turn);
                pushEvent({ type: "codex-start", codex: turn });
                continue;
            }
            const turn = system.codex.turns.get(parsed.turnId) ?? turnFor(parsed.turnId, tracked.session, Date.now());
            system.codex.turns.delete(parsed.turnId);
            turn.finishedAt = Date.now();
            turn.durationMs = parsed.kind === "aborted" ? parsed.durationMs : turn.finishedAt - turn.startedAt;
            turn.duration = formatDuration(turn.durationMs);
            turn.status = parsed.kind === "aborted" ? "aborted" : "finished";
            if (parsed.kind === "finished") {
                turn.message = parsed.message.slice(0, 4000);
                turn.question = extractQuestion(parsed.message);
            }
            system.codex.last = turn;
            if (parsed.kind !== "finished") continue;
            pushEvent({ type: "codex-finish", codex: turn });
            if (turn.question) pushEvent({ type: "codex-question", codex: turn });
        }
    }
    system.codex.primed = true;
    for (const key of system.codex.files.keys()) if (!files.includes(key)) system.codex.files.delete(key);
}

async function scanSystem(types: string[]): Promise<void> {
    if (system.busy) return;
    system.busy = true;
    try {
        const scans = [
            ...(types.some(type => type.startsWith("roblox-")) ? [scanRoblox] : []),
            ...(types.some(type => type.startsWith("codex-")) ? [scanCodex] : []),
            ...(types.some(type => type.startsWith("process-") || type.startsWith("roblox-")) ? [scanProcesses] : []),
        ];
        for (const scan of scans) {
            try { await scan(); }
            catch (error) { system.lastError = error instanceof Error ? error.message : String(error); }
        }
    } finally { system.busy = false; }
}

export async function pollSystemEvents(_event: IpcMainInvokeEvent, after: unknown, requested: unknown): Promise<{ events: SystemEvent[]; cursor: number; }> {
    const types = Array.isArray(requested) ? requested.filter((value): value is string => typeof value === "string" && /^(roblox|codex|process)-/.test(value)).slice(0, 10) : [];
    await scanSystem(types);
    const since = typeof after === "number" && Number.isFinite(after) ? after : 0;
    return { events: system.events.filter(event => event.id > since && types.includes(event.type)), cursor: system.nextId - 1 };
}

export async function listProcesses(_event: IpcMainInvokeEvent): Promise<ProcessInfo[]> {
    return readProcesses();
}

export async function isProcessRunning(_event: IpcMainInvokeEvent, name: unknown): Promise<boolean> {
    if (typeof name !== "string" || !name.trim() || name.length > 200) return false;
    const key = processKey(name);
    const bare = key.replace(/\.exe$/, "");
    return (await readProcesses()).some(item => {
        const candidate = processKey(item.name);
        return candidate === key || candidate.replace(/\.exe$/, "") === bare;
    });
}

export async function robloxSession(_event: IpcMainInvokeEvent): Promise<{ game: RobloxGame; joinedAt: number; duration: string; } | null> {
    await scanSystem(["roblox-join"]);
    const { session } = system.roblox;
    return session ? { ...session, duration: formatDuration(Date.now() - session.joinedAt) } : null;
}

export async function robloxGameInfo(_event: IpcMainInvokeEvent, id: unknown): Promise<RobloxGame | null> {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id)) return null;
    let universeId = id;
    let placeId = id;
    try {
        if (!record(first(record(await fetchJson(ROBLOX_GAMES_URL + id)).data)).id) {
            universeId = String(num(record(await fetchJson(`${ROBLOX_UNIVERSE_URL}${id}/universe`)).universeId) || "");
            if (!universeId) return null;
        } else placeId = "";
    } catch {
        return null;
    }
    const game = await fetchRobloxGame(universeId, placeId, "");
    return game.name.startsWith("Place ") && !placeId ? null : game;
}

export async function codexLastTurn(_event: IpcMainInvokeEvent): Promise<CodexTurn | null> {
    await scanSystem(["codex-finish"]);
    return system.codex.last;
}

export async function codexRecentSessions(_event: IpcMainInvokeEvent, limit: unknown): Promise<(CodexSessionHeader & { project: string; startedAt: number; })[]> {
    const count = typeof limit === "number" && Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.trunc(limit))) : 10;
    const files: { file: string; mtime: number; }[] = [];
    for (const file of await codexFiles()) {
        try { files.push({ file, mtime: (await stat(file)).mtimeMs }); } catch { continue; }
    }
    files.sort((left, right) => right.mtime - left.mtime);
    const sessions: (CodexSessionHeader & { project: string; startedAt: number; })[] = [];
    for (const { file, mtime } of files) {
        if (sessions.length >= count) break;
        try {
            const header = await readCodexHeader(file);
            if (header) sessions.push({ ...header, project: projectName(header.cwd), startedAt: mtime });
        } catch { continue; }
    }
    return sessions;
}

export async function runProgram(_event: IpcMainInvokeEvent, input: unknown): Promise<{ success: boolean; code?: number | null; stdout?: string; stderr?: string; error?: string; }> {
    const value = record(input);
    const command = str(value.command).trim();
    const args = Array.isArray(value.args) ? value.args : [];
    const timeoutSeconds = num(value.timeoutSeconds) || 60;
    if (!command || command.length > 500 || /[\r\n]/.test(command)) return { success: false, error: "Choose a program to run." };
    if (args.length > 64 || !args.every(arg => typeof arg === "string" && arg.length <= 2000)) return { success: false, error: "Program arguments must be short text, one per line." };
    const result = await spawnText(command, args.map(String), Math.min(600, Math.max(1, timeoutSeconds)) * 1000);
    if (result.timedOut) return { success: false, error: "The program took too long and was stopped." };
    if (result.code === null && !result.stdout) return { success: false, error: result.stderr.slice(0, 300) || "The program could not be started." };
    return { success: true, code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function readTextFile(_event: IpcMainInvokeEvent, input: unknown): Promise<{ success: boolean; text?: string; error?: string; }> {
    const value = record(input);
    const requested = str(value.path).trim();
    if (!requested) return { success: false, error: "Choose a file to read." };
    const target = resolve(requested);
    const root = resolve(HOME);
    const inside = process.platform === "win32" ? target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(root.toLowerCase() + sep) : target === root || target.startsWith(root + sep);
    if (!inside) return { success: false, error: "Only files inside your user folder can be read." };
    const maxBytes = Math.min(2_000_000, Math.max(1, Math.trunc(num(value.maxBytes) || 200_000)));
    try {
        const info = await stat(target);
        if (!info.isFile()) return { success: false, error: "That path is not a file." };
        const handle = await open(target, "r");
        try {
            const length = Math.min(info.size, maxBytes);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, 0);
            return { success: true, text: buffer.toString("utf8") };
        } finally {
            await handle.close();
        }
    } catch (error) {
        return { success: false, error: isMissingFile(error) ? "That file does not exist." : "The file could not be read." };
    }
}

export async function openLink(_event: IpcMainInvokeEvent, url: unknown): Promise<{ success: boolean; error?: string; }> {
    if (typeof url !== "string" || url.length > 2000) return { success: false, error: "Choose a link to open." };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { success: false, error: "That is not a valid link." }; }
    if (parsed.protocol !== "https:") return { success: false, error: "Only https links can be opened." };
    await shell.openExternal(parsed.toString());
    return { success: true };
}
