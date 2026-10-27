/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    BURST_WINDOW_MS,
    createWriteLimiter,
    DISCORD_MCP_TOOL_NAMES,
    GATES,
    HOUR_WINDOW_MS,
    normalizeAllowedMentions,
    normalizeAttachments,
    normalizeEmoji,
    parseDiscordLink,
    parseInviteCode,
    parseUploadDirectories,
    requireGate,
    resolveLocationArgs,
    TOOL_POLICY,
    type WriteLimits,
} from "../src/equicordplugins/discordMcp.desktop/policy";
import { TOOLS } from "../tools/discord-mcp/server.mjs";
import { loadPluginModule } from "./testDiscordMcpHarness";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000001";
const HIDDEN = "200000000000000002";
const READONLY = "200000000000000003";
const CATEGORY = "200000000000000004";
const VOICE = "200000000000000005";
const THREAD = "200000000000000006";
const DM = "200000000000000007";
const ME = "300000000000000001";
const ALICE = "300000000000000002";
const BOB = "300000000000000003";
const CAROL = "300000000000000004";
const MOD_ROLE = "400000000000000001";
const MESSAGE_A = "500000000000000001";
const MESSAGE_B = "500000000000000002";
const MESSAGE_C = "500000000000000003";

const BITS = {
    ADMINISTRATOR: 1n << 3n,
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    ADD_REACTIONS: 1n << 6n,
    ATTACH_FILES: 1n << 15n,
};

interface RestCall {
    method: string;
    url: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
}

type Responder = (call: RestCall) => unknown;

interface FakeChannel extends Record<string, unknown> { isThread(): boolean; }

function channel(props: Record<string, unknown>): FakeChannel {
    return { guild_id: GUILD, position: 0, topic: null, nsfw: false, lastMessageId: null, ...props, isThread() { return [10, 11, 12].includes(Number(this.type)); } } as FakeChannel;
}

function rawMessage(id: string, authorId: string, content: string, extra: Record<string, unknown> = {}) {
    return {
        id, channel_id: CHANNEL, content, timestamp: "2026-01-01T00:00:00.000Z", edited_timestamp: null, type: 0, flags: 0,
        author: { id: authorId, username: `user${authorId.slice(-1)}`, global_name: null, bot: false, avatar: null, discriminator: "0" },
        attachments: [], embeds: [], mentions: [], mention_roles: [], reactions: [], pinned: false, tts: false, ...extra,
    };
}

