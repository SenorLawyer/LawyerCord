/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import type { MessageObject, SendMessageOptions } from "@api/MessageEvents";
import { Guild, User } from "@vencord/discord-types";
import { ChannelStore, GuildMemberStore, GuildStore, MessageStore, UserStore } from "@webpack/common";

export interface IUserExtra {
    isOwner?: boolean;
    updatedAt?: number;
}

export interface IStorageUser {
    id: string;
    username: string,
    tag: string,
    iconURL?: string;
    extra?: IUserExtra;
}

export interface GroupData {
    id: string;
    users: { [key: string]: IStorageUser; };
    name: string;
    inviteLink?: string;
}

export class Data {
    declare usersCollection: Record<string, GroupData>;
    declare _storageAutoSaveProtocol_interval: ReturnType<typeof setInterval> | undefined;
    declare _onMessagePreSend_preSend;
    private storageDirty = false;

    onMessagePreSend(channelId: string, message: MessageObject, extra: SendMessageOptions) {
        const target: { user: User; source?: Guild, extra: IUserExtra; }[] = [];
        const now = Date.now();
        const { messageReference } = extra;

        const guild = (() => {
            const channel = ChannelStore.getChannel(channelId);
            return channel?.guild_id ? GuildStore.getGuild(channel.guild_id) || undefined : undefined;
        })();

        if (messageReference) {
            const { channel_id, message_id } = messageReference;
            const message = MessageStore.getMessage(channel_id, message_id);
            if (!message) {
                return;
            }
            const { author } = message;

            target.push({ user: author, source: guild, extra: { updatedAt: now } });
        }

        if (message.content) {
            const { content } = message;
            const ids = [...content.matchAll(/<@!?(?<id>\d{17,23})>/g)].map(
                ({ groups }) => groups!.id
            );

            const users = ids
                .map(id => UserStore.getUser(id))
                .filter((user): user is User => Boolean(user));
            for (const user of users) {
                target.push({ user, source: guild, extra: { updatedAt: now } });
            }
        }

        this.processUsersToCollection(target);
    }

    processUsersToCollection(
        array: { user: User; source?: Guild; extra?: IUserExtra; }[]
    ) {
        const target = this.usersCollection;

        for (const { user, source, extra } of array) {
            if (user.bot) {
                continue;
            }

            const groupKey = source?.id ?? "dm";
            const group = (target[groupKey] ||= {
                name: source?.name || "dm",
                id: source?.id || user.id,
                users: {},
                inviteLink: undefined
            });
            const usersField = group.users;
            const previousExtra = usersField[user.id]?.extra ?? {};
            const { id, username } = user;
            const tag = user.discriminator === "0" ? user.username : user.tag;
            const iconURL = user.getAvatarURL();
            const nextExtra = { ...previousExtra, ...extra };
            const previousUser = usersField[id];

            if (
                previousUser?.username === username
                && previousUser.tag === tag
                && previousUser.iconURL === iconURL
                && previousUser.extra?.isOwner === nextExtra.isOwner
                && previousUser.extra?.updatedAt === nextExtra.updatedAt
            ) {
                continue;
            }

            usersField[id] = {
                id,
                username,
                tag,
                extra: nextExtra,
                iconURL,
            };
            this.storageDirty = true;
        }
    }

    async updateStorage(force = false) {
        if (!this.usersCollection) return;
        if (!force && !this.storageDirty) return;

        await DataStore.set("irememberyou.data", this.usersCollection);
        this.storageDirty = false;
    }

    async initializeUsersCollection() {
        const data = await DataStore.get("irememberyou.data");
        this.usersCollection = data ?? {};
    }

    writeMembersFromUserGuildsToCollection() {
        const now = Date.now();
        const LIMIT = 1_000;

        const clientId = UserStore.getCurrentUser()?.id;
        if (!clientId) {
            return;
        }
        for (const guild of Object.values(GuildStore.getGuilds())) {
            const { ownerId } = guild;
            if (ownerId !== clientId) {
                continue;
            }

            const members = GuildMemberStore.getMembers(guild.id).slice(0, LIMIT);
            const target: { user: User; source?: Guild, extra: IUserExtra; }[] = [];

            for (const member of members) {
                const user = UserStore.getUser(member.userId);
                if (user) target.push({ user, source: guild, extra: { updatedAt: now } });
            }

            this.processUsersToCollection(target);
        }
    }

    writeGuildsOwnersToCollection() {
        const target: Set<{ user: User; source?: Guild; extra: IUserExtra; }> =
            new Set();
        const now = Date.now();

        for (const guild of Object.values(GuildStore.getGuilds())) {
            const { ownerId } = guild;
            const owner = UserStore.getUser(ownerId);
            if (!owner) {
                continue;
            }
            target.add({
                user: owner,
                source: guild,
                extra: { isOwner: true, updatedAt: now },
            });
        }

        this.processUsersToCollection([...target]);
    }

    storageAutoSaveProtocol() {
        this.stopStorageAutoSaveProtocol();
        this._storageAutoSaveProtocol_interval = setInterval(() => void this.updateStorage(), 60_000 * 3);
    }

    stopStorageAutoSaveProtocol() {
        if (!this._storageAutoSaveProtocol_interval) return;

        clearInterval(this._storageAutoSaveProtocol_interval);
        this._storageAutoSaveProtocol_interval = undefined;
    }

    stop() {
        this.stopStorageAutoSaveProtocol();
        void this.updateStorage(true);
    }
}
