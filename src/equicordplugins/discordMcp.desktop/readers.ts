/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchUserProfile } from "@utils/discord";
import { sleep } from "@utils/misc";
import type { Channel } from "@vencord/discord-types";
import {
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    GuildMemberCountStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    IconUtils,
    PermissionsBits,
    PermissionStore,
    PresenceStore,
    ReadStateStore,
    RelationshipStore,
    SnowflakeUtils,
    UserProfileStore,
    UserStore,
    VoiceStateStore,
} from "@webpack/common";

import {
    type Args,
    currentUserId,
    fetchMessage,
    fetchUserRecord,
    requireChannel,
    requireGuild,
    snowflakeCompare,
    type ToolEnv,
} from "./context";
import { DISCORD_MCP_TOOL_NAMES, GATES, normalizeBoundedInteger, optionalText, requireOneOf, requireSnowflake, requireText } from "./policy";
import { api, bodyRecord, routes } from "./rest";
import {
    channelTypeName,
    colorHex,
    computeMemberPermissions,
    isRaw,
    permissionNames,
    presenceOf,
    type Raw,
    relationshipName,
    serializeActivity,
    serializeChannel,
    serializeChannelDetails,
    serializeGuild,
    serializeMember,
    serializeMessage,
    serializeRole,
    serializeUser,
    str,
    truncate,
} from "./serialize";
import { listSubscriptions } from "./subscriptions";

const FORUM_TYPES: number[] = [15, 16];
const MEMBER_SEARCH_SETTLE_MS = 900;
const MEMBER_SEARCH_GAP_MS = 1_000;
let lastMemberSearch = 0;

function canView(channel: Channel): boolean {
    return PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel);
}

function myChannelAccess(channel: Channel) {
    return {
        viewChannel: PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel),
        sendMessages: PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel),
        readMessageHistory: PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, channel),
        addReactions: PermissionStore.can(PermissionsBits.ADD_REACTIONS, channel),
        attachFiles: PermissionStore.can(PermissionsBits.ATTACH_FILES, channel),
        manageMessages: PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel),
    };
}

export function connectionStatus(_: Args, env: ToolEnv) {
    const user = UserStore.getCurrentUser();
    const { settings } = env;
    const gates = Object.fromEntries(Object.entries(GATES).map(([name, gate]) => [name, {
        enabled: settings[gate.setting],
        setting: gate.label,
        allows: gate.what,
    }]));
    return {
        connected: Boolean(user),
        currentUser: serializeUser(user),
        channelAccess: "all_accessible_channels",
        toolCount: DISCORD_MCP_TOOL_NAMES.length,
        capabilities: {
            allAccessibleChannels: true,
            changesActiveView: false,
            silentBackground: true,
            subscriptions: true,
            messageSearch: true,
            messageWrites: true,
            membershipChanges: settings.allowMembershipActions,
            relationshipChanges: settings.allowRelationshipActions,
            blocking: settings.allowRelationshipActions,
            accountChanges: settings.allowAccountActions,
            moderation: settings.allowModerationActions,
            roleChanges: settings.allowRoleActions,
            channelManagement: settings.allowChannelManagement,
            arbitraryRequests: false,
            mentions: "opt_in_per_message",
        },
        gates,
        writeRateLimits: {
            perChannel: { per10Seconds: settings.channelBurstLimit, perHour: settings.channelHourlyLimit },
            global: { per10Seconds: settings.globalBurstLimit, perHour: settings.globalHourlyLimit },
        },
        guildCount: GuildStore.getGuildCount(),
        subscriptionCount: listSubscriptions().count,
    };
}

export function whoami() {
    const user = UserStore.getCurrentUser();
    const activities = PresenceStore.getActivities(user.id).map(serializeActivity);
    return {
        user: serializeUser(user),
        createdAt: new Date(SnowflakeUtils.extractTimestamp(user.id)).toISOString(),
        premiumType: user.premiumType ?? 0,
        status: PresenceStore.getStatus(user.id) ?? "offline",
        customStatus: activities.find(activity => activity.type === 4) ?? null,
        activities: activities.filter(activity => activity.type !== 4),
        guildCount: GuildStore.getGuildCount(),
        friendCount: RelationshipStore.getFriendCount(),
        dmCount: ChannelStore.getSortedPrivateChannels().length,
    };
}

