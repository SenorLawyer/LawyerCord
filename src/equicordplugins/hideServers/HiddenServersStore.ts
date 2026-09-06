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

    class HiddenServersStore extends Store {
        public _hiddenGuilds: Set<string> = new Set();
        private loadGeneration = 0;
        private saveTimeout: ReturnType<typeof setTimeout> | undefined;

        public get hiddenGuilds() { return this._hiddenGuilds; }

        public async load() {
            const generation = ++this.loadGeneration;
            const data = await DataStore.get<Set<string> | string[]>(DB_KEY);
            if (generation !== this.loadGeneration) return;

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
            this.loadGeneration++;
            this.flushSave();
            this._hiddenGuilds = new Set();
        }

        public save() {
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
        }

        private flushSave() {
            if (this.saveTimeout === undefined) return;
            clearTimeout(this.saveTimeout);
            this.saveTimeout = undefined;

            void DataStore.set(DB_KEY, Array.from(this._hiddenGuilds));
        }

        private replaceHiddenGuilds(next: Set<string>) {
            this._hiddenGuilds = next;
            this.save();
            this.emitChange();
        }

        public addHiddenGuild(id: string) {
            if (this._hiddenGuilds.has(id)) return;

            const next = new Set(this._hiddenGuilds);
            next.add(id);
            this.replaceHiddenGuilds(next);
        }

        public removeHiddenGuild(id: string) {
            if (!this._hiddenGuilds.has(id)) return;

            const next = new Set(this._hiddenGuilds);
            next.delete(id);
            this.replaceHiddenGuilds(next);
        }

        public addHiddenFolder(id: string, guildIds: string[]) {
            const next = new Set(this._hiddenGuilds);
            next.add(`folder-${id}`);
            guildIds.forEach(gid => next.add(gid));
            this.replaceHiddenGuilds(next);
        }

        public removeHiddenFolder(id: string, guildIds: string[]) {
            const next = new Set(this._hiddenGuilds);
            next.delete(`folder-${id}`);
            guildIds.forEach(gid => next.delete(gid));
            this.replaceHiddenGuilds(next);
        }

        public clearHidden() {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = undefined;
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

    return new HiddenServersStore(FluxDispatcher);
});
