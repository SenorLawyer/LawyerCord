/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import {
    MessageObject
} from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";

const CLEAR_URLS_JSON_URL = "https://raw.githubusercontent.com/ClearURLs/Rules/master/data.min.json";
const logger = new Logger("ClearURLs");
let activeRequest: AbortController | undefined;
const HAS_URL_REGEX = /https?:\/\//;
const MESSAGE_URL_REGEX = /(https?:\/\/[^\s<]+[^<.,:;"'>)|\]\s])/g;

interface Provider {
    urlPattern: string;
    completeProvider: boolean;
    rules?: string[];
    rawRules?: string[];
    referralMarketing?: string[];
    exceptions?: string[];
    redirections?: string[];
    forceRedirection?: boolean;
}

interface ClearUrlsData {
    providers: Record<string, Provider>;
}

interface RuleSet {
    name: string;
    urlPattern: RegExp;
    rules?: RegExp[];
    rawRules?: RegExp[];
    exceptions?: RegExp[];
}

export default definePlugin({
    name: "ClearURLs",
    description: "Automatically removes tracking elements from URLs you send",
    dependencies: ["MessageEventsAPI"],
    tags: ["Privacy", "Utility"],
    authors: [Devs.adryd, Devs.thororen],

    rules: [] as RuleSet[],

    async start() {
        await this.createRules();
    },

    stop() {
        activeRequest?.abort();
        activeRequest = undefined;
        this.rules = [];
    },

    onBeforeMessageSend(_, msg) {
        return this.cleanMessage(msg);
    },

    onBeforeMessageEdit(_cid, _mid, msg) {
        return this.cleanMessage(msg);
    },

    async createRules() {
        activeRequest?.abort();
        const request = activeRequest = new AbortController();
        try {
            const response = await fetch(CLEAR_URLS_JSON_URL, { signal: request.signal });
            if (!response.ok) throw new Error(`Rule request failed with status ${response.status}`);
            const res = await response.json() as ClearUrlsData;
            if (request.signal.aborted) return;

            const compiledRules: RuleSet[] = [];

            for (const [name, provider] of Object.entries(res.providers)) {
                const urlPattern = new RegExp(provider.urlPattern, "i");

                const rules = provider.rules?.map(rule => new RegExp(rule, "i"));
                const rawRules = provider.rawRules?.map(rule => new RegExp(rule, "i"));
                const exceptions = provider.exceptions?.map(ex => new RegExp(ex, "i"));

                compiledRules.push({
                    name,
                    urlPattern,
                    rules,
                    rawRules,
                    exceptions,
                });
            }
            this.rules = compiledRules;
        } catch (error) {
            if (!request.signal.aborted) logger.error("Failed to load URL cleaning rules", error);
        }
    },

    replacer(match: string) {
        // Parse URL without throwing errors
        try {
            var url = new URL(match);
        } catch (error) {
            // Don't modify anything if we can't parse the URL
            return match;
        }

        // Cheap way to check if there are any search params
        if (url.searchParams.entries().next().done) return match;

        for (const { urlPattern, exceptions, rawRules, rules } of this.rules) {
            if (!urlPattern.test(url.href) || exceptions?.some(ex => ex.test(url.href))) continue;

            const toDelete: string[] = [];

            if (rules) {
                // Add matched params to delete list
                url.searchParams.forEach((_, param) => {
                    if (rules.some(rule => rule.test(param))) {
                        toDelete.push(param);
                    }
                });
            }

            // Delete matched params from list
            toDelete.forEach(param => url.searchParams.delete(param));

            // Match and remove any raw rules
            let cleanedUrl = url.href;
            if (rawRules) {
                for (const rawRule of rawRules) {
                    cleanedUrl = cleanedUrl.replace(rawRule, "");
                }
            }
            if (cleanedUrl !== url.href) {
                try {
                    url = new URL(cleanedUrl);
                } catch {
                    return match;
                }
            }
        }

        return url.toString();
    },

    cleanMessage(msg: MessageObject) {
        // Only run on messages that contain URLs
        if (HAS_URL_REGEX.test(msg.content)) {
            msg.content = msg.content.replace(
                MESSAGE_URL_REGEX,
                match => this.replacer(match)
            );
        }
    },
});
