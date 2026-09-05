/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Things that happen on this computer rather than inside Discord. Pure parsing lives here so the main process and the tests share it. */

export const SYSTEM_TRIGGER_TYPES = ["roblox-join", "roblox-leave", "process-start", "process-exit", "codex-start", "codex-finish", "codex-question"] as const;
export type SystemTriggerType = typeof SYSTEM_TRIGGER_TYPES[number];

export interface RobloxGame {
    placeId: string;
    universeId: string;
    jobId: string;
    name: string;
    description: string;
    playing: number;
    visits: number;
    maxPlayers: number;
    creator: string;
    genre: string;
    icon: string;
    url: string;
}

export interface ProcessInfo {
    name: string;
    pid: number;
    memoryKb: number;
}

export interface CodexTurn {
    sessionId: string;
    turnId: string;
    cwd: string;
    project: string;
    originator: string;
    subagent: boolean;
    status: "started" | "finished" | "aborted";
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
    duration?: string;
    message?: string;
    question?: string;
}

export type SystemEvent =
    | { id: number; at: number; type: "roblox-join"; game: RobloxGame; joinedAt: number; }
    | { id: number; at: number; type: "roblox-leave"; game: RobloxGame; joinedAt: number; durationMs: number; duration: string; }
    | { id: number; at: number; type: "process-start" | "process-exit"; process: { name: string; pid: number; }; }
    | { id: number; at: number; type: "codex-start" | "codex-finish" | "codex-question"; codex: CodexTurn; };

/** Omit that keeps a union a union, so each event shape stays checkable on its own. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const rest = seconds % 60;
    return [hours && `${hours}h`, minutes && `${minutes}m`, (rest || (!hours && !minutes)) && `${rest}s`].filter(Boolean).join(" ");
}

export type RobloxLogLine =
    | { kind: "join"; jobId: string; placeId: string; }
    | { kind: "universe"; placeId: string; universeId: string; }
    | { kind: "leave"; };

/** The Roblox player log announces a join twice: once with the job, once with the universe id. */
export function parseRobloxLine(line: string): RobloxLogLine | null {
    const join = /! Joining game '([^']+)' place (\d+)/.exec(line);
    if (join) return { kind: "join", jobId: join[1], placeId: join[2] };
    const universe = /game_join_loadtime: placeid:(\d+).*?universeid:(\d+)/.exec(line);
    if (universe) return { kind: "universe", placeId: universe[1], universeId: universe[2] };
    if (/Client:Disconnect|Disconnected from server for reason|sendAnalyticsBeforeLeave/.test(line)) return { kind: "leave" };
    return null;
}

export type CodexLogLine =
    | { kind: "session"; sessionId: string; cwd: string; originator: string; subagent: boolean; }
    | { kind: "started"; turnId: string; startedAt: number; }
    | { kind: "finished"; turnId: string; message: string; }
    | { kind: "aborted"; turnId: string; durationMs: number; };

/** One line of a Codex rollout file. Anything that is not a session or turn boundary is ignored. */
export function parseCodexLine(line: string): CodexLogLine | null {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return null; }
    if (typeof entry !== "object" || entry === null) return null;
    const { type, payload } = entry as { type?: unknown; payload?: unknown; };
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    if (type === "session_meta") {
        return {
            kind: "session",
            sessionId: typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : "",
            cwd: typeof p.cwd === "string" ? p.cwd : "",
            originator: typeof p.originator === "string" ? p.originator : "",
            subagent: typeof p.source === "object" && p.source !== null && "subagent" in p.source,
        };
    }
    if (type !== "event_msg" || typeof p.turn_id !== "string") return null;
    if (p.type === "task_started") {
        const raw = typeof p.started_at === "number" ? p.started_at : Date.now();
        return { kind: "started", turnId: p.turn_id, startedAt: raw < 1e12 ? raw * 1000 : raw };
    }
    if (p.type === "task_complete") return { kind: "finished", turnId: p.turn_id, message: typeof p.last_agent_message === "string" ? p.last_agent_message : "" };
    if (p.type === "turn_aborted") return { kind: "aborted", turnId: p.turn_id, durationMs: typeof p.duration_ms === "number" ? p.duration_ms : 0 };
    return null;
}

/** The question Codex is waiting on, judged from how its closing message ends. Undefined when it just reported. */
export function extractQuestion(message: string): string | undefined {
    const lines = message.trim().split("\n").map(line => line.trim()).filter(Boolean).slice(-4);
    const asked = lines.find(line => /\?\s*$/.test(line.replace(/[*_`]+$/, "")) || /^(should i|do you want|would you like|want me to|which (one|of)|let me know)/i.test(line));
    return asked?.replace(/^[-*\d.)\s]+/, "").replace(/[*_`]+/g, "").slice(0, 500);
}

export function projectName(cwd: string): string {
    return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
}

/** `tasklist /FO CSV /NH` rows: "Image Name","PID","Session Name","Session#","Mem Usage". */
export function parseTasklist(csv: string): ProcessInfo[] {
    const processes: ProcessInfo[] = [];
    for (const line of csv.split(/\r?\n/)) {
        const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replaceAll("\"\"", "\""));
        if (cells.length < 5) continue;
        const pid = Number(cells[1]);
        if (!Number.isInteger(pid)) continue;
        processes.push({ name: cells[0], pid, memoryKb: Number(cells[4].replace(/[^\d]/g, "")) || 0 });
    }
    return processes;
}

/** `ps -eo pid=,rss=,comm=` rows. */
export function parsePs(text: string): ProcessInfo[] {
    const processes: ProcessInfo[] = [];
    for (const line of text.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match) processes.push({ pid: Number(match[1]), memoryKb: Number(match[2]), name: match[3].split("/").pop() || match[3] });
    }
    return processes;
}

export function processKey(name: string): string {
    return name.trim().toLowerCase();
}

/** Names that appeared or vanished between two scans, one entry per program name. */
export function diffProcesses(before: Map<string, number>, after: Map<string, number>): { started: { name: string; pid: number; }[]; exited: { name: string; pid: number; }[]; } {
    const started: { name: string; pid: number; }[] = [];
    const exited: { name: string; pid: number; }[] = [];
    for (const [name, pid] of after) if (!before.has(name)) started.push({ name, pid });
    for (const [name, pid] of before) if (!after.has(name)) exited.push({ name, pid });
    return { started, exited };
}