export function listServers(args: Args) {
    const query = optionalText(args.query, "query", 100)?.toLowerCase();
    const servers = Object.values(GuildStore.getGuilds())
        .filter(guild => !query || guild.name.toLowerCase().includes(query))
        .map(serializeGuild)
        .sort((a, b) => a.name.localeCompare(b.name));
    return { servers, count: servers.length };
}

export function getServer(args: Args) {
    const guild = requireGuild(args.guild_id);
    const channels = GuildChannelStore.getChannels(guild.id);
    const categories = (channels?.[4] ?? []).map(entry => entry.channel).filter(canView);
    const selectable = (channels?.SELECTABLE ?? []).map(entry => ("channel" in entry ? entry.channel : entry)).filter(canView);
    const vocal = (channels?.VOCAL ?? []).map(entry => entry.channel).filter(canView);
    const self = GuildMemberStore.getSelfMember(guild.id);
    const owner = UserStore.getUser(guild.ownerId);
    return {
        ...serializeGuild(guild),
        owner: owner ? serializeUser(owner) : { id: guild.ownerId },
        onlineCount: GuildMemberCountStore.getOnlineCount(guild.id) ?? null,
        vanityUrlCode: guild.vanityURLCode ?? null,
        verificationLevel: guild.verificationLevel,
        nsfwLevel: guild.nsfwLevel,
        mfaLevel: guild.mfaLevel,
        joinedAt: guild.joinedAt instanceof Date ? guild.joinedAt.toISOString() : null,
        rulesChannelId: guild.rulesChannelId ?? null,
        systemChannelId: guild.systemChannelId ?? null,
        afkChannelId: guild.afkChannelId ?? null,
        channelSummary: {
            categories: categories.map(category => ({ id: category.id, name: category.name })),
            textLike: selectable.length,
            voiceLike: vocal.length,
        },
        roles: GuildRoleStore.getSortedRoles(guild.id).slice(0, 100).map(role => ({
            id: role.id, name: role.name, color: colorHex(role.color), position: role.position, managed: role.managed,
        })),
        roleCount: GuildRoleStore.getNumRoles(guild.id),
        you: self ? {
            ...serializeMember(guild.id, self),
            permissions: permissionNames(computeMemberPermissions(guild.id, currentUserId(), self.roles)),
        } : null,
    };
}

export function listRoles(args: Args) {
    const guild = requireGuild(args.guild_id);
    const roles = GuildRoleStore.getSortedRoles(guild.id).map(serializeRole);
    return { guildId: guild.id, roles, count: roles.length };
}

export function getRole(args: Args) {
    const guild = requireGuild(args.guild_id);
    const role = GuildRoleStore.getRole(guild.id, requireSnowflake(args.role_id, "role_id"));
    if (!role) throw new Error("Role was not found in that server");
    const holders = GuildMemberStore.getMembers(guild.id).filter(member => member.roles.includes(role.id));
    return {
        ...serializeRole(role),
        permissionNames: permissionNames(role.permissions),
        cachedMemberCount: holders.length,
        sampleMembers: holders.slice(0, 25).map(member => serializeUser(UserStore.getUser(member.userId) ?? { id: member.userId })),
    };
}

