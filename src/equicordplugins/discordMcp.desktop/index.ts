/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { defineDefault, OptionType, PluginNative } from "@utils/types";
import { Button, Checkbox, React, showToast, Toasts, UserStore, useState } from "@webpack/common";

import {
    executeTool,
    handleMessageCreate,
    handleMessageDelete,
    handleMessageDeleteBulk,
    handleMessageUpdate,
    handleReactionAdd,
    handleReactionRemove,
    resetBridgeState,
} from "./handlers";
import { DISCORD_MCP_TOOL_NAMES, DiscordMcpToolName, McpSettings } from "./policy";

const MCP_CLIENTS = [
    ["codex", "Codex"],
    ["claudeDesktop", "Claude Desktop"],
    ["claudeCode", "Claude Code"],
    ["gemini", "Gemini CLI"],
    ["cursor", "Cursor"],
] as const;
const MCP_CLIENT_SETTINGS_KEYS = ["mcpClients"] as const;

type McpClient = typeof MCP_CLIENTS[number][0];
type McpClientSettings = Record<McpClient, boolean>;

const Native = VencordNative.pluginHelpers.DiscordMCP as PluginNative<typeof import("./native")>;
const logger = new Logger("DiscordMCP");
const LONG_POLL_MS = 10_000;

let bridgeGeneration = 0;
let requestGeneration = 0;

function McpClientSetup() {
    const { mcpClients } = settings.use(MCP_CLIENT_SETTINGS_KEYS);
    const [isInstalling, setIsInstalling] = useState(false);
    const selected = MCP_CLIENTS.filter(([client]) => mcpClients[client]).map(([client]) => client);

    return React.createElement(
        SettingsSection,
        {
            name: "Connect an AI app",
            id: "mcpClients",
            description: "Installs LawyerCord's bundled local MCP bridge for the selected apps. Restart each app after setup.",
        },
        ...MCP_CLIENTS.map(([client, label]) => React.createElement(
            Checkbox,
            {
                key: client,
                value: mcpClients[client],
                onChange: (_, value) => settings.store.mcpClients = { ...mcpClients, [client]: value },
            },
            React.createElement(BaseText, { size: "sm" }, label)
        )),
        React.createElement(
            Button,
            {
                disabled: isInstalling || selected.length === 0,
                onClick: async () => {
                    setIsInstalling(true);
                    try {
                        const results = await Native.configureMcpClients(selected);
                        showToast(`Connected LawyerCord to ${results.map(result => MCP_CLIENTS.find(([client]) => client === result.client)?.[1]).join(", ")}. Restart the selected apps.`, Toasts.Type.SUCCESS);
                    } catch (error) {
                        showToast(error instanceof Error ? error.message : "Could not configure the selected apps.", Toasts.Type.FAILURE);
                    } finally {
                        setIsInstalling(false);
                    }
                },
            },
            isInstalling ? "Connecting..." : "Connect selected apps"
        )
    );
}

const KEYS_LIMIT_MESSAGE = "Enter a whole number from 1 to 1000.";

function limitSetting(description: string, fallback: number) {
    return {
        type: OptionType.NUMBER,
        description,
        default: fallback,
        isValid: (value: number) => (Number.isInteger(value) && value >= 1 && value <= 1_000) || KEYS_LIMIT_MESSAGE,
    } as const;
}

const settings = definePluginSettings({
    mcpClients: {
        type: OptionType.COMPONENT,
        component: ErrorBoundary.wrap(McpClientSetup, { noop: true }),
        default: defineDefault<McpClientSettings>({
            codex: true,
            claudeDesktop: false,
            claudeCode: false,
            gemini: false,
            cursor: false,
        }),
    },
    allowRelationshipActions: {
        type: OptionType.BOOLEAN,
        description: "Allow relationship actions. Lets the agent handle friend requests and blocking.",
        default: false,
    },
    allowMembershipActions: {
        type: OptionType.BOOLEAN,
        description: "Allow membership actions. Lets the agent handle joining servers, leaving servers and changing nicknames.",
        default: false,
    },
    allowAccountActions: {
        type: OptionType.BOOLEAN,
        description: "Allow account actions. Lets the agent handle changing your status and custom status.",
        default: false,
    },
    allowModerationActions: {
        type: OptionType.BOOLEAN,
        description: "Allow moderation actions. Lets the agent handle kicking, banning and timing out members and deleting other people's messages.",
        default: false,
    },
    allowRoleActions: {
        type: OptionType.BOOLEAN,
        description: "Allow role actions. Lets the agent handle adding and removing member roles.",
        default: false,
    },
    allowChannelManagement: {
        type: OptionType.BOOLEAN,
        description: "Allow channel management. Lets the agent handle creating, editing and deleting channels.",
        default: false,
    },
    channelBurstLimit: limitSetting("Most write actions the agent may take in one channel every 10 seconds.", 5),
    channelHourlyLimit: limitSetting("Most write actions the agent may take in one channel every hour.", 60),
    globalBurstLimit: limitSetting("Most write actions the agent may take across all channels every 10 seconds.", 10),
    globalHourlyLimit: limitSetting("Most write actions the agent may take across all channels every hour.", 120),
    uploadDirectories: {
        type: OptionType.STRING,
        description: "Folders the agent may send files from, one full path per line. Files it downloaded from Discord are always allowed.",
        default: "",
        multiline: true,
    },
});