function makeWorld(options: { sleeps?: number[]; } = {}) {
    const calls: RestCall[] = [];
    const routes: Array<[string, RegExp, Responder]> = [];
    const sent: Array<{ channelId: string; data: unknown; options: Record<string, unknown>; }> = [];
    const dispatched: unknown[] = [];
    let currentUserId = ME;

    const users: Record<string, Record<string, unknown>> = {
        [ME]: { id: ME, username: "me", globalName: "Me", bot: false, discriminator: "0", avatar: "me", email: "secret@example.com", phone: "+1555" },
        [ALICE]: { id: ALICE, username: "alice", globalName: "Alice Wonder", bot: false, discriminator: "0", avatar: "al" },
        [BOB]: { id: BOB, username: "bobby", globalName: null, bot: false, discriminator: "0", avatar: null },
        [CAROL]: { id: CAROL, username: "carol", globalName: "Carol", bot: true, discriminator: "0", avatar: null },
    };
    const channels: Record<string, ReturnType<typeof channel>> = {
        [CHANNEL]: channel({ id: CHANNEL, type: 0, name: "general", parent_id: CATEGORY, position: 1, lastMessageId: MESSAGE_C }),
        [HIDDEN]: channel({ id: HIDDEN, type: 0, name: "staff", parent_id: CATEGORY, position: 2 }),
        [READONLY]: channel({ id: READONLY, type: 0, name: "announcements", parent_id: CATEGORY, position: 3 }),
        [CATEGORY]: channel({ id: CATEGORY, type: 4, name: "Main", position: 0 }),
        [VOICE]: channel({ id: VOICE, type: 2, name: "Lounge", parent_id: CATEGORY, position: 4 }),
        [THREAD]: channel({ id: THREAD, type: 11, name: "side thread", parent_id: CHANNEL, threadMetadata: { archived: false, locked: false, autoArchiveDuration: 1440 }, lastMessageId: MESSAGE_B }),
        [DM]: channel({ id: DM, type: 1, guild_id: undefined, name: "", recipients: [ALICE], rawRecipients: [], permissionOverwrites: {} }),
    };
    channels[CHANNEL].permissionOverwrites = {};
    const roles: Record<string, Record<string, unknown>> = {
        [GUILD]: { id: GUILD, name: "@everyone", permissions: BITS.VIEW_CHANNEL | BITS.SEND_MESSAGES, position: 0, color: 0, hoist: false, managed: false, mentionable: false },
        [MOD_ROLE]: { id: MOD_ROLE, name: "Mod", permissions: BITS.MANAGE_MESSAGES, position: 2, color: 0xff0000, hoist: true, managed: false, mentionable: true },
    };
    const members: Record<string, Record<string, unknown>> = {
        [ME]: { userId: ME, nick: null, roles: [], joinedAt: "2025-01-01T00:00:00.000Z" },
        [ALICE]: { userId: ALICE, nick: "Ali", roles: [MOD_ROLE], joinedAt: "2025-02-01T00:00:00.000Z" },
        [BOB]: { userId: BOB, nick: "Robert", roles: [], joinedAt: "2025-03-01T00:00:00.000Z" },
    };
    const relationships = new Map<string, number>([[ALICE, 1], [BOB, 3], [CAROL, 2]]);
    const guild = { id: GUILD, name: "Test Guild", description: null, ownerId: ALICE, preferredLocale: "en-US", features: new Set(["COMMUNITY"]), icon: "ic", premiumTier: 1, premiumSubscriberCount: 3, verificationLevel: 1, nsfwLevel: 0, mfaLevel: 0, joinedAt: new Date("2025-01-01") };
    const noVoice: Record<string, unknown> = {};

    const externals = {
        "@webpack/common": {
            ChannelStore: {
                getChannel: (id: string) => channels[id],
                getAllThreadsForGuild: () => [channels[THREAD]],
                getAllThreadsForParent: (id: string) => id === CHANNEL ? [channels[THREAD]] : [],
                getSortedPrivateChannels: () => [channels[DM]],
                getDMFromUserId: (id: string) => id === ALICE ? DM : undefined,
                getDMUserIds: () => [ALICE],
            },
            GuildStore: { getGuild: (id: string) => id === GUILD ? guild : undefined, getGuilds: () => ({ [GUILD]: guild }), getGuildCount: () => 1 },
            GuildChannelStore: {
                getChannels: () => ({
                    SELECTABLE: [CHANNEL, HIDDEN, READONLY].map(id => ({ channel: channels[id], comparator: 0 })),
                    VOCAL: [{ channel: channels[VOICE], comparator: 0 }],
                    4: [{ channel: channels[CATEGORY], comparator: 0 }],
                }),
            },
            GuildMemberStore: {
                getMember: (guildId: string, id: string) => guildId === GUILD ? members[id] ?? null : null,
                getMembers: () => Object.values(members),
                getSelfMember: () => members[currentUserId],
                getNick: (_: string, id: string) => (members[id]?.nick as string | null | undefined) ?? null,
                memberOf: (id: string) => members[id] ? [GUILD] : [],
            },
            GuildRoleStore: {
                getRole: (_: string, id: string) => roles[id],
                getSortedRoles: () => Object.values(roles).sort((a, b) => Number(b.position) - Number(a.position)),
                getNumRoles: () => Object.keys(roles).length,
            },
            GuildMemberCountStore: { getMemberCount: () => 42, getOnlineCount: () => 7 },
            IconUtils: { getUserAvatarURL: (user: { id: string; }) => `https://cdn.example/a/${user.id}.png`, getGuildIconURL: ({ id }: { id: string; }) => `https://cdn.example/g/${id}.png`, getUserBannerURL: () => undefined },
            PermissionsBits: BITS,
            PermissionStore: {
                can: (bit: bigint, target: { id: string; }) => {
                    if (bit === BITS.VIEW_CHANNEL) return target.id !== HIDDEN;
                    if (bit === BITS.SEND_MESSAGES) return target.id !== READONLY;
                    return true;
                },
            },
            PresenceStore: {
                getStatus: (id: string) => id === ALICE ? "online" : "offline",
                getClientStatus: () => ({ desktop: "online" }),
                getActivities: (id: string) => id === ME ? [{ type: 4, name: "Custom Status", state: "busy", emoji: { name: "x" } }] : [],
            },
            ReadStateStore: {
                getUnreadCount: () => 3, hasUnread: (id: string) => id === CHANNEL, getMentionCount: (id: string) => id === CHANNEL ? 2 : 0,
                getAllReadStates: () => [{ channelId: CHANNEL }, { channelId: DM }], ackMessageId: () => MESSAGE_A, getOldestUnreadMessageId: () => MESSAGE_B,
            },
            RelationshipStore: {
                getRelationshipType: (id: string) => relationships.get(id) ?? 0,
                getFriendIDs: () => [ALICE], getNickname: (id: string) => id === ALICE ? "Allie" : undefined, getSince: () => "2025-01-01",
                getMutableRelationships: () => relationships, getIgnoredIDs: () => [], getFriendCount: () => 1, isBlocked: (id: string) => relationships.get(id) === 2,
            },
            SnowflakeUtils: { fromTimestamp: (ms: number) => String(ms), extractTimestamp: () => 1_700_000_000_000 },
            UserStore: { getUser: (id: string) => users[id], getUsers: () => users, getCurrentUser: () => users[currentUserId] },
            UserProfileStore: { getMutualGuilds: () => [{ guild, nick: "Ali" }], getMutualFriendsCount: () => 2, getGuildMemberProfile: () => null },
            VoiceStateStore: {
                getVoiceStatesForChannel: (id: string) => id === VOICE ? { [ALICE]: { mute: false, deaf: false, selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false, suppress: false, channelId: VOICE } } : noVoice,
                getVoiceStates: () => ({ [ALICE]: { mute: false, deaf: false, selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false, suppress: false, channelId: VOICE } }),
            },
            FluxDispatcher: { dispatch: (event: unknown) => { dispatched.push(event); } },
            Constants: { Endpoints: { MESSAGES: (c: string) => `/channels/${c}/messages`, MESSAGE: (c: string, m: string) => `/channels/${c}/messages/${m}`, USER: (id: string) => `/users/${id}` } },
            CloudUploader: class { description: string | null = null; constructor(public item: unknown, public channelId: string) { } },
            RestAPI: Object.fromEntries(["get", "post", "put", "patch", "del"].map(method => [method, async (request: { url: string; query?: Record<string, unknown>; body?: Record<string, unknown>; }) => {
                const call = { method, url: request.url, query: request.query, body: request.body };
                calls.push(call);
                const route = routes.find(([m, pattern]) => m === method && pattern.test(request.url));
                if (!route) throw { status: 404, body: { message: "Unknown Route", code: 0 } };
                return { status: 200, body: route[2](call) };
            }])),
        },
        "@utils/misc": { sleep: async (ms: number) => { options.sleeps?.push(ms); } },
        "@utils/discord": {
            fetchUserProfile: async () => ({ bio: "hello", pronouns: "they/them", accentColor: 0x00ff00, banner: null, badges: [{ id: "b", description: "Badge" }], connectedAccounts: [{ type: "github", name: "alice", verified: true }], premiumSince: null }),
            openPrivateChannel: async () => { channels[DM]; },
            sendMessage: async (channelId: string, data: unknown, _wait: boolean, sendOptions: Record<string, unknown>) => { sent.push({ channelId, data, options: sendOptions }); return { body: { id: MESSAGE_C, channel_id: channelId, content: "uploaded" } }; },
        },
        "@plugins/voiceMessages/waveform": { generateWaveform: async () => "wave" },
        "../voiceMessageTranscriber.desktop/utils": { decodeAudio: async () => ({}) },
        "@vencord/discord-types/enums": { CloudUploadPlatform: { WEB: 1 } },
    };

    const natives: string[] = [];
    const native = {
        recordSentMessage: async (c: string, m: string) => { natives.push(`record:${c}:${m}`); },
        forgetSentMessage: async (c: string, m: string) => { natives.push(`forget:${c}:${m}`); },
        isSentMessage: async () => false,
        fetchDiscordAttachment: async () => ({ contentType: "audio/ogg", data: new Uint8Array([1]) }),
        downloadDiscordAttachment: async () => ({ path: "/tmp/x", filename: "x", contentType: "text/plain", size: 1, sha256: "s", data: new Uint8Array([1]) }),
        readUploadFile: async (path: string) => ({ name: path.split("/").pop(), data: new Uint8Array([1, 2]) }),
    };

    const handlers = loadPluginModule("handlers", externals) as {
        executeTool(tool: string, args: unknown, context: unknown): Promise<any>;
        handleMessageCreate(payload: unknown): void;
        handleMessageUpdate(payload: unknown): void;
        handleMessageDelete(payload: unknown): void;
        handleReactionAdd(payload: unknown): void;
        resetBridgeState(): void;
    };

    const defaults = {
        allowRelationshipActions: false, allowMembershipActions: false, allowAccountActions: false,
        allowModerationActions: false, allowRoleActions: false, allowChannelManagement: false,
        channelBurstLimit: 5, channelHourlyLimit: 60, globalBurstLimit: 10, globalHourlyLimit: 120, uploadDirectories: "",
    };

    return {
        calls, sent, natives, dispatched, handlers, native, users, channels,
        route: (method: string, pattern: RegExp, responder: Responder) => { routes.push([method, pattern, responder]); },
        settings: { ...defaults },
        run(tool: string, args: unknown = {}, settings: Partial<typeof defaults> = {}) {
            return handlers.executeTool(tool, args, { check() { }, settings: { ...this.settings, ...settings }, native });
        },
        switchUser: (id: string) => { currentUserId = id; },
    };
}

const LIMITS: WriteLimits = { channelBurst: 5, channelHourly: 60, globalBurst: 10, globalHourly: 120 };