export function listServerChannels(args: Args) {
    const guild = requireGuild(args.guild_id);
    const groups = GuildChannelStore.getChannels(guild.id);
    const unique = new Map<string, Channel>();
    for (const entry of [...(groups?.SELECTABLE ?? []), ...(groups?.VOCAL ?? []), ...(groups?.[4] ?? [])]) {
        const channel = "channel" in entry ? entry.channel : entry;
        if (channel?.id && canView(channel)) unique.set(channel.id, channel);
    }
    if (args.include_threads === true) {
        for (const thread of ChannelStore.getAllThreadsForGuild(guild.id))
            if (!thread.threadMetadata?.archived && canView(thread)) unique.set(thread.id, thread);
    }

    const categories = new Map([...unique.values()].filter(channel => channel.type === 4).map(channel => [channel.id, channel]));
    const order = (channel: Channel) => channel.type === 4 ? channel.position : (categories.get(channel.parent_id)?.position ?? -1);
    const channels = [...unique.values()]
        .sort((a, b) => order(a) - order(b) || (a.type === 4 ? -1 : b.type === 4 ? 1 : 0) || a.position - b.position || (a.name ?? "").localeCompare(b.name ?? ""))
        .map(channel => ({
            ...serializeChannel(channel),
            categoryName: categories.get(channel.parent_id)?.name ?? null,
            canSend: channel.type === 4 ? false : PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel),
        }));
    return { guildId: guild.id, channels, count: channels.length };
}

export async function getChannel(args: Args) {
    const info = await requireChannel(args.channel_id);
    const { record } = info;
    const unread = ReadStateStore.getUnreadCount(info.id);
    const parent = record?.parent_id ? ChannelStore.getChannel(record.parent_id) : null;
    return {
        ...serializeChannelDetails(info.object),
        parent: parent ? { id: parent.id, name: parent.name, type: channelTypeName(parent.type) } : null,
        categoryName: record && record.type !== 4 && record.parent_id ? ChannelStore.getChannel(record.parent_id)?.name ?? null : null,
        you: record && info.guildId ? myChannelAccess(record) : null,
        unread: { hasUnread: ReadStateStore.hasUnread(info.id), unreadCount: unread, mentionCount: ReadStateStore.getMentionCount(info.id) },
        voiceOccupantCount: record && (record.type === 2 || record.type === 13) ? Object.keys(VoiceStateStore.getVoiceStatesForChannel(info.id)).length : null,
    };
}

export async function listThreads(args: Args, env: ToolEnv) {
    const limit = normalizeBoundedInteger(args.limit, "limit", 25, 1, 50);
    const offset = normalizeBoundedInteger(args.offset, "offset", 0, 0, 5_000);
    const archived = args.archived === true;
    if (args.channel_id === undefined && args.guild_id === undefined) throw new Error("channel_id or guild_id is required");

    if (archived) {
        const channel = await requireChannel(args.channel_id);
        const body = bodyRecord(await api("get", {
            url: routes.threadsSearch(channel.id),
            query: { archived: true, limit, offset, sort_by: "last_message_time", sort_order: "desc" },
        }, env.check), "thread list");
        const threads = Array.isArray(body.threads) ? body.threads.filter(isRaw) : [];
        const firstMessages = Array.isArray(body.first_messages) ? body.first_messages.filter(isRaw) : [];
        return {
            archived: true,
            channelId: channel.id,
            threads: threads.map(thread => {
                const first = firstMessages.find(message => String(message.id) === String(thread.id));
                return { ...serializeChannelDetails(thread), firstMessage: first ? serializeMessage(first) : null };
            }),
            count: threads.length,
            hasMore: Boolean(body.has_more),
            nextOffset: body.has_more ? offset + threads.length : null,
            totalResults: typeof body.total_results === "number" ? body.total_results : null,
        };
    }

    const source = args.channel_id !== undefined
        ? ChannelStore.getAllThreadsForParent((await requireChannel(args.channel_id)).id)
        : ChannelStore.getAllThreadsForGuild(requireGuild(args.guild_id).id);
    const active = source
        .filter(thread => !thread.threadMetadata?.archived && canView(thread))
        .sort((a, b) => snowflakeCompare(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id));
    const page = active.slice(offset, offset + limit);
    return {
        archived: false,
        threads: page.map(serializeChannelDetails),
        count: page.length,
        hasMore: offset + limit < active.length,
        nextOffset: offset + limit < active.length ? offset + limit : null,
        totalResults: active.length,
    };
}

