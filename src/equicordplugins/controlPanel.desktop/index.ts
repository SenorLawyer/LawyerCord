/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { isPluginEnabled, plugins } from "@api/PluginManager";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { Channel, Guild, Message, MessageJSON, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import {
    ChannelStore,
    Constants,
    GuildChannelStore,
    GuildMemberCountStore,
    GuildStore,
    RelationshipStore,
    RestAPI,
    UserStore,
} from "@webpack/common";

import { PluginMeta } from "~plugins";

import { SOURCE_PRIVACY_INVENTORY } from "./privacyInventory";
import type {
    ControlPanelChannel,
    ControlPanelGuild,
    ControlPanelPlugin,
    ControlPanelSnapshot,
    DiscordMessageCreateEvent,
    IndexedDiscordMessage,
    PrivacyInventoryEntry,
} from "./types";

const Native = VencordNative.pluginHelpers.ControlPanel as PluginNative<typeof import("./native")>;
const logger = new Logger("ControlPanel");
const REFRESH_INTERVAL_MS = 15_000;
const APPROVAL_REFRESH_MS = 5_000;
const backfilledChannels = new Set<string>();
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let approvalTimer: ReturnType<typeof setInterval> | null = null;
let approvedChannelIds = new Set<string>();

function channelName(channel: Channel | undefined): string {
    if (channel?.name) return channel.name;
    const recipients = (channel?.recipients ?? [])
        .map((userId: string) => UserStore.getUser(userId)?.globalName ?? UserStore.getUser(userId)?.username)
        .filter(Boolean);
    return recipients.join(", ") || "Direct message";
}

function guildIconUrl(guild: Guild): string | null {
    if (!guild?.icon) return null;
    return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=128`;
}

function userAvatarUrl(user: User): string | null {
    if (!user?.id || !user.avatar) return null;
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=128`;
}

function allGuildChannels(guildId: string): Channel[] {
    const groups = GuildChannelStore.getChannels(guildId);
    const channels = new Map<string, Channel>();
    for (const entry of [
        ...(groups?.SELECTABLE ?? []),
        ...(groups?.VOCAL ?? []),
        ...(groups?.[ChannelType.GUILD_CATEGORY] ?? []),
    ]) {
        const channel = "channel" in entry ? entry.channel : entry;
        if (channel?.id) channels.set(channel.id, channel);
    }
    return [...channels.values()];
}

function collectGuilds(): ControlPanelGuild[] {
    return Object.values(GuildStore.getGuilds()).map(guild => {
        const guildChannels = allGuildChannels(guild.id);
        return {
            id: guild.id,
            name: guild.name,
            iconUrl: guildIconUrl(guild),
            memberCount: GuildMemberCountStore.getMemberCount(guild.id) ?? 0,
            channelCount: guildChannels.length,
        };
    }).sort((left, right) => left.name.localeCompare(right.name));
}

function collectChannels(guilds: ControlPanelGuild[]): ControlPanelChannel[] {
    const guildNames = new Map(guilds.map(guild => [guild.id, guild.name]));
    const values: ControlPanelChannel[] = [];
    for (const guild of guilds) {
        for (const channel of allGuildChannels(guild.id)) {
            values.push({
                id: channel.id,
                guildId: guild.id,
                name: channelName(channel),
                type: Number(channel.type),
                guildName: guild.name,
            });
        }
    }
    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        values.push({
            id: channel.id,
            guildId: null,
            name: channelName(channel),
            type: Number(channel.type),
            guildName: null,
        });
    }
    return values.sort((left, right) =>
        (left.guildName ?? "").localeCompare(right.guildName ?? "") ||
        left.name.localeCompare(right.name)
    );
}

function collectPlugins(): ControlPanelPlugin[] {
    return Object.values(plugins).map(plugin => ({
        name: plugin.name,
        description: plugin.description,
        enabled: isPluginEnabled(plugin.name),
        required: Boolean(plugin.required),
        dependencies: [...(plugin.dependencies ?? [])],
        settingsCount: Object.keys(plugin.settings?.def ?? {}).length,
    })).sort((left, right) => left.name.localeCompare(right.name));
}