test("write limiter enforces per channel and global sliding windows", () => {
    let clock = 1_000_000;
    const limiter = createWriteLimiter(() => clock);
    for (let i = 0; i < 5; i++) limiter.spend(CHANNEL, LIMITS);
    assert.throws(() => limiter.spend(CHANNEL, LIMITS), /this channel \(5 per 10 seconds\)\. Try again in 10 seconds/);
    limiter.spend(HIDDEN, LIMITS);
    clock += 4_000;
    assert.throws(() => limiter.spend(CHANNEL, LIMITS), /Try again in 6 seconds/);
    clock += BURST_WINDOW_MS;
    limiter.spend(CHANNEL, LIMITS);

    const strict = createWriteLimiter(() => clock);
    const tight = { ...LIMITS, globalBurst: 2 };
    strict.spend(CHANNEL, tight);
    strict.spend(HIDDEN, tight);
    assert.throws(() => strict.spend(READONLY, tight), /all channels \(2 per 10 seconds\)/);
});

test("write limiter hourly cap recovers and a rejected spend is not counted", () => {
    let clock = 5_000_000;
    const limiter = createWriteLimiter(() => clock);
    const hourly = { channelBurst: 100, channelHourly: 3, globalBurst: 100, globalHourly: 100 };
    for (let i = 0; i < 3; i++) { limiter.spend(CHANNEL, hourly); clock += 11_000; }
    assert.throws(() => limiter.spend(CHANNEL, hourly), /3 per hour/);
    assert.throws(() => limiter.spend(CHANNEL, hourly), /3 per hour/);
    clock += HOUR_WINDOW_MS;
    limiter.spend(CHANNEL, hourly);
    limiter.reset();
    for (let i = 0; i < 3; i++) limiter.spend(CHANNEL, hourly);
});

test("jump links are accepted wherever an ID is", () => {
    const link = `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE_A}`;
    assert.deepEqual(parseDiscordLink(link), { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE_A });
    assert.deepEqual(parseDiscordLink(`https://ptb.discord.com/channels/@me/${DM}`), { guildId: null, channelId: DM, messageId: null });
    assert.equal(parseDiscordLink("https://example.com/channels/1/2/3"), null);

    assert.deepEqual(resolveLocationArgs({ channel_id: link }), { channel_id: CHANNEL, message_id: MESSAGE_A, guild_id: GUILD });
    assert.deepEqual(resolveLocationArgs({ message_id: link }), { message_id: MESSAGE_A, channel_id: CHANNEL, guild_id: GUILD });
    assert.deepEqual(resolveLocationArgs({ channel_id: CHANNEL, around: link }), { channel_id: CHANNEL, around: MESSAGE_A, guild_id: GUILD });
    assert.deepEqual(resolveLocationArgs({ channel_ids: [link, HIDDEN] }).channel_ids, [CHANNEL, HIDDEN]);
    assert.throws(() => resolveLocationArgs({ channel_id: HIDDEN, message_id: link }), /different channel/);
    assert.throws(() => resolveLocationArgs({ before: `https://discord.com/channels/${GUILD}/${CHANNEL}` }), /message/);
    const untouched = { channel_id: CHANNEL, limit: 5 };
    assert.deepEqual(resolveLocationArgs(untouched), untouched);
});

test("argument normalizers reject unsafe input", () => {
    assert.equal(normalizeEmoji("\u{1F44D}"), encodeURIComponent("\u{1F44D}"));
    assert.equal(normalizeEmoji("party:123456789012345678"), "party%3A123456789012345678");
    for (const bad of ["", "a/b", "x".repeat(65), "name:abc", "a?b"]) assert.throws(() => normalizeEmoji(bad), /emoji/);
    assert.deepEqual(normalizeAttachments([{ path: "/a/b.png", filename: "b.png" }]), [{ path: "/a/b.png", filename: "b.png" }]);
    assert.throws(() => normalizeAttachments([{ path: "/a", filename: "../x" }]), /separators/);
    assert.throws(() => normalizeAttachments(new Array(11).fill({ path: "/a" })), /at most 10/);
    assert.deepEqual(normalizeAllowedMentions(undefined), { parse: [], replied_user: false });
    assert.deepEqual(normalizeAllowedMentions({ users: [ALICE], replied_user: true }), { parse: [], users: [ALICE], replied_user: true });
    assert.throws(() => normalizeAllowedMentions({ parse: ["users"], users: [ALICE] }), /together/);
    assert.throws(() => normalizeAllowedMentions({ parse: ["admins"] }), /parse/);
    assert.throws(() => normalizeAllowedMentions({ parse: 5 }), /parse/);
    assert.equal(parseInviteCode("https://discord.gg/abc-123"), "abc-123");
    assert.equal(parseInviteCode("discord.com/invite/xyz"), "xyz");
    assert.throws(() => parseInviteCode("not a code!"), /invite/);
    assert.deepEqual(parseUploadDirectories("C:\\a\r\n\r\n /b \nC:\\a"), ["C:\\a", "/b"]);
});

test("every gate names its plugin setting and the server advertises the same tools", () => {
    for (const [name, rule] of Object.entries(TOOL_POLICY) as Array<[string, { gate?: keyof typeof GATES; }]>) {
        if (!rule.gate) continue;
        const settings = Object.fromEntries(Object.values(GATES).map(gate => [gate.setting, false])) as never;
        assert.throws(() => requireGate(settings, rule.gate as keyof typeof GATES, name), new RegExp(GATES[rule.gate].label));
    }
    assert.deepEqual(TOOLS.map(tool => tool.name), DISCORD_MCP_TOOL_NAMES.map(name => `discord_${name}`));
});

test("gated tools refuse before touching Discord and run once enabled", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
        ["kick_member", { guild_id: GUILD, user_id: BOB }, "allowModerationActions", "Allow moderation actions"],
        ["ban_member", { guild_id: GUILD, user_id: BOB, delete_message_seconds: 60 }, "allowModerationActions", "Allow moderation actions"],
        ["timeout_member", { guild_id: GUILD, user_id: BOB, duration_seconds: 60 }, "allowModerationActions", "Allow moderation actions"],
        ["add_role", { guild_id: GUILD, user_id: BOB, role_id: MOD_ROLE }, "allowRoleActions", "Allow role actions"],
        ["block_user", { user_id: ALICE }, "allowRelationshipActions", "Allow relationship actions"],
        ["leave_server", { guild_id: GUILD }, "allowMembershipActions", "Allow membership actions"],
        ["set_status", { status: "idle" }, "allowAccountActions", "Allow account actions"],
        ["create_channel", { guild_id: GUILD, name: "new" }, "allowChannelManagement", "Allow channel management"],
    ];
    for (const [tool, args, setting, label] of cases) {
        const world = makeWorld();
        world.route("put", /./, () => ({}));
        world.route("del", /./, () => ({}));
        world.route("patch", /./, () => ({}));
        world.route("post", /./, () => ({ id: CHANNEL, type: 0 }));
        await assert.rejects(world.run(tool, args), new RegExp(label), tool);
        assert.equal(world.calls.length, 0, `${tool} must not call Discord while gated`);
        if (tool === "leave_server") continue;
        await world.run(tool, args, { [setting]: true });
        assert.equal(world.calls.length, 1, `${tool} calls Discord once when enabled`);
    }
});