export async function getForumTags(args: Args) {
    const info = await requireChannel(args.channel_id);
    if (!FORUM_TYPES.includes(info.type)) throw new Error("channel_id must be a forum or media channel");
    const details = serializeChannelDetails(info.object);
    const channel = info.object as Raw;
    const emoji = channel.defaultReactionEmoji ?? channel.default_reaction_emoji;
    return {
        channelId: info.id,
        tags: details.availableTags ?? [],
        requiresTag: details.requiresTag,
        defaultReactionEmoji: isRaw(emoji) ? str(emoji.emojiName ?? emoji.emoji_name) : null,
        defaultSortOrder: channel.defaultSortOrder ?? channel.default_sort_order ?? null,
        defaultLayout: channel.defaultForumLayout ?? channel.default_forum_layout ?? null,
    };
}

export function listDms(args: Args) {
    const query = optionalText(args.query, "query", 100)?.toLowerCase();
    const limit = normalizeBoundedInteger(args.limit, "limit", 100, 1, 500);
    const dms = ChannelStore.getSortedPrivateChannels().map(channel => {
        const rawRecipients = new Map((channel.rawRecipients ?? []).map(recipient => [recipient.id, recipient]));
        const recipients = (channel.recipients ?? [])
            .map(userId => serializeUser(UserStore.getUser(userId) ?? rawRecipients.get(userId)))
            .filter(user => user != null);
        return {
            ...serializeChannel(channel),
            displayName: channel.name || recipients.map(user => user.displayName).join(", "),
            recipients,
            hasUnread: ReadStateStore.hasUnread(channel.id),
            mentionCount: ReadStateStore.getMentionCount(channel.id),
        };
    }).filter(dm => !query || dm.displayName.toLowerCase().includes(query));
    return { dms: dms.slice(0, limit), count: Math.min(dms.length, limit), total: dms.length };
}

export function getVoiceOccupants(args: Args) {
    const occupant = (userId: string, state: { mute: boolean; deaf: boolean; selfMute: boolean; selfDeaf: boolean; selfVideo: boolean; selfStream: boolean | undefined; suppress: boolean; }, guildId: string | null) => ({
        user: serializeUser(UserStore.getUser(userId) ?? { id: userId }),
        nick: guildId ? GuildMemberStore.getNick(guildId, userId) : null,
        serverMuted: state.mute,
        serverDeafened: state.deaf,
        selfMuted: state.selfMute,
        selfDeafened: state.selfDeaf,
        video: state.selfVideo,
        streaming: Boolean(state.selfStream),
        suppressed: state.suppress,
    });

    if (args.channel_id !== undefined) {
        const channel = ChannelStore.getChannel(requireSnowflake(args.channel_id, "channel_id"));
        if (!channel) throw new Error("Channel is not available to the authenticated Discord account");
        const guildId = channel.guild_id || null;
        const occupants = Object.entries(VoiceStateStore.getVoiceStatesForChannel(channel.id)).map(([userId, state]) => occupant(userId, state, guildId));
        return { channels: [{ channel: serializeChannel(channel), occupants, count: occupants.length }] };
    }

    const guild = requireGuild(args.guild_id);
    const byChannel = new Map<string, ReturnType<typeof occupant>[]>();
    for (const [userId, state] of Object.entries(VoiceStateStore.getVoiceStates(guild.id))) {
        if (!state.channelId) continue;
        byChannel.set(state.channelId, [...byChannel.get(state.channelId) ?? [], occupant(userId, state, guild.id)]);
    }
    const channels = [...byChannel.entries()].flatMap(([channelId, occupants]) => {
        const channel = ChannelStore.getChannel(channelId);
        return channel && canView(channel) ? [{ channel: serializeChannel(channel), occupants, count: occupants.length }] : [];
    });
    return { channels };
}

export async function getUser(args: Args) {
    const userId = requireSnowflake(args.user_id, "user_id");
    const user = await fetchUserRecord(userId);
    return {
        user: serializeUser(user),
        createdAt: new Date(SnowflakeUtils.extractTimestamp(userId)).toISOString(),
        relationship: relationshipName(userId),
        friendNickname: RelationshipStore.getNickname(userId) ?? null,
        presence: presenceOf(userId),
        dmChannelId: ChannelStore.getDMFromUserId(userId) ?? null,
        sharedGuildIds: GuildMemberStore.memberOf(userId),
    };
}

