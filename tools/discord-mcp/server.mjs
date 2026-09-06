#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER_NAME = "discord-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30_000;

const snowflake = {
    type: "string",
    pattern: "^\\d{17,20}$",
    description: "Discord snowflake ID",
};

const channelId = { ...snowflake, description: "Any Discord channel ID visible to the authenticated account" };
const subscriptionId = {
    type: "string",
    pattern: "^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$",
    description: "Subscription ID returned by discord_subscribe_channel",
};
const messageLocationProperties = {
    channel_id: channelId,
    message_id: { ...snowflake, description: "Discord message ID" },
};

export const TOOLS = [
    {
        name: "discord_connection_status",
        description: "Check the local Discord bridge, authenticated account, all-channel access mode, and disabled capabilities.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "discord_list_servers",
        description: "List servers visible to the authenticated Discord account. This returns server metadata, never members or messages.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "discord_list_server_channels",
        description: "List cached visible channels in one server. This returns channel metadata, not message contents.",
        inputSchema: {
            type: "object",
            properties: { guild_id: { ...snowflake, description: "Discord server ID" } },
            required: ["guild_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_list_dms",
        description: "List DM and group-DM channel metadata visible to the authenticated Discord account. This does not read their messages.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "discord_read_messages",
        description: "Read up to 100 messages from any channel visible to the authenticated account, including image/audio/voice-message metadata and duration. Use discord_get_message or discord_download_attachment to generate a waveform when Discord omits it.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: channelId,
                limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
                before: { ...snowflake, description: "Return messages before this message ID" },
                after: { ...snowflake, description: "Return messages after this message ID" },
                around: { ...snowflake, description: "Return messages around this message ID" },
            },
            required: ["channel_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_bulk_read_messages",
        description: "Read recent messages from up to 10 channels visible to the authenticated account in one call. All channel IDs are validated before reading, and total requested messages are capped at 500.",
        inputSchema: {
            type: "object",
            properties: {
                channel_ids: {
                    type: "array",
                    items: channelId,
                    minItems: 1,
                    maxItems: 10,
                    uniqueItems: true,
                },
                limit_per_channel: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            },
            required: ["channel_ids"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_search_messages",
        description: "Headlessly search messages in one visible channel or across one visible server using Discord's authenticated search API. This does not open search UI, navigate Discord, or mark messages read.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: channelId,
                guild_id: { ...snowflake, description: "Visible server ID for a server-wide search; may accompany channel_id only when that channel belongs to this server" },
                query: { type: "string", minLength: 1, maxLength: 1024, description: "Text or phrase to find in message content" },
                author_id: { ...snowflake, description: "Only messages authored by this user" },
                mentions_user_id: { ...snowflake, description: "Only messages mentioning this user" },
                has: {
                    type: "array",
                    items: { type: "string", enum: ["link", "embed", "file", "video", "image", "sound", "sticker", "snapshot", "poll"] },
                    minItems: 1,
                    maxItems: 9,
                    uniqueItems: true,
                    description: "Discord media/content filters; multiple values are combined by Discord",
                },
                pinned: { type: "boolean", description: "Filter by pinned or unpinned state" },
                before_message_id: { ...snowflake, description: "Only hits older than this message snowflake" },
                after_message_id: { ...snowflake, description: "Only hits newer than this message snowflake" },
                sort_order: { type: "string", enum: ["desc", "asc"], default: "desc" },
                limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
                offset: { type: "integer", minimum: 0, maximum: 5000, default: 0, description: "Discord search result offset; use nextOffset from the prior response" },
            },
            anyOf: [{ required: ["channel_id"] }, { required: ["guild_id"] }],
            additionalProperties: false,
        },
    },
    {
        name: "discord_get_message",
        description: "Get one message from any channel visible to the authenticated account. If Discord omits a voice waveform, this tool downloads and decodes that voice attachment to generate one.",
        inputSchema: {
            type: "object",
            properties: messageLocationProperties,
            required: ["channel_id", "message_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_download_attachment",
        description: "Download one attachment from a message in any visible channel to a private local directory. Downloads are capped at 25 MB and return path, MIME type, size, and SHA-256.",
        inputSchema: {
            type: "object",
            properties: {
                ...messageLocationProperties,
                attachment_id: { ...snowflake, description: "Attachment ID reported by a message read tool" },
            },
            required: ["channel_id", "message_id", "attachment_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_send_message",
        description: "Send a plain-text message to any channel visible to the authenticated account. Mentions are deliberately disabled; an optional reply does not ping its author.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: channelId,
                content: { type: "string", minLength: 1, maxLength: 2000 },
                reply_to_message_id: { ...snowflake, description: "Optional message in the same channel to reply to without pinging" },
            },
            required: ["channel_id", "content"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_delete_own_message",
        description: "Delete a message only when the Discord MCP sent ledger proves this bridge sent it and Discord confirms the current account authored it.",
        inputSchema: {
            type: "object",
            properties: messageLocationProperties,
            required: ["channel_id", "message_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_subscribe_channel",
        description: "Silently subscribe to new MESSAGE_CREATE events in any visible channel. Existing messages are not returned.",
        inputSchema: {
            type: "object",
            properties: { channel_id: channelId },
            required: ["channel_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_wait_for_message",
        description: "Wait for the next new message on an active subscription without polling Discord or changing the active view. Returns on a message or timeout.",
        inputSchema: {
            type: "object",
            properties: {
                subscription_id: subscriptionId,
                timeout_seconds: { type: "integer", minimum: 1, maximum: 300, default: 60 },
            },
            required: ["subscription_id"],
            additionalProperties: false,
        },
    },
    {
        name: "discord_list_subscriptions",
        description: "List active channel subscriptions, buffered-message counts, and wait state.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "discord_unsubscribe_channel",
        description: "Remove an active channel subscription and cancel its current wait, if any.",
        inputSchema: {
            type: "object",
            properties: { subscription_id: subscriptionId },
            required: ["subscription_id"],
            additionalProperties: false,
        },
    },
];

const toolMap = new Map(TOOLS.map(tool => [tool.name, tool]));
function candidateBridgeDirectories() {
    const candidates = [];
    if (process.env.LAWYERCORD_DISCORD_MCP_DIR) candidates.push(process.env.LAWYERCORD_DISCORD_MCP_DIR);
    const appData = process.env.APPDATA;
    if (appData) {
        candidates.push(join(appData, "LawyerCord", "discord-mcp"));
        candidates.push(join(appData, "LawyerCord", "dev", "discord-mcp"));
        candidates.push(join(appData, "LawyerCordData", "discord-mcp"));
    }
    candidates.push(join(homedir(), ".lawyercord", "discord-mcp"));
    return [...new Set(candidates.map(candidate => dirname(join(candidate, "config.json"))))];
}

async function loadBridgeConfig() {
    const attempted = [];
    for (const directory of candidateBridgeDirectories()) {
        const configPath = join(directory, "config.json");
        attempted.push(configPath);
        try {
            const config = JSON.parse(await readFile(configPath, "utf8"));
            if (config?.schemaVersion === 1 && typeof config.secret === "string" && config.secret.length >= 32)
                return { directory, secret: config.secret };
        } catch { }
    }
    throw new Error(`Discord MCP bridge is not ready. Enable DiscordMCP in LawyerCord and keep Discord running. Checked: ${attempted.join(", ")}`);
}

async function writeAtomic(path, body) {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
}

export async function callBridge(tool, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const { directory, secret } = await loadBridgeConfig();
    const requestsDirectory = join(directory, "requests");
    const responsesDirectory = join(directory, "responses");
    await Promise.all([mkdir(requestsDirectory, { recursive: true }), mkdir(responsesDirectory, { recursive: true })]);

    const id = randomUUID();
    const requestPath = join(requestsDirectory, `${Date.now()}-${id}.json`);
    const responsePath = join(responsesDirectory, `${id}.json`);
    await writeAtomic(requestPath, JSON.stringify({ id, secret, tool, arguments: args, createdAt: Date.now() }));

    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline) {
            try {
                const response = JSON.parse(await readFile(responsePath, "utf8"));
                if (response?.id !== id) throw new Error("Discord MCP returned a mismatched response ID");
                if (!response.ok) throw new Error(response.error || "Discord MCP request failed");
                return response.result;
            } catch (error) {
                if (error?.code !== "ENOENT") throw error;
            }
            await sleep(40);
        }
        throw new Error("Discord MCP request timed out; make sure Discord is running and the DiscordMCP plugin is enabled");
    } finally {
        await Promise.all([
            rm(requestPath, { force: true }),
            rm(responsePath, { force: true }),
        ]);
    }
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, code, message) {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function toolContent(name, result) {
    const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
    if (name !== "discord_download_attachment") return content;

    const path = result?.download?.path;
    const reportedType = result?.download?.contentType;
    if (typeof path !== "string" || typeof reportedType !== "string") return content;

    const isVoiceMessage = typeof result?.attachment?.durationSeconds === "number" &&
        typeof result?.attachment?.waveform === "string";
    if (!reportedType.startsWith("image/") && !reportedType.startsWith("audio/") && !isVoiceMessage) {
        content.push({
            type: "resource_link",
            name: result?.attachment?.filename ?? "Discord attachment",
            uri: pathToFileURL(path).href,
            mimeType: reportedType,
            size: result?.download?.size,
        });
        return content;
    }

    const data = (await readFile(path)).toString("base64");
    if (reportedType.startsWith("image/")) {
        content.push({ type: "image", data, mimeType: reportedType });
    } else {
        const mimeType = isVoiceMessage && reportedType === "video/mp4" ? "audio/mp4" : reportedType;
        content.push({ type: "audio", data, mimeType });
    }
    return content;
}

function bridgeTimeoutForTool(name, args) {
    if (name !== "discord_wait_for_message") return DEFAULT_TIMEOUT_MS;
    const requestedSeconds = Number.isInteger(args?.timeout_seconds) ? args.timeout_seconds : 60;
    return Math.min(315_000, Math.max(11_000, requestedSeconds * 1_000 + 10_000));
}

async function handleRequest(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        rpcError(message?.id, -32600, "Invalid Request");
        return;
    }

    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;

    if (message.method === "initialize") {
        send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
                protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                instructions: "This silent background server can use every channel visible to the authenticated Discord account without navigating the active Discord view. It cannot change users, relationships, blocks, membership, roles, or moderation state, and it can delete only messages recorded as sent by this bridge.",
            },
        });
        return;
    }

    if (message.method === "ping") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
    }

    if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        return;
    }

    if (message.method === "tools/call") {
        const name = message.params?.name;
        const tool = toolMap.get(name);
        if (!tool) {
            rpcError(message.id, -32602, `Unknown tool: ${String(name)}`);
            return;
        }
        try {
            const args = message.params?.arguments ?? {};
            const result = await callBridge(name.slice("discord_".length), args, bridgeTimeoutForTool(name, args));
            send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    content: await toolContent(name, result),
                    structuredContent: result && typeof result === "object" ? result : { value: result },
                },
            });
        } catch (error) {
            send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    isError: true,
                    content: [{ type: "text", text: error instanceof Error ? error.message : "Discord MCP tool failed" }],
                },
            });
        }
        return;
    }

    rpcError(message.id, -32601, `Method not found: ${message.method}`);
}

export function startServer() {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", line => {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); }
        catch {
            rpcError(null, -32700, "Parse error");
            return;
        }
        void handleRequest(message).catch(error => {
            rpcError(message?.id, -32603, error instanceof Error ? error.message : "Internal error");
        });
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