test("leaving a server you own is refused even when membership actions are on", async () => {
    const world = makeWorld();
    world.switchUser(ALICE);
    await assert.rejects(world.run("leave_server", { guild_id: GUILD }, { allowMembershipActions: true }), /own this server/);
});

test("moderation targets cannot be yourself and roles must exist", async () => {
    const world = makeWorld();
    world.route("del", /./, () => ({}));
    world.route("put", /./, () => ({}));
    await assert.rejects(world.run("kick_member", { guild_id: GUILD, user_id: ME }, { allowModerationActions: true }), /yourself/);
    await assert.rejects(world.run("add_role", { guild_id: GUILD, user_id: BOB, role_id: "400000000000000099" }, { allowRoleActions: true }), /Role was not found/);
    await assert.rejects(world.run("add_role", { guild_id: GUILD, user_id: BOB, role_id: GUILD }, { allowRoleActions: true }), /@everyone/);
    assert.equal(world.calls.length, 0);
});

test("friend and block actions check the current relationship first", async () => {
    const world = makeWorld();
    world.route("put", /./, () => ({}));
    world.route("del", /./, () => ({}));
    const on = { allowRelationshipActions: true };
    await assert.rejects(world.run("accept_friend_request", { user_id: ALICE }, on), /no incoming friend request/);
    await world.run("accept_friend_request", { user_id: BOB }, on);
    assert.deepEqual(world.calls.at(-1)?.body, { type: 1 });
    await assert.rejects(world.run("unblock_user", { user_id: ALICE }, on), /not blocked/);
    await world.run("unblock_user", { user_id: CAROL }, on);
    await assert.rejects(world.run("block_user", { user_id: CAROL }, on), /already blocked/);
    await world.run("block_user", { user_id: ALICE }, on);
    assert.deepEqual(world.calls.at(-1)?.body, { type: 2 });
    await assert.rejects(world.run("send_friend_request", { user_id: ALICE }, on), /cannot be sent/);
});

test("send_message disables pings by default and builds replies, silent flags and stickers", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, () => [rawMessage(MESSAGE_A, ALICE, "original")]);
    world.route("post", /\/messages$/, call => rawMessage(MESSAGE_C, ME, String(call.body?.content)));
    const result = await world.run("send_message", { channel_id: CHANNEL, content: "hi", reply_to_message_id: MESSAGE_A, silent: true, sticker_ids: [ALICE] });
    const post = world.calls.find(call => call.method === "post");
    assert.deepEqual(post?.body?.allowed_mentions, { parse: [], replied_user: false });
    assert.deepEqual(post?.body?.message_reference, { channel_id: CHANNEL, guild_id: GUILD, message_id: MESSAGE_A });
    assert.equal(post?.body?.flags, 4096);
    assert.deepEqual(post?.body?.sticker_ids, [ALICE]);
    assert.equal(result.content, "hi");
    assert.deepEqual(world.natives, [`record:${CHANNEL}:${MESSAGE_C}`]);

    await world.run("send_message", { channel_id: CHANNEL, content: "@a", allowed_mentions: { users: [ALICE] } });
    assert.deepEqual(world.calls.filter(call => call.method === "post").at(-1)?.body?.allowed_mentions, { parse: [], users: [ALICE], replied_user: false });
    await assert.rejects(world.run("send_message", { channel_id: CHANNEL }), /content, attachments or sticker_ids/);
    await assert.rejects(world.run("send_message", { channel_id: READONLY, content: "x" }), /cannot send messages/);
});