export async function getUserProfile(args: Args, env: ToolEnv) {
    const userId = requireSnowflake(args.user_id, "user_id");
    const guildId = args.guild_id === undefined ? undefined : requireGuild(args.guild_id).id;
    const profile = await fetchUserProfile(userId, { with_mutual_guilds: true, with_mutual_friends_count: true, ...(guildId ? { guild_id: guildId } : {}) });
    env.check();
    if (!profile) throw new Error("Profile is not available for that user");
    const bio = truncate(profile.bio ?? "", 2_000);
    const guildProfile = guildId ? UserProfileStore.getGuildMemberProfile(userId, guildId) : null;
    const member = guildId ? GuildMemberStore.getMember(guildId, userId) : null;
    return {
        user: serializeUser(UserStore.getUser(userId) ?? { id: userId }),
        bio: bio.text,
        bioTruncated: bio.truncated,
        pronouns: profile.pronouns || null,
        accentColor: colorHex(profile.accentColor),
        bannerUrl: profile.banner ? IconUtils.getUserBannerURL({ id: userId, banner: profile.banner, size: 512, canAnimate: false }) ?? null : null,
        badges: profile.badges.map(badge => ({ id: badge.id, description: badge.description })),
        connections: (profile.connectedAccounts ?? []).map(account => ({ type: account.type, name: account.name, verified: account.verified })),
        premiumSince: profile.premiumSince instanceof Date ? profile.premiumSince.toISOString() : null,
        mutualGuilds: (UserProfileStore.getMutualGuilds(userId) ?? []).map(mutual => ({ id: mutual.guild.id, name: mutual.guild.name, nick: mutual.nick })),
        mutualFriendsCount: UserProfileStore.getMutualFriendsCount(userId) ?? null,
        serverProfile: guildProfile ? { bio: truncate(guildProfile.bio ?? "", 2_000).text, pronouns: guildProfile.pronouns || null } : null,
        member: member ? serializeMember(guildId as string, member) : null,
        relationship: relationshipName(userId),
    };
}

function matchScore(needle: string, value: string | null | undefined): number {
    if (!value) return 0;
    const text = value.toLowerCase();
    if (text === needle) return 100;
    if (text.startsWith(needle)) return 80;
    if (text.split(/[\s._-]+/).some(word => word.startsWith(needle))) return 60;
    return text.includes(needle) ? 40 : 0;
}

export function findUsers(args: Args) {
    const query = requireText(args.query, "query", 100, 1).toLowerCase();
    const guildId = args.guild_id === undefined ? undefined : requireGuild(args.guild_id).id;
    const limit = normalizeBoundedInteger(args.limit, "limit", 20, 1, 50);
    const found = new Map<string, { score: number; matchedOn: Set<string>; nick: string | null; }>();

    const consider = (userId: string, fields: Array<[string, string | null | undefined]>, nick: string | null = null) => {
        let best = 0;
        const matched = new Set<string>();
        for (const [label, value] of fields) {
            const score = matchScore(query, value);
            if (score > 0) matched.add(label);
            best = Math.max(best, score);
        }
        if (best === 0) return;
        const existing = found.get(userId);
        if (existing) {
            existing.score = Math.max(existing.score, best);
            matched.forEach(label => existing.matchedOn.add(label));
            existing.nick ??= nick;
        } else found.set(userId, { score: best, matchedOn: matched, nick });
    };
    const userFields = (userId: string): Array<[string, string | null | undefined]> => {
        const user = UserStore.getUser(userId);
        return user ? [["username", user.username], ["globalName", user.globalName]] : [];
    };

    for (const id of RelationshipStore.getFriendIDs())
        consider(id, [...userFields(id), ["friendNickname", RelationshipStore.getNickname(id)]]);
    for (const id of ChannelStore.getDMUserIds()) consider(id, userFields(id));
    if (guildId) {
        for (const member of GuildMemberStore.getMembers(guildId))
            consider(member.userId, [...userFields(member.userId), ["serverNickname", member.nick]], member.nick ?? null);
    } else {
        for (const user of Object.values(UserStore.getUsers())) consider(user.id, userFields(user.id));
    }

    const results = [...found.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit)
        .map(([userId, match]) => ({
            user: serializeUser(UserStore.getUser(userId)),
            matchedOn: [...match.matchedOn],
            serverNickname: match.nick,
            relationship: relationshipName(userId),
            status: PresenceStore.getStatus(userId) ?? "offline",
        }));
    return {
        query,
        guildId: guildId ?? null,
        users: results,
        count: results.length,
        note: "Only users Discord has already cached are searched. Use discord_search_members for a server-wide lookup.",
    };
}

