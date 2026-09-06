import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
    canDeleteRecordedMessage,
    DISCORD_MCP_TOOL_NAMES,
    isDiscordSnowflake,
    normalizeMessageContent,
    normalizeMessageLimit,
    normalizeSearchHas,
    normalizeSearchOffset,
    normalizeSearchQuery,
    normalizeSearchSortOrder,
    requireSnowflake,
    sentMessageKey,
} from "../src/equicordplugins/discordMcp.desktop/policy";

assert.equal(isDiscordSnowflake("895063026686885909"), true);
assert.equal(isDiscordSnowflake("invalid"), false);
assert.equal(requireSnowflake("895063026686885909", "channel_id"), "895063026686885909");
assert.throws(() => requireSnowflake("invalid", "channel_id"), /snowflake/);
assert.equal(normalizeMessageLimit(undefined), 50);
assert.equal(normalizeMessageLimit(100), 100);
assert.throws(() => normalizeMessageLimit(101), /1 to 100/);
assert.equal(normalizeMessageContent("hello"), "hello");
assert.throws(() => normalizeMessageContent("  "), /non-empty/);
assert.throws(() => normalizeMessageContent("x".repeat(2001)), /2,000/);
assert.equal(normalizeSearchQuery("  release notes  "), "release notes");
assert.equal(normalizeSearchQuery(undefined), undefined);
assert.throws(() => normalizeSearchQuery(" "), /non-empty/);
assert.throws(() => normalizeSearchQuery("x".repeat(1025)), /1,024/);
assert.equal(normalizeSearchOffset(undefined), 0);
assert.equal(normalizeSearchOffset(5_000), 5_000);
assert.throws(() => normalizeSearchOffset(5_001), /0 to 5,000/);
assert.deepEqual(normalizeSearchHas(["image", "file", "image"]), ["image", "file"]);
assert.throws(() => normalizeSearchHas(["anything"]), /unsupported/);
assert.equal(normalizeSearchSortOrder(undefined), "desc");
assert.equal(normalizeSearchSortOrder("asc"), "asc");
assert.throws(() => normalizeSearchSortOrder("relevance"), /asc or desc/);

const sent = new Set([sentMessageKey("895063026686885909", "123456789012345678")]);
assert.equal(canDeleteRecordedMessage(sent, "895063026686885909", "123456789012345678"), true);
assert.equal(canDeleteRecordedMessage(sent, "895063026686885909", "999999999999999999"), false, "unrecorded messages cannot be deleted");

async function main() {
const bridgeDirectory = await mkdtemp(join(tmpdir(), "discord-mcp-test-"));
const requestsDirectory = join(bridgeDirectory, "requests");
const responsesDirectory = join(bridgeDirectory, "responses");
const fakeImagePath = join(bridgeDirectory, "test-image.png");
const fakeImage = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const secret = randomBytes(32).toString("base64url");
await Promise.all([mkdir(requestsDirectory), mkdir(responsesDirectory)]);
await writeFile(join(bridgeDirectory, "config.json"), JSON.stringify({ schemaVersion: 1, secret }));
await writeFile(fakeImagePath, fakeImage);

const child = spawn(process.execPath, [resolve("tools/discord-mcp/server.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, LAWYERCORD_DISCORD_MCP_DIR: bridgeDirectory },
    stdio: ["pipe", "pipe", "pipe"],
}) as ChildProcessWithoutNullStreams;

let nextRpcId = 1;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; }>();
const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
stdout.on("line", line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
});

function rpc(method: string, params?: unknown): Promise<any> {
    const id = nextRpcId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolvePromise, rejectPromise) => {
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
}

