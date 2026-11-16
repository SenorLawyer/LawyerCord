/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawnSync } from "node:child_process";

import { loadPluginModule } from "./testDiscordMcpHarness";

const LARGE = 300 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

interface NativeModule {
    initializeBridge(event: unknown): Promise<unknown>;
    configureMcpClients(event: unknown, clients: unknown): Promise<unknown>;
    refreshMcpClients(event: unknown): Promise<void>;
    takeRequests(event: unknown, waitMs?: number): Promise<Array<{ id: string; tool: string; }>>;
    writeResponse(event: unknown, response: unknown): Promise<void>;
    recordSentMessage(event: unknown, channelId: string, messageId: string): Promise<void>;
    readUploadFile(event: unknown, path: unknown, directories: unknown): Promise<{ name: string; data: Uint8Array; }>;
}

async function fixture(nodeVersion?: string | null) {
    const root = await realFsPromises.mkdtemp(join(tmpdir(), "discord-mcp-native-"));
    const dataDirectory = join(root, "data");
    const uploads = join(root, "uploads");
    const bridge = join(dataDirectory, "discord-mcp");
    const downloads = join(bridge, "downloads");
    const sourceDirectory = join(root, "source");
    await Promise.all([realFsPromises.mkdir(downloads, { recursive: true }), realFsPromises.mkdir(uploads), realFsPromises.mkdir(sourceDirectory)]);
    await realFsPromises.writeFile(join(sourceDirectory, "discord-mcp-server.mjs"), "// server");

    const log: string[] = [];
    const hooks = {
        failLedgerWrites: 0,
        afterFirstRequestsListing: undefined as (() => Promise<void>) | undefined,
        bigDownloads: false,
    };
    const fs = { ...realFs, watch: (...args: Parameters<typeof realFs.watch>) => { log.push("watch"); return realFs.watch(...args); } };
    const fsPromises = {
        ...realFsPromises,
        readdir: async (path: string, ...rest: unknown[]) => {
            const result = await (realFsPromises.readdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
            if (String(path).endsWith("requests")) {
                log.push("readdir:requests");
                const hook = hooks.afterFirstRequestsListing;
                hooks.afterFirstRequestsListing = undefined;
                await hook?.();
            }
            return result;
        },
        writeFile: async (path: string, ...rest: unknown[]) => {
            if (hooks.failLedgerWrites > 0 && String(path).includes("sent-messages.json")) { hooks.failLedgerWrites--; throw new Error("disk full"); }
            return (realFsPromises.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
        },
        stat: async (path: string) => {
            const info = await realFsPromises.stat(path);
            return hooks.bigDownloads && String(path).includes("downloads") ? Object.assign(info, { size: LARGE }) : info;
        },
    };

    const loaded = loadPluginModule("native", {
        "@main/utils/constants": { DATA_DIR: dataDirectory },
        child_process: await import("node:child_process"),
        crypto: await import("node:crypto"),
        fs,
        "fs/promises": fsPromises,
        os: { ...await import("node:os"), homedir: () => root, platform: () => "darwin" },
        path: await import("node:path"),
        util: nodeVersion === undefined ? await import("node:util") : {
            promisify: () => async () => {
                if (nodeVersion === null) throw new Error("node unavailable");
                return { stdout: nodeVersion };
            },
        },
    }, { __dirname: sourceDirectory }) as unknown as NativeModule;

    const secretOf = async () => JSON.parse(await realFsPromises.readFile(join(bridge, "config.json"), "utf8")).secret as string;
    const writeRequest = async (id: string, extra: Record<string, unknown> = {}) => {
        const request = { id, secret: await secretOf(), tool: "whoami", arguments: {}, createdAt: Date.now(), ...extra };
        await realFsPromises.writeFile(join(bridge, "requests", `${Date.now()}-${id}.json`), JSON.stringify(request));
    };
    return {
        native: loaded, root, dataDirectory, sourceDirectory, uploads, bridge, downloads, log, hooks, secretOf, writeRequest,
        cleanup: () => realFsPromises.rm(root, { recursive: true, force: true }),
    };
}

test("installed MCP clients replace obsolete Electron paths without losing other settings", async () => {
    const f = await fixture();
    try {
        await f.native.configureMcpClients(undefined, ["codex", "cursor"]);
        const codex = join(f.root, ".codex", "config.toml");
        const cursor = join(f.root, ".cursor", "mcp.json");
        const original = await realFsPromises.readFile(codex, "utf8");
        await realFsPromises.writeFile(codex, original.replace(/^command = .*$/m, 'command = "Discord.exe"') + '\n[mcp_servers.lawyercord-discord.env]\nELECTRON_RUN_AS_NODE = "1"\n\n[other]\nvalue = 42\n');
        const config = JSON.parse(await realFsPromises.readFile(cursor, "utf8"));
        config.mcpServers["lawyercord-discord"].command = "Discord.exe";
        config.mcpServers["lawyercord-discord"].env = { ELECTRON_RUN_AS_NODE: "1" };
        config.mcpServers["lawyercord-discord"].extra = "keep";
        await realFsPromises.writeFile(cursor, JSON.stringify(config));
        const claude = join(f.root, "Library", "Application Support", "Claude", "claude_desktop_config.json");
        await realFsPromises.mkdir(join(f.root, "Library", "Application Support", "Claude"), { recursive: true });
        await realFsPromises.writeFile(claude, "{");
        await assert.rejects(f.native.refreshMcpClients(undefined), /claudeDesktop/);
        const updated = await realFsPromises.readFile(codex, "utf8");
        assert.match(updated, /\[other\]\s*value = 42/);
        assert.doesNotMatch(updated, /Discord\.exe/);
        const json = JSON.parse(await realFsPromises.readFile(cursor, "utf8"));
        assert.equal(json.mcpServers["lawyercord-discord"].command, "node");
        assert.equal(json.mcpServers["lawyercord-discord"].extra, "keep");
        await realFsPromises.writeFile(claude, "{}");
        await f.native.refreshMcpClients(undefined);
        assert.equal(await realFsPromises.readFile(codex, "utf8"), updated);
    } finally { await f.cleanup(); }
});

for (const version of [null, "16.20.0"] as const) {
    test(`migration preserves the configuration when Node is ${version ?? "missing"}`, async () => {
        const f = await fixture(version);
        try {
            const path = join(f.root, ".cursor", "mcp.json");
            const original = JSON.stringify({ mcpServers: { "lawyercord-discord": { command: "Discord.exe", args: [join(f.bridge, "server.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
            await realFsPromises.mkdir(join(f.root, ".cursor"), { recursive: true });
            await realFsPromises.writeFile(path, original);
            await assert.rejects(f.native.refreshMcpClients(undefined), /Install Node.js 18 or newer/);
            assert.equal(await realFsPromises.readFile(path, "utf8"), original);
            await assert.rejects(f.native.configureMcpClients(undefined, ["cursor"]), /Install Node.js 18 or newer/);
            assert.equal(await realFsPromises.readFile(path, "utf8"), original);
        } finally { await f.cleanup(); }
    });
}

test("migration leaves an existing absolute Node command unchanged", async () => {
    const f = await fixture();
    try {
        const path = join(f.root, ".cursor", "mcp.json");
        const original = JSON.stringify({ mcpServers: { "lawyercord-discord": { command: join(f.root, "node.exe"), args: [join(f.bridge, "server.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
        await realFsPromises.mkdir(join(f.root, ".cursor"), { recursive: true });
        await realFsPromises.writeFile(path, original);
        await f.native.refreshMcpClients(undefined);
        assert.equal(await realFsPromises.readFile(path, "utf8"), original);
    } finally { await f.cleanup(); }
});

test("client setup launches the bundled bridge with Node", async () => {
    const f = await fixture();
    try {
        await realFsPromises.copyFile("tools/discord-mcp/server.mjs", join(f.sourceDirectory, "discord-mcp-server.mjs"));
        await f.native.configureMcpClients(undefined, ["cursor"]);
        const config = JSON.parse(await realFsPromises.readFile(join(f.root, ".cursor", "mcp.json"), "utf8"));
        const server = config.mcpServers["lawyercord-discord"];
        const result = spawnSync(server.command, server.args, {
            input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
            encoding: "utf8", timeout: 10_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const response = JSON.parse(result.stdout);
        assert.ok(response.result.tools.some((tool: { name: string; }) => tool.name === "discord_api_request"));
    } finally { await f.cleanup(); }
});

test("a new plugin process installs the updated bundled server without rotating its secret", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        const secret = await f.secretOf();
        await realFsPromises.writeFile(join(f.sourceDirectory, "discord-mcp-server.mjs"), "// updated server");
        const restarted = loadPluginModule("native", {
            "@main/utils/constants": { DATA_DIR: f.dataDirectory },
            child_process: await import("node:child_process"),
            crypto: await import("node:crypto"),
            fs: realFs,
            "fs/promises": realFsPromises,
            os: { ...await import("node:os"), homedir: () => f.root, platform: () => "darwin" },
            path: await import("node:path"),
            util: await import("node:util"),
        }, { __dirname: f.sourceDirectory }) as unknown as NativeModule;
        await restarted.initializeBridge(undefined);
        assert.equal(await realFsPromises.readFile(join(f.bridge, "server.mjs"), "utf8"), "// updated server");
        assert.equal(await f.secretOf(), secret);
    } finally { await f.cleanup(); }
});

test("a rejected ledger write does not poison later writes", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        const first = "100000000000000001";
        f.hooks.failLedgerWrites = 1;
        const failing = f.native.recordSentMessage(undefined, first, "500000000000000001");
        const queued = f.native.recordSentMessage(undefined, first, "500000000000000002");
        await assert.rejects(failing, /disk full/);
        await queued;
        const stored = JSON.parse(await realFsPromises.readFile(join(f.bridge, "sent-messages.json"), "utf8"));
        assert.deepEqual(stored, [`${first}:500000000000000001`, `${first}:500000000000000002`]);
        await f.native.recordSentMessage(undefined, first, "500000000000000003");
        await assert.rejects(f.native.recordSentMessage(undefined, "nope", "1"), /Invalid message identity/);
    } finally { await f.cleanup(); }
});

test("takeRequests starts watching before its first scan so a request in between wakes it", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        f.log.length = 0;
        f.hooks.afterFirstRequestsListing = () => f.writeRequest("raced-request-1");
        const started = Date.now();
        const requests = await f.native.takeRequests(undefined, 20_000);
        assert.deepEqual(requests.map(request => request.id), ["raced-request-1"]);
        assert.ok(Date.now() - started < 5_000, "the watcher woke the long poll instead of waiting out the timeout");
        assert.deepEqual(f.log.slice(0, 2), ["watch", "readdir:requests"]);
        assert.deepEqual(await realFsPromises.readdir(join(f.bridge, "requests")), [], "claimed requests are removed");
    } finally { await f.cleanup(); }
});

test("takeRequests returns promptly when work is already waiting and times out otherwise", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        await f.writeRequest("waiting-request-1");
        assert.equal((await f.native.takeRequests(undefined, 10_000)).length, 1);
        const started = Date.now();
        assert.deepEqual(await f.native.takeRequests(undefined, 150), []);
        assert.ok(Date.now() - started >= 100);
        assert.deepEqual(await f.native.takeRequests(undefined, 0), []);
    } finally { await f.cleanup(); }
});

test("authenticated requests for unknown tools or with stale timestamps get an error response", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        await f.writeRequest("unknown-tool-1", { tool: "arbitrary_request" });
        await f.writeRequest("stale-request-1", { createdAt: Date.now() - 3_600_000 });
        await f.writeRequest("bad-secret-001", { secret: "wrong" });
        assert.deepEqual(await f.native.takeRequests(undefined, 0), []);
        const unknown = JSON.parse(await realFsPromises.readFile(join(f.bridge, "responses", "unknown-tool-1.json"), "utf8"));
        assert.deepEqual([unknown.ok, unknown.error], [false, "Unsupported Discord MCP tool"]);
        const stale = JSON.parse(await realFsPromises.readFile(join(f.bridge, "responses", "stale-request-1.json"), "utf8"));
        assert.match(stale.error, /expired/);
        await assert.rejects(realFsPromises.readFile(join(f.bridge, "responses", "bad-secret-001.json")), /ENOENT/, "unauthenticated requests learn nothing");
    } finally { await f.cleanup(); }
});

test("downloads older than a day are swept on startup", async () => {
    const f = await fixture();
    try {
        const old = join(f.downloads, "old.bin");
        const fresh = join(f.downloads, "fresh.bin");
        await realFsPromises.writeFile(old, "old");
        await realFsPromises.writeFile(fresh, "fresh");
        const past = new Date(Date.now() - 2 * DAY);
        await realFsPromises.utimes(old, past, past);
        await f.native.initializeBridge(undefined);
        assert.deepEqual(await realFsPromises.readdir(f.downloads), ["fresh.bin"]);
    } finally { await f.cleanup(); }
});

test("the downloads folder is capped by total size, dropping the oldest files first", async () => {
    const f = await fixture();
    try {
        for (const [name, age] of [["a.bin", 3_000], ["b.bin", 2_000], ["c.bin", 1_000]] as const) {
            const path = join(f.downloads, name);
            await realFsPromises.writeFile(path, name);
            const time = new Date(Date.now() - age);
            await realFsPromises.utimes(path, time, time);
        }
        f.hooks.bigDownloads = true;
        await f.native.initializeBridge(undefined);
        assert.deepEqual(await realFsPromises.readdir(f.downloads), ["c.bin"], "only the newest file fits under the cap");
    } finally { await f.cleanup(); }
});

test("responses are validated and bounded before they reach the agent", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        await assert.rejects(f.native.writeResponse(undefined, { id: "../escape", ok: true }), /Invalid/);
        await assert.rejects(f.native.writeResponse(undefined, { id: "valid-id-001", ok: "yes" }), /Invalid/);
        await assert.rejects(f.native.writeResponse(undefined, null), /Invalid/);
        await assert.rejects(f.native.writeResponse(undefined, { id: "valid-id-002", ok: true, result: { blob: "x".repeat(4 * 1024 * 1024) } }), /too large/);
        await f.native.writeResponse(undefined, { id: "valid-id-003", ok: false, error: "e".repeat(5_000), extra: "dropped" });
        const written = JSON.parse(await realFsPromises.readFile(join(f.bridge, "responses", "valid-id-003.json"), "utf8"));
        assert.equal(written.error.length, 2_000);
        assert.equal("extra" in written, false);
        await f.native.writeResponse(undefined, { id: "valid-id-004", ok: true, result: { fine: 1 } });
        assert.deepEqual(JSON.parse(await realFsPromises.readFile(join(f.bridge, "responses", "valid-id-004.json"), "utf8")).result, { fine: 1 });
    } finally { await f.cleanup(); }
});

test("upload files must live in an allowed folder, never in LawyerCord's private data", async () => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        const file = join(f.uploads, "cat.png");
        await realFsPromises.writeFile(file, Buffer.from([1, 2, 3]));
        const loaded = await f.native.readUploadFile(undefined, file, [f.uploads]);
        assert.equal(loaded.name, "cat.png");
        assert.deepEqual([...loaded.data], [1, 2, 3]);

        await assert.rejects(f.native.readUploadFile(undefined, file, []), /outside the folders/);
        await assert.rejects(f.native.readUploadFile(undefined, file, [f.root.slice(0, 3)]), /outside the folders/, "a drive root is never an allowed folder");
        await assert.rejects(f.native.readUploadFile(undefined, "cat.png", [f.uploads]), /full paths/);
        await assert.rejects(f.native.readUploadFile(undefined, join(f.uploads, "missing.png"), [f.uploads]), /not found/);
        await assert.rejects(f.native.readUploadFile(undefined, f.uploads, [f.uploads]), /must be a file/);
        await assert.rejects(f.native.readUploadFile(undefined, 42, [f.uploads]), /full paths/);
        await assert.rejects(f.native.readUploadFile(undefined, file, "not a list"), /Invalid upload folder list/);
        await assert.rejects(f.native.readUploadFile(undefined, file, new Array(21).fill(f.uploads)), /Invalid upload folder list/);
        await assert.rejects(f.native.readUploadFile(undefined, file, [42, "relative/path", f.root + "-missing"]), /outside the folders/);

        await assert.rejects(f.native.readUploadFile(undefined, join(f.bridge, "config.json"), [f.bridge, f.root]), /private to LawyerCord/);
        await assert.rejects(f.native.readUploadFile(undefined, join(f.bridge, "sent-messages.json"), [f.root]), /private to LawyerCord|not found/);

        const downloaded = join(f.downloads, "attachment.txt");
        await realFsPromises.writeFile(downloaded, "hello");
        assert.equal((await f.native.readUploadFile(undefined, downloaded, [])).name, "attachment.txt", "previous downloads are always allowed");

        const huge = join(f.uploads, "huge.bin");
        await realFsPromises.writeFile(huge, Buffer.alloc(25 * 1024 * 1024 + 1));
        await assert.rejects(f.native.readUploadFile(undefined, huge, [f.uploads]), /25 MB/);
    } finally { await f.cleanup(); }
});

test("a symlink inside an allowed folder cannot reach files outside it", async t => {
    const f = await fixture();
    try {
        await f.native.initializeBridge(undefined);
        const secret = join(f.root, "outside.txt");
        await realFsPromises.writeFile(secret, "secret");
        const link = join(f.uploads, "link.txt");
        try { await realFsPromises.symlink(secret, link); }
        catch { t.skip("symlinks are not permitted here"); return; }
        await assert.rejects(f.native.readUploadFile(undefined, link, [f.uploads]), /outside the folders/);
    } finally { await f.cleanup(); }
});
