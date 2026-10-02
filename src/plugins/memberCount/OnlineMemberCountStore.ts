/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { sleep } from "@utils/misc";
import { Queue } from "@utils/Queue";
import { ChannelActionCreators, Flux, FluxDispatcher, GuildChannelStore } from "@webpack/common";

export const OnlineMemberCountStore = proxyLazy(() => {
    const preloadQueue = new Queue();

    const onlineMemberMap = new Map<string, number>();
    const pendingPreloads = new Set<string>();
    let generation = 0;
    const reset = () => {
        generation++;
        onlineMemberMap.clear();
        pendingPreloads.clear();
    };

    class OnlineMemberCountStore extends Flux.Store {
        getCount(guildId?: string) {
            if (!guildId) return undefined;
            return onlineMemberMap.get(guildId);
        }

        async _ensureCount(guildId: string) {
            if (onlineMemberMap.has(guildId)) return;
            const defaultChannel = GuildChannelStore.getDefaultChannel(guildId);
            if (!defaultChannel) return;

            await ChannelActionCreators.preload(guildId, defaultChannel.id);
        }

        ensureCount(guildId?: string) {
            if (!guildId || onlineMemberMap.has(guildId) || pendingPreloads.has(guildId)) return;

            pendingPreloads.add(guildId);
            const owner = generation;
            preloadQueue.push(() => {
                if (owner !== generation || !pendingPreloads.has(guildId)) return;
                return this._ensureCount(guildId)
                    .finally(() => { if (owner === generation) pendingPreloads.delete(guildId); })
                    .then(
                        () => sleep(200),
                        () => sleep(200)
                    );
            });
        }
    }

    return new OnlineMemberCountStore(FluxDispatcher, {
        LOGOUT: reset,
        CONNECTION_OPEN: reset,
        GUILD_DELETE({ guild }) {
            onlineMemberMap.delete(guild.id);
            pendingPreloads.delete(guild.id);
        },
        GUILD_MEMBER_LIST_UPDATE({ guildId, groups }: { guildId: string, groups: { count: number; id: string; }[]; }) {
            onlineMemberMap.set(
                guildId,
                groups.reduce((total, curr) => total + (curr.id === "offline" ? 0 : curr.count), 0)
            );
            pendingPreloads.delete(guildId);
        },
        ONLINE_GUILD_MEMBER_COUNT_UPDATE({ guildId, count }) {
            onlineMemberMap.set(guildId, count);
            pendingPreloads.delete(guildId);
        }
    });
});