function currentSettings(): McpSettings {
    const { store } = settings;
    return {
        allowRelationshipActions: store.allowRelationshipActions,
        allowMembershipActions: store.allowMembershipActions,
        allowAccountActions: store.allowAccountActions,
        allowModerationActions: store.allowModerationActions,
        allowRoleActions: store.allowRoleActions,
        allowChannelManagement: store.allowChannelManagement,
        channelBurstLimit: store.channelBurstLimit,
        channelHourlyLimit: store.channelHourlyLimit,
        globalBurstLimit: store.globalBurstLimit,
        globalHourlyLimit: store.globalHourlyLimit,
        uploadDirectories: store.uploadDirectories,
    };
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number")
        return `Discord request failed with HTTP ${error.status}`;
    if (typeof error === "string") return error;
    return "Discord MCP request failed";
}

const MAX_RESULT_CHARACTERS = 2_000_000;
const STOPPED_MESSAGE = "The DiscordMCP plugin was stopped or restarted before this request ran. Try the request again.";

type BridgeRequest = Awaited<ReturnType<typeof Native.takeRequests>>[number];

async function handleBridgeRequest(request: BridgeRequest): Promise<void> {
    try {
        if (!DISCORD_MCP_TOOL_NAMES.includes(request.tool as DiscordMcpToolName))
            throw new Error("Unsupported Discord MCP tool");
        const generation = requestGeneration;
        const accountId = UserStore.getCurrentUser()?.id;
        const check = () => {
            if (generation !== requestGeneration || accountId !== UserStore.getCurrentUser()?.id)
                throw new Error("Discord MCP request was cancelled because the session changed.");
        };
        const result = await executeTool(request.tool as DiscordMcpToolName, request.arguments, { check, settings: currentSettings(), native: Native });
        check();
        if (JSON.stringify(result).length > MAX_RESULT_CHARACTERS)
            throw new Error("The result is too large to return. Ask for fewer items with a smaller limit.");
        await Native.writeResponse({ id: request.id, ok: true, result });
    } catch (error) {
        await Native.writeResponse({ id: request.id, ok: false, error: errorMessage(error) });
    }
}

async function bridgeLoop(generation: number): Promise<void> {
    while (generation === bridgeGeneration) {
        let requests: BridgeRequest[];
        try {
            requests = await Native.takeRequests(LONG_POLL_MS);
        } catch (error) {
            if (generation !== bridgeGeneration) return;
            logger.error("Bridge wait failed", error);
            await new Promise(resolve => setTimeout(resolve, 1_000));
            continue;
        }

        const stopped = generation !== bridgeGeneration;
        for (const request of requests) {
            const work = stopped
                ? Native.writeResponse({ id: request.id, ok: false, error: STOPPED_MESSAGE })
                : handleBridgeRequest(request);
            void work.catch(error => logger.error("Bridge response failed", error));
        }
        if (stopped) return;
    }
}

export default definePlugin({
    name: "DiscordMCP",
    performance: {
        impact: "medium",
        description: "Waits for local agent requests and tracks subscribed channel messages while enabled."
    },
    description: "A local MCP bridge that lets an AI agent read and, within your limits, act on every channel visible to this authenticated Discord client.",
    authors: [EquicordDevs.nobody],
    settings,

    flux: {
        LOGOUT() { requestGeneration++; resetBridgeState(); },
        CONNECTION_OPEN() { requestGeneration++; resetBridgeState(); },
        MESSAGE_CREATE: handleMessageCreate,
        MESSAGE_UPDATE: handleMessageUpdate,
        MESSAGE_DELETE: handleMessageDelete,
        MESSAGE_DELETE_BULK: handleMessageDeleteBulk,
        MESSAGE_REACTION_ADD: handleReactionAdd,
        MESSAGE_REACTION_REMOVE: handleReactionRemove,
    },

    async start() {
        const generation = ++bridgeGeneration;
        await Native.initializeBridge();
        if (generation !== bridgeGeneration) return;
        void bridgeLoop(generation);
    },

    stop() {
        bridgeGeneration++;
        requestGeneration++;
        resetBridgeState();
    },
});