test("send_message accepts a message link as the channel and the reply target", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, () => [rawMessage(MESSAGE_A, ALICE, "original")]);
    world.route("post", /\/messages$/, call => rawMessage(MESSAGE_C, ME, String(call.body?.content)));
    await world.run("send_message", { channel_id: `https://discord.com/channels/${GUILD}/${CHANNEL}`, content: "x", reply_to_message_id: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE_A}` });
    assert.equal((world.calls.find(call => call.method === "post")?.body?.message_reference as { message_id: string; }).message_id, MESSAGE_A);
});

test("write rate limit blocks the sixth send in ten seconds with a clear error", async () => {
    const world = makeWorld();
    world.route("post", /\/messages$/, call => rawMessage(MESSAGE_C, ME, String(call.body?.content), { channel_id: call.url.split("/")[2] }));
    for (let i = 0; i < 5; i++) await world.run("send_message", { channel_id: CHANNEL, content: `m${i}` });
    await assert.rejects(world.run("send_message", { channel_id: CHANNEL, content: "m6" }), /Write rate limit reached for this channel \(5 per 10 seconds\)/);
    assert.equal(world.calls.filter(call => call.method === "post").length, 5);
    await world.run("send_message", { channel_id: THREAD, content: "other channel" }, { channelBurstLimit: 5 });
    await assert.rejects(world.run("send_message", { channel_id: CHANNEL, content: "x" }, { channelBurstLimit: 1000, globalBurstLimit: 6 }), /all channels \(6 per 10 seconds\)/);
    await world.run("send_message", { channel_id: CHANNEL, content: "raised" }, { channelBurstLimit: 100, globalBurstLimit: 100 });
});

test("validation failures do not spend the write budget", async () => {
    const world = makeWorld();
    world.route("post", /\/messages$/, call => rawMessage(MESSAGE_C, ME, String(call.body?.content)));
    for (let i = 0; i < 20; i++) await assert.rejects(world.run("send_message", { channel_id: CHANNEL, content: "" }));
    await world.run("send_message", { channel_id: CHANNEL, content: "ok" });
});

test("send_message with attachments uploads through Discord's uploader and honours the allowlist setting", async () => {
    const world = makeWorld();
    let requestedDirectories: unknown;
    world.native.readUploadFile = async (path: string, directories?: unknown) => { requestedDirectories = directories; return { name: path.split("/").pop(), data: new Uint8Array([1, 2]) }; };
    const result = await world.run("send_message", { channel_id: CHANNEL, content: "file", attachments: [{ path: "/data/cat.png", description: "a cat" }] }, { uploadDirectories: "/data\n/more" });
    assert.deepEqual(requestedDirectories, ["/data", "/more"]);
    assert.equal(world.sent.length, 1);
    const uploads = world.sent[0].options.attachmentsToUpload as Array<{ description: string; item: { file: File; }; }>;
    assert.equal(uploads[0].description, "a cat");
    assert.equal(uploads[0].item.file.name, "cat.png");
    assert.equal(result.id, MESSAGE_C);
    await assert.rejects(world.run("send_message", { channel_id: CHANNEL, content: "x", attachments: [{ path: "/a" }], silent: true }), /silent/);
});

test("delete_own_message checks authorship instead of trusting a ledger", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, call => [rawMessage(String(call.query?.around), call.query?.around === MESSAGE_A ? ME : ALICE, "x")]);
    world.route("del", /\/messages\//, () => ({}));
    const done = await world.run("delete_own_message", { channel_id: CHANNEL, message_id: MESSAGE_A });
    assert.equal(done.deleted, true);
    assert.deepEqual(world.natives, [`forget:${CHANNEL}:${MESSAGE_A}`]);
    await assert.rejects(world.run("delete_own_message", { channel_id: CHANNEL, message_id: MESSAGE_B }), /not authored/);
    assert.equal(world.calls.filter(call => call.method === "del").length, 1);
});

test("delete_message needs moderation actions only for other people's messages", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, call => [rawMessage(String(call.query?.around), call.query?.around === MESSAGE_A ? ME : ALICE, "x")]);
    world.route("del", /\/messages\//, () => ({}));
    assert.equal((await world.run("delete_message", { channel_id: CHANNEL, message_id: MESSAGE_A })).own, true);
    await assert.rejects(world.run("delete_message", { channel_id: CHANNEL, message_id: MESSAGE_B }), /Allow moderation actions/);
    assert.equal((await world.run("delete_message", { channel_id: CHANNEL, message_id: MESSAGE_B }, { allowModerationActions: true })).own, false);
});

test("edit_message only edits your own messages and keeps pings off", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, call => [rawMessage(String(call.query?.around), call.query?.around === MESSAGE_A ? ME : ALICE, "x")]);
    world.route("patch", /\/messages\//, call => rawMessage(MESSAGE_A, ME, String(call.body?.content), { edited_timestamp: "2026-01-02T00:00:00.000Z" }));
    const edited = await world.run("edit_message", { channel_id: CHANNEL, message_id: MESSAGE_A, content: "new" });
    assert.equal(edited.content, "new");
    assert.deepEqual(world.calls.at(-1)?.body?.allowed_mentions, { parse: [], replied_user: false });
    await assert.rejects(world.run("edit_message", { channel_id: CHANNEL, message_id: MESSAGE_B, content: "new" }), /not authored/);
});

test("read_messages paginates consistently and never returns secrets", async () => {
    const world = makeWorld();
    const all = [MESSAGE_C, MESSAGE_B, MESSAGE_A].map(id => rawMessage(id, ALICE, `body ${id}`, {
        reactions: [{ emoji: { id: null, name: "x" }, count: 2, me: true }],
        mentions: [{ id: BOB, username: "bobby" }],
        message_reference: { message_id: MESSAGE_A, channel_id: CHANNEL, guild_id: GUILD },
        referenced_message: rawMessage(MESSAGE_A, BOB, "ref"),
        attachments: [{ id: BOB, filename: "f.txt", size: 3, url: "https://cdn.discordapp.com/attachments/1/2/f.txt" }],
    }));
    world.route("get", /\/messages$/, call => all.slice(0, Number(call.query?.limit)));
    const page = await world.run("read_messages", { channel_id: CHANNEL, limit: 2 });
    assert.equal(page.order, "newest_first");
    assert.equal(page.count, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextBefore, MESSAGE_B);
    assert.equal(page.nextAfter, MESSAGE_C);
    assert.equal(page.channel.name, "general");
    const [first] = page.messages;
    assert.equal(first.reactions[0].count, 2);
    assert.equal(first.mentions[0].id, BOB);
    assert.equal(first.replyToMessageId, MESSAGE_A);
    assert.equal(first.referencedMessage.content, "ref");
    assert.equal(first.attachments[0].filename, "f.txt");
    assert.equal(first.authorNick, "Ali");
    assert.equal(JSON.stringify(page).includes("secret@example.com"), false);

    const around = await world.run("read_messages", { channel_id: CHANNEL, around: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE_B}`, limit: 3 });
    assert.equal(around.hasMore, null);
    assert.equal(world.calls.at(-1)?.query?.around, MESSAGE_B);
    await assert.rejects(world.run("read_messages", { channel_id: CHANNEL, before: MESSAGE_A, after: MESSAGE_B }), /Only one of/);
    await assert.rejects(world.run("read_messages", { channel_id: CHANNEL, limit: 101 }), /1 to 100/);
});

test("channels not cached locally are resolved through Discord", async () => {
    const world = makeWorld();
    const archived = "200000000000000099";
    world.route("get", new RegExp(`/channels/${archived}$`), () => ({ id: archived, type: 11, guild_id: GUILD, name: "archived thread", parent_id: CHANNEL, thread_metadata: { archived: true } }));
    world.route("get", new RegExp(`/channels/${archived}/messages$`), () => [rawMessage(MESSAGE_A, ALICE, "old", { channel_id: archived })]);
    const result = await world.run("read_messages", { channel_id: archived });
    assert.equal(result.channel.name, "archived thread");
    assert.equal(result.count, 1);
    await assert.rejects(world.run("read_messages", { channel_id: "200000000000000098" }), /not available/);
});

test("search_messages sends Discord's filters, retries while the index builds and pages by offset", async () => {
    const sleeps: number[] = [];
    const world = makeWorld({ sleeps });
    let attempts = 0;
    world.route("get", /\/guilds\/\d+\/messages\/search/, call => {
        attempts++;
        if (attempts === 1) return { message: "Index not yet available", code: 110000, retry_after: 2 };
        const offset = Number(new URL(`https://x${call.url}`).searchParams.get("offset"));
        return { total_results: 60, messages: Array.from({ length: 25 }, (_, i) => [rawMessage(String(500000000000000100n + BigInt(offset + i)), ALICE, "hit", { hit: true })]) };
    });
    const result = await world.run("search_messages", {
        guild_id: GUILD, query: "release", author_id: ALICE, has: ["image", "link"], author_type: "user", pinned: false,
        channel_ids: [CHANNEL], after_date: "2026-01-01", before_message_id: MESSAGE_C, sort_by: "relevance", limit: 30, link_hostname: "example.com",
    });
    assert.deepEqual(sleeps, [2_000]);
    const url = new URL(`https://x${world.calls.at(-1)?.url}`);
    assert.equal(url.searchParams.get("content"), "release");
    assert.equal(url.searchParams.get("author_id"), ALICE);
    assert.deepEqual(url.searchParams.getAll("has"), ["image", "link"]);
    assert.deepEqual(url.searchParams.getAll("channel_id"), [CHANNEL]);
    assert.equal(url.searchParams.get("min_id"), String(Date.parse("2026-01-01")));
    assert.equal(url.searchParams.get("max_id"), MESSAGE_C);
    assert.equal(url.searchParams.get("author_type"), "user");
    assert.equal(url.searchParams.get("pinned"), "false");
    assert.equal(url.searchParams.get("sort_by"), "relevance");
    assert.equal(url.searchParams.get("link_hostname"), "example.com");
    assert.equal(result.resultCount, 30);
    assert.equal(result.totalResults, 60);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextOffset, 30);
    assert.equal(result.scope.type, "guild");

    await assert.rejects(world.run("search_messages", { guild_id: GUILD }), /query or at least one/);
    await assert.rejects(world.run("search_messages", { guild_id: GUILD, query: "x", after_date: "2026-01-01", after_message_id: MESSAGE_A }), /either/);
    await assert.rejects(world.run("search_messages", { guild_id: GUILD, query: "x", after_date: "yesterday" }), /ISO 8601/);
    await assert.rejects(world.run("search_messages", { query: "x" }), /channel_id or guild_id/);
});

