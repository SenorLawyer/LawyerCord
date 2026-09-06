/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Guild } from "@vencord/discord-types";
import { findStoreLazy, proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher, GuildStore } from "@webpack/common";

export const HiddenServersStore = proxyLazyWebpack(() => {
    const { Store } = Flux;

    const SortedGuildStore = findStoreLazy("SortedGuildStore");
    const DB_KEY = "HideServers_servers";
    const SAVE_DEBOUNCE_MS = 250;

    let loadGeneration = 0;
    let saveTimeout: ReturnType<typeof setTimeout> | undefined;

    class HiddenServersStore extends Store {
        public _hiddenGuilds: Set<string> = new Set();

        public get hiddenGuilds() { return this._hiddenGuilds; }

        public async load() {
            const generation = ++loadGeneration;
            const data = await DataStore.get<Set<string> | string[]>(DB_KEY);
            if (generation !== loadGeneration) return;

            if (data instanceof Set) {
                this._hiddenGuilds = new Set(Array.from(data).filter(id => typeof id === "string"));
            } else if (Array.isArray(data)) {
                this._hiddenGuilds = new Set(data.filter(id => typeof id === "string"));
            } else {
                this._hiddenGuilds = new Set();
            }

            this.emitChange();
        }

        public unload() {
            loadGeneration++;
            flushSave();
            this._hiddenGuilds = new Set();
        }

        public save() {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
        }

        public addHiddenGuild(id: string) {
            if (this._hiddenGuilds.has(id)) return;

            const next = new Set(this._hiddenGuilds);
            next.add(id);
            replaceHiddenGuilds(next);
        }

        public removeHiddenGuild(id: string) {
            if (!this._hiddenGuilds.has(id)) return;

            const next = new Set(this._hiddenGuilds);
            next.delete(id);
            replaceHiddenGuilds(next);
        }

        public addHiddenFolder(id: string, guildIds: string[]) {
            const next = new Set(this._hiddenGuilds);
            next.add(`folder-${id}`);
            guildIds.forEach(gid => next.add(gid));
            replaceHiddenGuilds(next);
        }

        public removeHiddenFolder(id: string, guildIds: string[]) {
            const next = new Set(this._hiddenGuilds);
            next.delete(`folder-${id}`);
            guildIds.forEach(gid => next.delete(gid));
            replaceHiddenGuilds(next);
        }

        public clearHidden() {
            if (saveTimeout) {
                clearTimeout(saveTimeout);
                saveTimeout = undefined;
            }

            this._hiddenGuilds = new Set();
            void DataStore.del(DB_KEY);
            this.emitChange();
        }

        public hiddenGuildsDetail(): Guild[] {
            const sortedGuildIds = SortedGuildStore.getFlattenedGuildIds() as string[];
            // otherwise the list is in order of increasing id number which is confusing
            return sortedGuildIds
                .filter(id => this._hiddenGuilds.has(id))
                .map(id => GuildStore.getGuild(id))
                .filter((guild): guild is Guild => Boolean(guild));
        }
    }

    function flushSave() {
        if (saveTimeout === undefined) return;
        clearTimeout(saveTimeout);
        saveTimeout = undefined;

        void DataStore.set(DB_KEY, Array.from(store._hiddenGuilds));
    }

    function replaceHiddenGuilds(next: Set<string>) {
        store._hiddenGuilds = next;
        store.save();
        store.emitChange();
    }

    const store = new HiddenServersStore(FluxDispatcher);
    return store;
});