let workerRunning = true;
const observedRequests: any[] = [];
const fakeWorker = (async () => {
    while (workerRunning) {
        for (const name of await readdir(requestsDirectory)) {
            if (!name.endsWith(".json")) continue;
            const path = join(requestsDirectory, name);
            const claimed = `${path}.claimed`;
            try {
                await rename(path, claimed);
                const request = JSON.parse(await readFile(claimed, "utf8"));
                observedRequests.push(request);
                assert.equal(request.secret, secret, "queue requests authenticate with the private bridge secret");
                const result = request.tool === "connection_status"
                    ? { connected: true, channelAccess: "all_accessible_channels" }
                    : request.tool === "download_attachment"
                        ? {
                            attachment: { filename: "test-image.png", contentType: "image/png" },
                            download: { path: fakeImagePath, contentType: "image/png", size: fakeImage.byteLength },
                        }
                        : { echoedTool: request.tool };
                const response = {
                    id: request.id,
                    ok: true,
                    result,
                };
                await writeFile(join(responsesDirectory, `${request.id}.json`), JSON.stringify(response));
            } catch (error: any) {
                if (error?.code !== "ENOENT") throw error;
            } finally {
                await rm(claimed, { force: true });
            }
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
})();

try {
    const fallbackDirectory = join(bridgeDirectory, "LawyerCord", "discord-mcp");
    await mkdir(fallbackDirectory, { recursive: true });
    await writeFile(join(fallbackDirectory, "config.json"), JSON.stringify({ schemaVersion: 1, secret }));
    const isolated = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { callBridge } from "./tools/discord-mcp/server.mjs";
        await assert.rejects(callBridge("connection_status", {}, 1), /bridge is not ready/);
    `], {
        env: { ...process.env, APPDATA: bridgeDirectory, LAWYERCORD_DISCORD_MCP_DIR: join(bridgeDirectory, "missing") },
        encoding: "utf8",
        timeout: 5_000,
    });
    assert.equal(isolated.status, 0, isolated.stderr || isolated.error?.message);
    assert.deepEqual(await readdir(fallbackDirectory), ["config.json"], "an explicit bridge never falls back to another installation");

    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialized.serverInfo.name, "discord-mcp");

    const listed = await rpc("tools/list");
    const names = listed.tools.map((tool: any) => tool.name);
    assert.deepEqual(names, DISCORD_MCP_TOOL_NAMES.map(name => `discord_${name}`), "all fixed Discord tools are advertised");
    assert.equal(names.some((name: string) => /member|friend|relationship|block|role|moder|request|rest/i.test(name)), false, "no user-management, moderation, or arbitrary request tool exists");
    for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown arguments`);
    const searchTool = listed.tools.find((tool: any) => tool.name === "discord_search_messages");
    assert.ok(searchTool, "headless message search is exposed");
    assert.deepEqual(searchTool.inputSchema.anyOf, [{ required: ["channel_id"] }, { required: ["guild_id"] }]);

    const status = await rpc("tools/call", { name: "discord_connection_status", arguments: {} });
    assert.equal(status.structuredContent.connected, true);
    assert.equal(status.structuredContent.channelAccess, "all_accessible_channels");
    assert.equal(observedRequests[0].tool, "connection_status", "public tool names map to the fixed bridge operation");

    const imageDownload = await rpc("tools/call", {
        name: "discord_download_attachment",
        arguments: {
            channel_id: "895063026686885909",
            message_id: "123456789012345678",
            attachment_id: "234567890123456789",
        },
    });
    const imageBlock = imageDownload.content.find((block: any) => block.type === "image");
    assert.ok(imageBlock, "image downloads are delivered as native MCP image content");
    assert.equal(imageBlock.mimeType, "image/png");
    assert.equal(Buffer.from(imageBlock.data, "base64").byteLength, fakeImage.byteLength);

    const unknown = await rpc("tools/call", { name: "discord_arbitrary_request", arguments: {} }).then(
        () => null,
        error => error
    );
    assert.match(unknown.message, /Unknown tool/);
} finally {
    workerRunning = false;
    child.kill();
    await fakeWorker;
    await rm(bridgeDirectory, { force: true, recursive: true });
}

console.log("discord-mcp policy and protocol checks passed");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