function memberMatches(guildId: string, query: string, limit: number) {
    const needle = query.toLowerCase();
    const matches: Array<{ score: number; userId: string; }> = [];
    for (const member of GuildMemberStore.getMembers(guildId)) {
        const user = UserStore.getUser(member.userId);
        const score = Math.max(matchScore(needle, user?.username), matchScore(needle, user?.globalName), matchScore(needle, member.nick));
        if (score > 0) matches.push({ score, userId: member.userId });
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchMembers(args: Args, env: ToolEnv) {
    const guild = requireGuild(args.guild_id);
    const query = requireText(args.query, "query", 100, 1);
    const limit = normalizeBoundedInteger(args.limit, "limit", 25, 1, 100);
    const wait = MEMBER_SEARCH_GAP_MS - (Date.now() - lastMemberSearch);
    if (wait > 0) await sleep(wait);
    env.check();
    lastMemberSearch = Date.now();
    FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guild.id], query, limit });
    await sleep(MEMBER_SEARCH_SETTLE_MS);
    env.check();

    const members = memberMatches(guild.id, query, limit).flatMap(({ userId }) => {
        const member = GuildMemberStore.getMember(guild.id, userId);
        return member ? [{ user: serializeUser(UserStore.getUser(userId) ?? { id: userId }), member: serializeMember(guild.id, member) }] : [];
    });
    return { guildId: guild.id, query, members, count: members.length };
}

export async function getMember(args: Args, env: ToolEnv) {
    const guild = requireGuild(args.guild_id);
    const userId = requireSnowflake(args.user_id, "user_id");
    let member = GuildMemberStore.getMember(guild.id, userId);
    if (!member) {
        await fetchUserProfile(userId, { guild_id: guild.id }, false).catch(() => undefined);
        env.check();
        member = GuildMemberStore.getMember(guild.id, userId);
    }
    if (!member) throw new Error("That user is not a member of this server, or Discord has not shared the member with this client");
    const channel = args.channel_id === undefined ? undefined : (await requireChannel(args.channel_id)).record ?? undefined;
    const permissions = computeMemberPermissions(guild.id, userId, member.roles, channel);
    const topRole = member.roles.map(roleId => GuildRoleStore.getRole(guild.id, roleId)).filter(role => role != null).sort((a, b) => b.position - a.position)[0];
    return {
        user: serializeUser(UserStore.getUser(userId) ?? { id: userId }),
        member: serializeMember(guild.id, member),
        isOwner: guild.ownerId === userId,
        highestRole: topRole ? { id: topRole.id, name: topRole.name } : null,
        presence: presenceOf(userId, guild.id),
        permissions: { scope: channel ? "channel" : "server", channelId: channel?.id ?? null, bits: String(permissions), names: permissionNames(permissions) },
    };
}

