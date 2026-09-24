/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";

const cl = classNameFactory("vc-usrbg-");
const logger = new Logger("USRBG");
const API_ORIGIN = "https://usrbg.is-hardly.online";

interface UsrbgApiReturn {
    endpoint: string;
    bucket: string;
    prefix: string;
    users: Record<string, string>;
}

const settings = definePluginSettings({
    nitroFirst: {
        description: "Prefer Discord banners when both Discord and USRBG banners are available.",
        type: OptionType.BOOLEAN,
        default: true
    },
    voiceBackground: {
        description: "Use USRBG banners as voice chat backgrounds",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    }
});

export default definePlugin({
    name: "USRBG",
    description: "Displays user banners from USRBG, allowing anyone to get a banner without Nitro",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.AutumnVN, Devs.katlyn, Devs.pylix, Devs.TheKodeToad],
    settings,
    patches: [
        {
            find: ':"SHOULD_LOAD");',
            replacement: {
                match: /\i(?:\?)?.getPreviewBanner\(\i,\i,\i\)(?=.{0,100}"COMPLETE")/,
                replace: "$self.patchBannerUrl(arguments[0])||$&"

            }
        },
        {
            find: "\"data-selenium-video-tile\":",
            replacement: [
                {
                    match: /(?<=function\((\i),\i\)\{)(?=let.{20,40},style:)/,
                    replace: "Object.assign($1.style=$1.style||{},$self.getVoiceBackgroundStyles($1));"
                }
            ]
        },
        {
            find: '"VideoBackground-web"',
            predicate: () => settings.store.voiceBackground,
            replacement: {
                match: /backgroundColor:.{0,25},\{style:(?=\i\?)/,
                replace: "$&$self.userHasBackground(arguments[0]?.userId)?null:",
            }
        }
    ],

    data: null as UsrbgApiReturn | null,
    request: undefined as AbortController | undefined,

    settingsAboutComponent: () => (
        <Button
            variant="link"
            className={cl("settings-button")}
            onClick={() => VencordNative.native.openExternal("https://github.com/AutumnVN/usrbg#how-to-request-your-own-usrbg-banner")}
        >
            Get your own USRBG banner
        </Button>
    ),

    getVoiceBackgroundStyles({ className, participantUserId }: { className: string; participantUserId: string; }) {
        if (!className.includes("tile")) return;
        const imageUrl = this.getImageUrl(participantUserId);
        if (!imageUrl) return;
        return {
            backgroundImage: `url(${JSON.stringify(new URL(imageUrl).href)})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat"
        };
    },

    patchBannerUrl({ displayProfile }: any) {
        if (displayProfile?.banner && settings.store.nitroFirst) return;
        if (this.userHasBackground(displayProfile?.userId)) return this.getImageUrl(displayProfile?.userId);
    },

    userHasBackground(userId: string) {
        return !!this.data?.users[userId];
    },

    getImageUrl(userId: string): string | null {
        const { data } = this;
        if (!data) return null;
        const { endpoint, bucket, prefix, users: { [userId]: etag } } = data;
        if (!etag) return null;
        return `${endpoint}/${bucket}/${prefix}${userId}?${etag}`;
    },

    async start() {
        this.request?.abort();
        const request = this.request = new AbortController();
        const timeout = setTimeout(() => request.abort(), 30_000);
        try {
            const res = await fetch(`${API_ORIGIN}/users`, { signal: request.signal });
            if (!res.ok || request.signal.aborted) return;
            const data: unknown = await res.json();
            if (request.signal.aborted) return;
            if (!isObject(data)
                || !("endpoint" in data) || data.endpoint !== API_ORIGIN
                || !("bucket" in data) || typeof data.bucket !== "string"
                || !("prefix" in data) || typeof data.prefix !== "string"
                || !("users" in data) || !isObject(data.users)
                || !Object.values(data.users).every(value => typeof value === "string")) {
                logger.warn("The banner feed returned invalid data.");
                return;
            }
            this.data = data as UsrbgApiReturn;
        } catch {
            if (!request.signal.aborted) logger.warn("Could not load the banner feed.");
        } finally {
            clearTimeout(timeout);
            if (this.request === request) this.request = undefined;
        }
    },

    stop() {
        this.request?.abort();
        this.request = undefined;
        this.data = null;
    }

});
