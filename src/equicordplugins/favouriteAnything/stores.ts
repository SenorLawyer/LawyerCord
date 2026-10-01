/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { proxyLazyWebpack } from "@webpack";
import { Constants, Flux, FluxDispatcher, RestAPI, UserStore } from "@webpack/common";

import { RefreshedUrlsResponse } from "./types";
import { isAllowedHost } from "./utils";

const logger = new Logger("FavouriteAnything");

export interface SignedUrlsStoreType {
    get(url: string): string | null;
    addSigned(url: string): void;
    refresh(url: string): void;
    start(): void;
    stop(): void;
    reset(): void;
}

/** Used for storing and automatically refreshing signed CDN/Media proxy urls ({@link https://docs.discord.food/reference#signed-attachment-urls}). */
export const SignedUrlsStore = proxyLazyWebpack(() => {
    class SignedUrlsStoreClass extends Flux.Store implements SignedUrlsStoreType {
        public static readonly _expirationThreshold = 60 * 60 * 1000;

        public _urls = new Map<string, string>();
        private pending = new Set<string>();
        private inFlight = new Set<string>();
        private timer: ReturnType<typeof setTimeout> | undefined;
        private active = false;
        private generation = 0;
        private owner: string | undefined;

        public start() {
            this.active = true;
            this.reset();
        }

        public stop() {
            this.active = false;
            this.reset();
        }

        public reset() {
            this.generation++;
            this.owner = UserStore.getCurrentUser()?.id;
            clearTimeout(this.timer);
            this.timer = undefined;
            this.pending.clear();
            this.inFlight.clear();
            this._urls.clear();
            this.emitChange();
        }

        private isCurrent(generation = this.generation) {
            return this.active && generation === this.generation && !!this.owner && this.owner === UserStore.getCurrentUser()?.id;
        }

        __getLocalVars() {
            return { urls: this._urls };
        }

        public get(url: string): string | null {
            const key = URL.parse(url);
            if (!this.isCurrent() || !this._isValid(key)) return null;
            const value = this._urls.get(`${this._clean(key)}`);
            const signed = URL.parse(value ?? "");
            return signed && !this._willExpire(signed) ? value ?? null : null;
        }

        public addSigned(url: string): void {
            const parsed = URL.parse(url);
            if (!this.isCurrent() || !this._isValid(parsed)) return;

            if (this._willExpire(parsed)) this.refresh(url);
            else this._update([[`${this._clean(parsed)}`, url]]);
        }

        public refresh(value: string): void {
            const url = URL.parse(value);
            if (!this.isCurrent() || !this._isValid(url)) return;
            const key = `${this._clean(url)}`;
            const cached = URL.parse(this._urls.get(key) ?? value);
            if (cached && !this._willExpire(cached)) return;
            if (this.inFlight.has(key)) return;
            this.pending.add(key);
            this.schedule();
        }

        private schedule() {
            if (!this.isCurrent() || !this.pending.size || this.inFlight.size || this.timer !== undefined) return;
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this._handleBatch();
            }, 50);
        }

        public _clean(url: URL): URL {
            const clean = new URL(url);
            clean.search = "";
            clean.hash = "";
            return clean;
        }

        public _isValid(url: URL | null): url is URL {
            return !!(url && url.protocol === "https:" && !url.port && !url.username && !url.password && isAllowedHost(url.hostname));
        }

        public _willExpire(url: URL): boolean {
            const expiryTimestamp = parseInt(url.searchParams.get("ex") ?? "", 16) * 1000;
            return isNaN(expiryTimestamp) || expiryTimestamp - SignedUrlsStoreClass._expirationThreshold < Date.now();
        }

        public _update(urls: [string, string | null][]): void {
            let hasChanged: boolean = false;

            for (const [url, value] of urls) {
                if (!value || url === value || this._urls.get(url) === value) continue;

                this._urls.set(url, value);
                if (this._urls.size > 1000) {
                    const oldest = this._urls.keys().next().value;
                    if (oldest !== undefined) this._urls.delete(oldest);
                }
                hasChanged = true;
            }

            if (hasChanged) this.emitChange();
        }

        private async _handleBatch(): Promise<void> {
            if (!this.isCurrent()) return;
            const { generation } = this;
            const batch = [...this.pending].slice(0, 50);
            for (const url of batch) {
                this.pending.delete(url);
                this.inFlight.add(url);
            }
            try {
                const { body }: { body: RefreshedUrlsResponse; } = await RestAPI.post({
                    url: Constants.Endpoints.ATTACHMENTS_REFRESH_URLS,
                    body: { attachment_urls: batch },
                    retries: 3
                });
                if (this.isCurrent(generation)) this._update(body.refreshed_urls
                    .filter(({ original, refreshed }) => {
                        const url = URL.parse(refreshed ?? "");
                        return this.inFlight.has(original) && this._isValid(url) && !this._willExpire(url);
                    })
                    .map(({ original, refreshed }) => [original, refreshed]));
            } catch {
                logger.warn("Could not refresh favourite attachment links.");
            } finally {
                if (this.isCurrent(generation)) {
                    this.inFlight.clear();
                    this.schedule();
                }
            }
        }
    }

    return new SignedUrlsStoreClass(FluxDispatcher) as SignedUrlsStoreType;
});