export async function getMessageUsers(args: Args) {
    const channel = await requireChannel(args.channel_id);
    const message = await fetchMessage(channel.id, requireSnowflake(args.message_id, "message_id"));
    const { guildId } = channel;
    const describe = (user: unknown, replyTarget = false) => {
        if (!isRaw(user)) return null;
        const id = String(user.id);
        const member = guildId ? GuildMemberStore.getMember(guildId, id) : null;
        return { user: serializeUser(user), member: member ? serializeMember(guildId as string, member) : null, relationship: relationshipName(id), replyTarget };
    };
    const referenced = isRaw(message.referenced_message) ? message.referenced_message : null;
    const roleIds = Array.isArray(message.mention_roles) ? message.mention_roles.map(String) : [];
    return {
        messageId: String(message.id),
        channelId: channel.id,
        author: describe(message.author),
        mentions: (Array.isArray(message.mentions) ? message.mentions.slice(0, 25) : []).map(user => describe(user)).filter(entry => entry != null),
        mentionRoles: guildId ? roleIds.flatMap((roleId): Array<{ id: string; name: string | null; }> => {
            const role = GuildRoleStore.getRole(guildId, roleId);
            return role ? [{ id: role.id, name: role.name }] : [{ id: roleId, name: null }];
        }) : [],
        mentionEveryone: Boolean(message.mention_everyone),
        replyTarget: referenced ? describe(referenced.author, true) : null,
    };
}

const RELATIONSHIP_TYPES = { friends: 1, blocked: 2, pending_incoming: 3, pending_outgoing: 4 } as const;

export function listRelationships(args: Args) {
    const kind = requireOneOf(args.type, "type", ["friends", "blocked", "pending_incoming", "pending_outgoing", "ignored"] as const, "friends");
    const limit = normalizeBoundedInteger(args.limit, "limit", 100, 1, 500);
    const offset = normalizeBoundedInteger(args.offset, "offset", 0, 0, 100_000);
    const ids = kind === "ignored"
        ? RelationshipStore.getIgnoredIDs()
        : [...RelationshipStore.getMutableRelationships()].filter(([, type]) => type === RELATIONSHIP_TYPES[kind]).map(([id]) => id);
    const page = ids.slice(offset, offset + limit).map(userId => ({
        user: serializeUser(UserStore.getUser(userId) ?? { id: userId }),
        since: RelationshipStore.getSince(userId) ?? null,
        nickname: RelationshipStore.getNickname(userId) ?? null,
        status: kind === "friends" ? PresenceStore.getStatus(userId) ?? "offline" : undefined,
    }));
    return {
        type: kind,
        relationships: page,
        count: page.length,
        total: ids.length,
        hasMore: offset + limit < ids.length,
        nextOffset: offset + limit < ids.length ? offset + limit : null,
    };
}

export function getPresence(args: Args) {
    const userId = requireSnowflake(args.user_id, "user_id");
    const guildId = args.guild_id === undefined ? undefined : requireGuild(args.guild_id).id;
    return { userId, guildId: guildId ?? null, ...presenceOf(userId, guildId) };
}

export function listUnread(args: Args) {
    const guildId = args.guild_id === undefined ? undefined : requireSnowflake(args.guild_id, "guild_id");
    const limit = normalizeBoundedInteger(args.limit, "limit", 50, 1, 200);
    const mentionsOnly = args.mentions_only === true;
    const seen = new Set<string>();
    const entries = ReadStateStore.getAllReadStates(true).flatMap(state => {
        const channel = ChannelStore.getChannel(state.channelId);
        if (!channel || seen.has(channel.id) || (guildId && channel.guild_id !== guildId)) return [];
        seen.add(channel.id);
        const mentionCount = ReadStateStore.getMentionCount(channel.id);
        const hasUnread = ReadStateStore.hasUnread(channel.id);
        if (mentionCount === 0 && (mentionsOnly || !hasUnread)) return [];
        return [{
            channel: serializeChannel(channel),
            guildName: channel.guild_id ? GuildStore.getGuild(channel.guild_id)?.name ?? null : null,
            mentionCount,
            unreadCount: ReadStateStore.getUnreadCount(channel.id),
            ackMessageId: ReadStateStore.ackMessageId(channel.id),
            oldestUnreadMessageId: ReadStateStore.getOldestUnreadMessageId(channel.id),
        }];
    }).sort((a, b) => b.mentionCount - a.mentionCount || snowflakeCompare(b.channel.lastMessageId ?? "0", a.channel.lastMessageId ?? "0"));
    return { channels: entries.slice(0, limit), count: Math.min(entries.length, limit), total: entries.length, mentionsOnly };
}