test("search_messages searches a DM through the channel endpoint", async () => {
    const world = makeWorld();
    world.route("get", /\/channels\/\d+\/messages\/search/, () => ({ total_results: 1, messages: [[rawMessage(MESSAGE_A, ALICE, "dm hit", { hit: true, channel_id: DM })]] }));
    const result = await world.run("search_messages", { channel_id: DM, query: "hit" });
    assert.match(world.calls[0].url, new RegExp(`^/channels/${DM}/messages/search`));
    assert.equal(result.scope.type, "channel");
    assert.equal(result.hasMore, false);
    assert.equal(result.messages[0].channel.typeName, "dm");
});

test("rate limited Discord requests wait for retry_after and then succeed", async () => {
    const sleeps: number[] = [];
    const world = makeWorld({ sleeps });
    let tries = 0;
    world.route("get", /\/messages$/, () => {
        if (tries++ < 2) throw { status: 429, body: { retry_after: 1.5, message: "slow down" } };
        return [rawMessage(MESSAGE_A, ALICE, "ok")];
    });
    const result = await world.run("read_messages", { channel_id: CHANNEL });
    assert.equal(result.count, 1);
    assert.deepEqual(sleeps, [1_600, 1_600]);

    const stuck = makeWorld({ sleeps: [] });
    stuck.route("get", /\/messages$/, () => { throw { status: 429, body: { retry_after: 1, message: "slow down" } }; });
    await assert.rejects(stuck.run("read_messages", { channel_id: CHANNEL }), /HTTP 429.*slow down/);
    const failing = makeWorld();
    failing.route("get", /\/messages$/, () => { throw { status: 403, body: { code: 50013, message: "Missing Permissions" } }; });
    await assert.rejects(failing.run("read_messages", { channel_id: CHANNEL }), /HTTP 403 \(code 50013\): Missing Permissions/);
});

test("list_server_channels only returns channels the account can view", async () => {
    const world = makeWorld();
    const result = await world.run("list_server_channels", { guild_id: GUILD });
    assert.deepEqual(result.channels.map((entry: { id: string; }) => entry.id), [CATEGORY, CHANNEL, READONLY, VOICE]);
    const general = result.channels.find((entry: { id: string; }) => entry.id === CHANNEL);
    assert.equal(general.categoryName, "Main");
    assert.equal(general.canSend, true);
    assert.equal(result.channels.find((entry: { id: string; }) => entry.id === READONLY).canSend, false);
    const withThreads = await world.run("list_server_channels", { guild_id: GUILD, include_threads: true });
    assert.ok(withThreads.channels.some((entry: { id: string; }) => entry.id === THREAD));
});

test("get_channel describes threads, DMs and your access", async () => {
    const world = makeWorld();
    const general = await world.run("get_channel", { channel_id: CHANNEL });
    assert.equal(general.typeName, "text");
    assert.equal(general.you.sendMessages, true);
    assert.equal(general.unread.mentionCount, 2);
    const thread = await world.run("get_channel", { channel_id: THREAD });
    assert.equal(thread.thread.archived, false);
    assert.equal(thread.parent.name, "general");
    const dm = await world.run("get_channel", { channel_id: DM });
    assert.equal(dm.recipients[0].username, "alice");
    assert.equal(dm.you, null);
});

test("list_threads lists active threads from the store and archived ones from Discord", async () => {
    const world = makeWorld();
    const active = await world.run("list_threads", { channel_id: CHANNEL });
    assert.equal(active.count, 1);
    assert.equal(active.threads[0].id, THREAD);
    world.route("get", /\/threads\/search/, () => ({ threads: [{ id: MESSAGE_A, type: 11, name: "old post", guild_id: GUILD, thread_metadata: { archived: true } }], first_messages: [rawMessage(MESSAGE_A, ALICE, "starter")], has_more: true, total_results: 9 }));
    const archived = await world.run("list_threads", { channel_id: CHANNEL, archived: true, limit: 1 });
    assert.equal(archived.threads[0].firstMessage.content, "starter");
    assert.equal(archived.hasMore, true);
    assert.equal(archived.nextOffset, 1);
    assert.equal(world.calls.at(-1)?.query?.archived, true);
    await assert.rejects(world.run("list_threads", {}), /channel_id or guild_id/);
    await assert.rejects(world.run("get_forum_tags", { channel_id: CHANNEL }), /forum or media/);
});

test("find_users ranks exact matches first and covers nicknames", async () => {
    const world = makeWorld();
    const byNick = await world.run("find_users", { query: "robert", guild_id: GUILD });
    assert.equal(byNick.users[0].user.id, BOB);
    assert.deepEqual(byNick.users[0].matchedOn, ["serverNickname"]);
    assert.equal(byNick.users[0].serverNickname, "Robert");
    const byFriend = await world.run("find_users", { query: "allie" });
    assert.equal(byFriend.users[0].user.id, ALICE);
    assert.equal(byFriend.users[0].relationship, "friend");
    const ranked = await world.run("find_users", { query: "ali", guild_id: GUILD });
    assert.equal(ranked.users[0].user.id, ALICE);
    assert.equal(ranked.count, 1);
    await assert.rejects(world.run("find_users", { query: "" }), /at least 1/);
});

test("get_member computes server and channel permissions from roles and overwrites", async () => {
    const world = makeWorld();
    const server = await world.run("get_member", { guild_id: GUILD, user_id: ALICE });
    assert.equal(server.highestRole.name, "Mod");
    assert.ok(server.permissions.names.includes("MANAGE_MESSAGES"));
    assert.ok(server.permissions.names.includes("SEND_MESSAGES"));
    assert.equal(server.presence.status, "online");
    world.channels[CHANNEL].permissionOverwrites = { [GUILD]: { id: GUILD, type: 0, allow: 0n, deny: BITS.SEND_MESSAGES }, [ALICE]: { id: ALICE, type: 1, allow: BITS.SEND_MESSAGES, deny: 0n } };
    const own = await world.run("get_member", { guild_id: GUILD, user_id: ME, channel_id: CHANNEL });
    assert.equal(own.permissions.names.includes("SEND_MESSAGES"), false);
    const overridden = await world.run("get_member", { guild_id: GUILD, user_id: ALICE, channel_id: CHANNEL });
    assert.equal(overridden.permissions.names.includes("SEND_MESSAGES"), true);
    assert.equal(overridden.permissions.scope, "channel");
    const owner = await world.run("get_member", { guild_id: GUILD, user_id: ALICE });
    assert.equal(owner.isOwner, true);
    assert.equal(owner.permissions.names.includes("ADMINISTRATOR"), true, "owners hold every permission");
    await assert.rejects(world.run("get_member", { guild_id: GUILD, user_id: CAROL }), /not a member/);
});

test("get_message_users returns the author, mentions and reply target with member details", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, () => [rawMessage(MESSAGE_B, ALICE, "hey", {
        mentions: [{ id: BOB, username: "bobby" }], mention_roles: [MOD_ROLE], mention_everyone: false,
        referenced_message: rawMessage(MESSAGE_A, BOB, "orig"),
    })]);
    const result = await world.run("get_message_users", { channel_id: CHANNEL, message_id: MESSAGE_B });
    assert.equal(result.author.member.nick, "Ali");
    assert.equal(result.mentions[0].user.id, BOB);
    assert.deepEqual(result.mentionRoles, [{ id: MOD_ROLE, name: "Mod" }]);
    assert.equal(result.replyTarget.user.id, BOB);
    assert.equal(result.replyTarget.replyTarget, true);
});