function collectPrivacyInventory(pluginValues: ControlPanelPlugin[]): PrivacyInventoryEntry[] {
    return pluginValues.map(plugin => {
        const source = SOURCE_PRIVACY_INVENTORY[PluginMeta[plugin.name]?.folderName] ?? {
            externalDomains: [],
            storage: [],
            permissions: [],
        };
        const permissions = new Set<string>(source.permissions);
        const storage = new Set<string>(source.storage);
        if (plugin.settingsCount) storage.add("LawyerCord plugin settings");
        if (plugin.dependencies.some(value => /commands/i.test(value))) permissions.add("Register local Discord commands");
        if (plugin.dependencies.some(value => /message/i.test(value))) permissions.add("Read or decorate Discord messages");
        if (plugin.dependencies.some(value => /contextmenu/i.test(value))) permissions.add("Modify Discord context menus");
        if (plugin.name === "DiscordMCP") {
            permissions.add("Read every visible Discord channel");
            permissions.add("Send messages on the authenticated account");
            permissions.add("Download Discord attachments");
            storage.add("Private local MCP queue and sent-message ledger");
        }
        if (plugin.name === "SecureMessaging") {
            permissions.add("Intercept protected DM sends and renders");
            permissions.add("Use OS screen-capture protection");
            storage.add("OS-encrypted identity and conversation vault");
        }
        if (plugin.name === "ControlPanel") {
            permissions.add("Observe Discord account metadata and approved-channel messages");
            permissions.add("Serve a token-protected loopback dashboard");
            storage.add("OS-encrypted semantic index and evidence exports");
        }
        if (/transcrib/i.test(plugin.name)) permissions.add("Process voice-message audio locally");
        if (/rpc|spotify|lastfm|youtube|tidal|applemusic/i.test(plugin.name)) permissions.add("May contact an external media or presence service");
        return {
            name: plugin.name,
            externalDomains: source.externalDomains,
            storage: [...storage],
            permissions: [...permissions],
        };
    });
}

function collectSnapshot(): ControlPanelSnapshot {
    const user = UserStore.getCurrentUser();
    const guilds = collectGuilds();
    const channels = collectChannels(guilds);
    const pluginValues = collectPlugins();
    const secureEnabled = isPluginEnabled("SecureMessaging");
    return {
        capturedAt: new Date().toISOString(),
        user: user ? {
            id: user.id,
            username: user.username,
            displayName: user.globalName ?? user.username,
            avatarUrl: userAvatarUrl(user),
        } : null,
        guilds,
        channels,
        directMessageCount: channels.filter(channel => channel.guildId === null).length,
        friendCount: RelationshipStore.getFriendIDs?.().length ?? 0,
        blockedCount: RelationshipStore.getBlockedIDs?.().length ?? 0,
        plugins: pluginValues,
        secureMessaging: {
            enabled: secureEnabled,
            protocol: "PCEM1 legacy HPKE envelope",
            deviceVerification: true,
            forwardSecrecy: false,
            migrationStatus: "Audited Signal/MLS provider required before protocol v2 can be enabled",
        },
    };
}

function isDiscordMessage(value: unknown): value is Message | MessageJSON {
    if (!value || typeof value !== "object") return false;
    return "id" in value &&
        typeof value.id === "string" &&
        "channel_id" in value &&
        typeof value.channel_id === "string" &&
        "author" in value &&
        Boolean(value.author) &&
        typeof value.author === "object" &&
        "content" in value &&
        typeof value.content === "string";
}

