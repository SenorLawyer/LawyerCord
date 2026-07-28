import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import puppeteer from "puppeteer-core";

const DEBUG_URL = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";
const LIVE_CONFIRMATION = "VERIFY_AUTHORIZED_DISCORD_TARGET";
const SNOWFLAKE = /^\d{17,20}$/u;

if (process.env.LAWYERCORD_RUN_LIVE_DISCORD_MCP_READONLY !== LIVE_CONFIRMATION) {
    throw new Error(
        `Live Discord access is disabled. Set LAWYERCORD_RUN_LIVE_DISCORD_MCP_READONLY=${LIVE_CONFIRMATION} ` +
        "only with a disposable, reviewed LawyerCord build."
    );
}

function requireTarget(name: string): string {
    const value = process.env[name];
    if (!value || !SNOWFLAKE.test(value)) throw new Error(`${name} must be an authorized Discord snowflake ID`);
    return value;
}

const TARGET_USER_ID = requireTarget("LAWYERCORD_MCP_TEST_USER_ID");
const TARGET_GUILD_ID = requireTarget("LAWYERCORD_MCP_TEST_GUILD_ID");
const TARGET_CHANNEL_ID = requireTarget("LAWYERCORD_MCP_TEST_CHANNEL_ID");

interface RpcWaiter {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

interface LiveDiscordPlugin {
    started: boolean;
}

interface LiveDiscordSettings {
    enabled?: boolean;
    authorizedUserId?: string;
    allowedGuildIds?: string;
    allowedChannelIds?: string;
    allowWrites?: boolean;
}

interface LawyerCordLiveWindow {
    Vencord?: {
        Plugins: {
            plugins: Record<string, LiveDiscordPlugin | undefined>;
            startPlugin(plugin: LiveDiscordPlugin): Promise<void>;
        };
        Settings: {
            plugins: Record<string, LiveDiscordSettings | undefined>;
        };
        Webpack: {
            Common: {
                UserStore: {
                    getCurrentUser(): { id: string; } | undefined;
                };
            };
        };
    };
    VencordNative?: {
        pluginHelpers: {
            DiscordMCP?: {
                initializeBridge(): Promise<{ queueDirectory: string; }>;
            };
        };
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${label} returned an invalid object`);
    return value;
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
    if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${label} returned an invalid list`);
    return value;
}

async function main() {
    const browser = await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
    let mcp: ChildProcessWithoutNullStreams | undefined;

    try {
        const pages = await browser.pages();
        const page = pages.find(candidate => candidate.url().includes("discord.com/channels")) ?? pages[0];
        await page.waitForFunction(() => {
            const liveWindow = globalThis as typeof globalThis & LawyerCordLiveWindow;
            return Boolean(liveWindow.Vencord?.Plugins.plugins);
        }, { timeout: 30_000 });

        const pluginState = await page.evaluate(async targetUserId => {
            const liveWindow = globalThis as typeof globalThis & LawyerCordLiveWindow;
            const vencord = liveWindow.Vencord;
            if (!vencord) throw new Error("LawyerCord is unavailable in the Discord renderer");
            const plugin = vencord.Plugins.plugins.DiscordMCP;
            if (!plugin) throw new Error("DiscordMCP plugin is missing from the built client");

            const currentUserId = vencord.Webpack.Common.UserStore.getCurrentUser()?.id;
            if (currentUserId !== targetUserId)
                throw new Error(`Expected Discord account ${targetUserId}, received ${String(currentUserId)}`);

            const pluginSettings = vencord.Settings.plugins.DiscordMCP ??= { enabled: true };
            delete pluginSettings.authorizedUserId;
            delete pluginSettings.allowedGuildIds;
            delete pluginSettings.allowedChannelIds;
            delete pluginSettings.allowWrites;
            pluginSettings.enabled = true;
            if (!plugin.started) await vencord.Plugins.startPlugin(plugin);

            const nativeBridge = liveWindow.VencordNative?.pluginHelpers.DiscordMCP;
            if (!nativeBridge) throw new Error("DiscordMCP native bridge is unavailable");
            const bridge = await nativeBridge.initializeBridge();
            return { queueDirectory: bridge.queueDirectory };
        }, TARGET_USER_ID);

        mcp = spawn(process.execPath, [resolve("tools/discord-mcp/server.mjs")], {
            cwd: resolve("."),
            env: { ...process.env, LAWYERCORD_DISCORD_MCP_DIR: pluginState.queueDirectory },
            stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;

        const pending = new Map<number, RpcWaiter>();
        let rpcId = 1;
        let stderr = "";
        mcp.stderr.on("data", data => { stderr += data.toString(); });
        createInterface({ input: mcp.stdout, crlfDelay: Infinity }).on("line", line => {
            const parsed: unknown = JSON.parse(line);
            if (!isRecord(parsed) || typeof parsed.id !== "number") return;
            const waiter = pending.get(parsed.id);
            if (!waiter) return;
            pending.delete(parsed.id);
            if (isRecord(parsed.error))
                waiter.reject(new Error(typeof parsed.error.message === "string" ? parsed.error.message : "MCP request failed"));
            else waiter.resolve(parsed.result);
        });

        const rpc = (method: string, params?: unknown): Promise<unknown> => {
            const id = rpcId++;
            const result = new Promise<unknown>((resolvePromise, rejectPromise) => {
                pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
            });
            mcp!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
            return result;
        };
        const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
            const result = requireRecord(await rpc("tools/call", { name, arguments: args }), name);
            if (result.isError === true) {
                const firstContent = Array.isArray(result.content) && isRecord(result.content[0]) ? result.content[0] : undefined;
                throw new Error(typeof firstContent?.text === "string" ? firstContent.text : `${name} failed`);
            }
            return result.structuredContent;
        };

        await rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "LawyerCord read-only live test", version: "1" },
        });

        const status = requireRecord(await callTool("discord_connection_status"), "discord_connection_status");
        const currentUser = requireRecord(status.currentUser, "discord_connection_status.currentUser");
        const capabilities = requireRecord(status.capabilities, "discord_connection_status.capabilities");
        assert.equal(currentUser.id, TARGET_USER_ID);
        assert.equal(status.channelAccess, "all_accessible_channels");
        assert.equal(capabilities.allAccessibleChannels, true);

        const servers = requireRecordArray(await callTool("discord_list_servers"), "discord_list_servers");
        assert.ok(servers.some(server => server.id === TARGET_GUILD_ID), "target guild is visible");

        const channels = requireRecordArray(
            await callTool("discord_list_server_channels", { guild_id: TARGET_GUILD_ID }),
            "discord_list_server_channels"
        );
        assert.ok(channels.some(channel => channel.id === TARGET_CHANNEL_ID), "target channel is visible");

        const messages = await callTool("discord_read_messages", { channel_id: TARGET_CHANNEL_ID, limit: 5 });
        assert.ok(Array.isArray(messages), "target channel returned a message array");

        console.log(JSON.stringify({
            accountId: currentUser.id,
            allAccessibleChannels: capabilities.allAccessibleChannels,
            guildCount: servers.length,
            channelCount: channels.length,
            sampledMessageCount: messages.length,
            targetGuildVisible: true,
            targetChannelVisible: true,
        }, null, 2));

        if (stderr) throw new Error(stderr);
    } finally {
        mcp?.kill();
        await browser.disconnect();
    }
}

void main();