test("relationships, presence, profile and identity tools use cached state", async () => {
    const world = makeWorld();
    const friends = await world.run("list_relationships", {});
    assert.deepEqual(friends.relationships.map((entry: { user: { id: string; }; }) => entry.user.id), [ALICE]);
    assert.equal(friends.relationships[0].nickname, "Allie");
    const blocked = await world.run("list_relationships", { type: "blocked" });
    assert.deepEqual(blocked.relationships.map((entry: { user: { id: string; }; }) => entry.user.id), [CAROL]);
    assert.equal((await world.run("list_relationships", { type: "pending_incoming" })).total, 1);
    assert.equal((await world.run("get_presence", { user_id: ALICE })).status, "online");
    const profile = await world.run("get_user_profile", { user_id: ALICE, guild_id: GUILD });
    assert.equal(profile.bio, "hello");
    assert.equal(profile.mutualGuilds[0].nick, "Ali");
    assert.equal(profile.connections[0].type, "github");
    assert.equal(profile.accentColor, "#00ff00");
    const user = await world.run("get_user", { user_id: ALICE });
    assert.equal(user.dmChannelId, DM);
    assert.deepEqual(user.sharedGuildIds, [GUILD]);
    const me = await world.run("whoami");
    assert.equal(me.customStatus.state, "busy");
    assert.equal(JSON.stringify(me).includes("secret@example.com"), false);
    assert.equal(JSON.stringify(me).includes("+1555"), false);
    const status = await world.run("connection_status", {}, { allowRoleActions: true });
    assert.equal(status.gates.roles.enabled, true);
    assert.equal(status.gates.moderation.enabled, false);
    assert.equal(status.capabilities.roleChanges, true);
    assert.equal(status.capabilities.moderation, false);
    assert.equal(status.toolCount, DISCORD_MCP_TOOL_NAMES.length);
});