function serializeMessage(message: Message | MessageJSON): IndexedDiscordMessage | null {
    const channelId = message.channel_id;
    const { id } = message;
    if (!/^\d{17,20}$/u.test(channelId) || !/^\d{17,20}$/u.test(id)) return null;
    const channel = ChannelStore.getChannel(channelId);
    const rawGuildId = "guild_id" in message ? message.guild_id : undefined;
    const guildId = rawGuildId ?? channel?.guild_id ?? null;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const { author } = message;
    const timestamp = message.timestamp instanceof Date
        ? message.timestamp.toISOString()
        : typeof message.timestamp === "string"
            ? new Date(message.timestamp).toISOString()
            : new Date(Number(BigInt(id) >> 22n) + 1_420_070_400_000).toISOString();
    return {
        id,
        channelId,
        guildId,
        channelName: channelName(channel),
        guildName: guild?.name ?? null,
        authorId: String(author?.id ?? "unknown"),
        authorName: author.globalName ?? author.username,
        content: typeof message.content === "string" ? message.content : "",
        timestamp,
        editedTimestamp: "edited_timestamp" in message
            ? message.edited_timestamp ?? null
            : message.editedTimestamp?.toISOString() ?? null,
        attachmentCount: message.attachments.length,
        embedCount: message.embeds.length,
        jumpUrl: `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${id}`,
    };
}

async function indexMessages(values: unknown[]): Promise<void> {
    const serialized = values
        .filter(isDiscordMessage)
        .map(serializeMessage)
        .filter((message): message is IndexedDiscordMessage => Boolean(message));
    if (serialized.length) await Native.indexDiscordMessages(serialized);
}

async function backfillChannel(channelId: string): Promise<void> {
    if (backfilledChannels.has(channelId) || !ChannelStore.getChannel(channelId)) return;
    backfilledChannels.add(channelId);
    try {
        const response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100 },
            retries: 2,
        });
        if (Array.isArray(response.body)) await indexMessages(response.body);
    } catch (error) {
        backfilledChannels.delete(channelId);
        logger.warn(`Failed to index approved channel ${channelId}`, error);
    }
}

async function refreshApprovals(): Promise<void> {
    const state = await Native.getControlState();
    const next = new Set(state.approvedChannelIds);
    approvedChannelIds = next;
    await Promise.all([...next].map(backfillChannel));
}

async function refreshSnapshot(): Promise<void> {
    const value = collectSnapshot();
    await Promise.all([
        Native.updateSnapshot(value),
        Native.updatePrivacyInventory(collectPrivacyInventory(value.plugins)),
    ]);
}

async function startControlPanel(): Promise<void> {
    await Native.initializeControlPanel();
    await Promise.all([refreshSnapshot(), refreshApprovals()]);
    snapshotTimer = setInterval(() => void refreshSnapshot().catch(error => logger.error("Snapshot refresh failed", error)), REFRESH_INTERVAL_MS);
    approvalTimer = setInterval(() => void refreshApprovals().catch(error => logger.error("Approval refresh failed", error)), APPROVAL_REFRESH_MS);
}

export default definePlugin({
    name: "ControlPanel",
    description: "Runs LawyerCord's encrypted local search, evidence, privacy, and account-statistics dashboard.",
    authors: [EquicordDevs.nobody, EquicordDevs.SenorLawyer],
    dependencies: ["CommandsAPI"],
    required: true,

    commands: [{
        name: "lawyercord control panel",
        description: "Open the local LawyerCord control panel",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async (_, context) => {
            const url = await Native.openControlPanel();
            sendBotMessage(context.channel.id, {
                content: `Opened the LawyerCord control panel locally. The private URL is available while this app is running: ${url}`,
            });
        },
    }],

    flux: {
        MESSAGE_CREATE({ optimistic, type, message }: DiscordMessageCreateEvent) {
            if (optimistic || type !== "MESSAGE_CREATE" || !message || message.state === "SENDING") return;
            const channelId = String(message.channel_id ?? "");
            if (approvedChannelIds.has(channelId)) void indexMessages([message]);
        },
    },

    start() {
        void startControlPanel().catch(error => logger.error("Failed to start the local control panel", error));
    },

    stop() {
        if (snapshotTimer) clearInterval(snapshotTimer);
        if (approvalTimer) clearInterval(approvalTimer);
        snapshotTimer = approvalTimer = null;
    },
});