test("server, role, DM, voice and unread tools summarise cached state", async () => {
    const world = makeWorld();
    const server = await world.run("get_server", { guild_id: GUILD });
    assert.equal(server.memberCount, 42);
    assert.equal(server.channelSummary.textLike, 2);
    assert.equal(server.roles[0].name, "Mod");
    assert.equal(server.owner.username, "alice");
    const role = await world.run("get_role", { guild_id: GUILD, role_id: MOD_ROLE });
    assert.equal(role.cachedMemberCount, 1);
    assert.ok(role.permissionNames.includes("MANAGE_MESSAGES"));
    assert.equal((await world.run("list_roles", { guild_id: GUILD })).count, 2);
    assert.equal((await world.run("list_servers", { query: "nothing" })).count, 0);
    const dms = await world.run("list_dms", { query: "alice" });
    assert.equal(dms.dms[0].displayName, "Alice Wonder");
    const voice = await world.run("get_voice_occupants", { channel_id: VOICE });
    assert.equal(voice.channels[0].occupants[0].selfMuted, true);
    assert.equal((await world.run("get_voice_occupants", { guild_id: GUILD })).channels[0].occupants[0].video, true);
    const unread = await world.run("list_unread", {});
    assert.equal(unread.channels[0].channel.id, CHANNEL);
    assert.equal((await world.run("list_unread", { mentions_only: true, guild_id: GUILD })).total, 1);
    assert.equal((await world.run("resolve_link", { url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE_A}` })).guildName, "Test Guild");
});

test("search_members asks the gateway and reads the refreshed cache", async () => {
    const sleeps: number[] = [];
    const world = makeWorld({ sleeps });
    const result = await world.run("search_members", { guild_id: GUILD, query: "rob" });
    assert.deepEqual(world.dispatched, [{ type: "GUILD_MEMBERS_REQUEST", guildIds: [GUILD], query: "rob", limit: 25 }]);
    assert.equal(result.members[0].user.id, BOB);
    assert.equal(world.calls.length, 0, "member search never uses a REST endpoint");
});

test("reactions, pins, typing, mark_read and threads call the expected Discord routes", async () => {
    const world = makeWorld();
    world.settings.channelBurstLimit = 100;
    world.route("put", /./, () => ({}));
    world.route("del", /./, () => ({}));
    world.route("post", /typing/, () => ({}));
    world.route("post", /ack/, () => ({}));
    world.route("post", /threads/, call => ({ id: THREAD, type: 11, name: call.body?.name, guild_id: GUILD }));
    await world.run("add_reaction", { channel_id: CHANNEL, message_id: MESSAGE_A, emoji: "\u{1F44D}" });
    assert.match(world.calls.at(-1)?.url ?? "", /reactions\/%F0%9F%91%8D\/@me/);
    await world.run("remove_reaction", { channel_id: CHANNEL, message_id: MESSAGE_A, emoji: "\u{1F44D}" });
    assert.match(world.calls.at(-1)?.url ?? "", /@me$/);
    await assert.rejects(world.run("remove_reaction", { channel_id: CHANNEL, message_id: MESSAGE_A, emoji: "\u{1F44D}", user_id: ALICE }), /Allow moderation actions/);
    await world.run("remove_reaction", { channel_id: CHANNEL, message_id: MESSAGE_A, emoji: "\u{1F44D}", user_id: ALICE }, { allowModerationActions: true });
    assert.match(world.calls.at(-1)?.url ?? "", new RegExp(`/${ALICE}$`));

    await world.run("pin_message", { channel_id: CHANNEL, message_id: MESSAGE_A });
    assert.equal(world.calls.at(-1)?.url, `/channels/${CHANNEL}/messages/pins/${MESSAGE_A}`);
    await world.run("unpin_message", { channel_id: CHANNEL, message_id: MESSAGE_A });
    assert.equal(world.calls.at(-1)?.method, "del");
    await world.run("send_typing", { channel_id: CHANNEL });
    await world.run("mark_read", { channel_id: CHANNEL });
    assert.equal(world.calls.at(-1)?.url, `/channels/${CHANNEL}/messages/${MESSAGE_C}/ack`);
    const thread = await world.run("create_thread", { channel_id: CHANNEL, name: "topic", message_id: MESSAGE_A });
    assert.equal(thread.name, "topic");
    assert.equal(world.calls.at(-1)?.url, `/channels/${CHANNEL}/messages/${MESSAGE_A}/threads`);
    await assert.rejects(world.run("create_thread", { channel_id: CHANNEL, name: "x", auto_archive_duration: 61 }), /60, 1440/);
    await assert.rejects(world.run("create_forum_post", { channel_id: CHANNEL, name: "x", content: "y" }), /forum or media/);
});

test("pins fall back to the legacy route when the new one is missing", async () => {
    const world = makeWorld();
    world.route("put", new RegExp(`/channels/${CHANNEL}/pins/`), () => ({}));
    await world.run("pin_message", { channel_id: CHANNEL, message_id: MESSAGE_A });
    assert.deepEqual(world.calls.map(call => call.url), [`/channels/${CHANNEL}/messages/pins/${MESSAGE_A}`, `/channels/${CHANNEL}/pins/${MESSAGE_A}`]);
    world.route("get", new RegExp(`/channels/${CHANNEL}/pins$`), () => [rawMessage(MESSAGE_A, ALICE, "pinned")]);
    const pins = await world.run("get_pinned_messages", { channel_id: CHANNEL });
    assert.equal(pins.pins[0].message.content, "pinned");
});

test("forward, reactions listing and message context", async () => {
    const world = makeWorld();
    world.route("get", /\/messages$/, call => call.query?.around === MESSAGE_B
        ? [rawMessage(MESSAGE_C, BOB, "reply", { message_reference: { message_id: MESSAGE_B } }), rawMessage(MESSAGE_B, ALICE, "mid"), rawMessage(MESSAGE_A, BOB, "before")]
        : [rawMessage(String(call.query?.around), ALICE, "single")]);
    world.route("post", /\/messages$/, call => rawMessage(MESSAGE_C, ME, "", { message_reference: call.body?.message_reference }));
    world.route("get", /\/reactions\//, () => [{ id: ALICE, username: "alice" }]);
    const forwarded = await world.run("forward_message", { channel_id: CHANNEL, message_id: MESSAGE_A, destination_channel_id: THREAD });
    assert.deepEqual(world.calls.find(call => call.method === "post")?.body?.message_reference, { type: 1, message_id: MESSAGE_A, channel_id: CHANNEL, guild_id: GUILD });
    assert.equal(forwarded.reference.type, 1);
    const reactions = await world.run("get_reactions", { channel_id: CHANNEL, message_id: MESSAGE_A, emoji: "\u{1F44D}", limit: 1 });
    assert.equal(reactions.hasMore, true);
    assert.equal(reactions.nextAfter, ALICE);
    const context = await world.run("get_message_context", { channel_id: CHANNEL, message_id: MESSAGE_B, radius: 1 });
    assert.deepEqual(context.before.map((message: { id: string; }) => message.id), [MESSAGE_A]);
    assert.deepEqual(context.after.map((message: { id: string; }) => message.id), [MESSAGE_C]);
    assert.deepEqual(context.replies.map((message: { id: string; }) => message.id), [MESSAGE_C]);
});

test("subscriptions collect edits, deletes and reactions for channels, servers and DMs", async () => {
    const world = makeWorld();
    const channelSub = await world.run("subscribe_channel", { channel_id: CHANNEL, events: ["message_create", "message_delete"] });
    const guildSub = await world.run("subscribe_guild", { guild_id: GUILD, events: ["message_update", "reaction_add"] });
    const dmSub = await world.run("subscribe_dms", {});
    assert.equal(channelSub.scope, "channel");
    assert.equal(guildSub.scope, "guild");
    assert.equal(dmSub.scope, "dms");
    assert.deepEqual(dmSub.events, ["message_create"]);

    world.handlers.handleMessageCreate({ message: rawMessage(MESSAGE_A, ALICE, "new"), channelId: CHANNEL });
    world.handlers.handleMessageCreate({ message: rawMessage(MESSAGE_B, ALICE, "in dm", { channel_id: DM }), channelId: DM });
    world.handlers.handleMessageUpdate({ message: rawMessage(MESSAGE_A, ALICE, "edited", { edited_timestamp: "2026-01-02T00:00:00.000Z" }) });
    world.handlers.handleMessageUpdate({ message: { id: MESSAGE_A, channel_id: CHANNEL, content: "embed only" } });
    world.handlers.handleMessageDelete({ id: MESSAGE_B, channelId: CHANNEL, guildId: GUILD });
    world.handlers.handleReactionAdd({ channelId: THREAD, messageId: MESSAGE_B, userId: BOB, emoji: { id: null, name: "x" } });
    world.handlers.handleReactionAdd({ optimistic: true, channelId: THREAD, messageId: MESSAGE_B, userId: BOB, emoji: { name: "x" } });

    const first = await world.run("wait_for_message", { subscription_id: channelSub.id, timeout_seconds: 1 });
    assert.equal(first.event.type, "message_create");
    assert.equal(first.message.content, "new");
    const second = await world.run("wait_for_message", { subscription_id: channelSub.id, timeout_seconds: 1 });
    assert.equal(second.event.type, "message_delete");
    assert.equal(second.event.messageId, MESSAGE_B);
    assert.equal(second.message, null);
    const edit = await world.run("wait_for_message", { subscription_id: guildSub.id, timeout_seconds: 1 });
    assert.equal(edit.event.type, "message_update");
    assert.equal(edit.message.content, "edited");
    const reaction = await world.run("wait_for_message", { subscription_id: guildSub.id, timeout_seconds: 1 });
    assert.equal(reaction.event.type, "reaction_add");
    assert.equal(reaction.event.userId, BOB);
    assert.equal(reaction.queuedRemaining, 0);
    const dm = await world.run("wait_for_message", { subscription_id: dmSub.id, timeout_seconds: 1 });
    assert.equal(dm.message.content, "in dm");

    const waiting = world.run("wait_for_message", { subscription_id: channelSub.id, timeout_seconds: 5 });
    world.handlers.handleMessageCreate({ message: rawMessage(MESSAGE_C, BOB, "live"), channelId: CHANNEL });
    assert.equal((await waiting).message.content, "live");

    const pendingWait = world.run("wait_for_message", { subscription_id: dmSub.id, timeout_seconds: 5 });
    assert.equal((await world.run("unsubscribe_channel", { subscription_id: dmSub.id })).unsubscribed, true);
    assert.equal((await pendingWait).cancelled, true);
    assert.equal((await world.run("list_subscriptions")).count, 2);
    await assert.rejects(world.run("wait_for_message", { subscription_id: "00000000-0000-0000-0000-000000000000" }), /not found/);
    world.handlers.resetBridgeState();
    assert.equal((await world.run("list_subscriptions")).count, 0);
});

test("subscription queues stay bounded and report dropped events", async () => {
    const world = makeWorld();
    const sub = await world.run("subscribe_channel", { channel_id: CHANNEL });
    for (let i = 0; i < 130; i++) world.handlers.handleMessageCreate({ message: rawMessage(String(500000000000001000n + BigInt(i)), ALICE, `m${i}`), channelId: CHANNEL });
    const listed = await world.run("list_subscriptions");
    assert.equal(listed.subscriptions[0].queuedMessageCount, 100);
    assert.equal(listed.subscriptions[0].droppedEvents, 30);
    assert.equal(sub.events[0], "message_create");
});

test("open_dm returns an existing DM and never targets yourself", async () => {
    const world = makeWorld();
    assert.deepEqual(await world.run("open_dm", { user_id: ALICE }), { channelId: DM, created: false, userId: ALICE });
    await assert.rejects(world.run("open_dm", { user_id: ME }), /yourself/);
});

test("arguments must be an object", async () => {
    const world = makeWorld();
    await assert.rejects(world.run("whoami", [1]), /must be an object/);
    await assert.rejects(world.run("get_user", { user_id: "x" }), /snowflake/);
});
