/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import usrbg from "@plugins/usrbg";
import { Devs } from "@utils/constants";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { IconUtils, UserProfileStore,useStateFromStores } from "@webpack/common";

import style from "./style.css?managed";

interface Nameplate {
    imgAlt: string;
    palette: {
        darkBackground: string;
        lightBackground: string;
        name: string;
    };
    src: string;
}

const settings = definePluginSettings({
    animate: {
        description: "Animate banners",
        type: OptionType.BOOLEAN,
        default: false
    },
    preferNameplate: {
        description: "prefer nameplate over banner",
        type: OptionType.BOOLEAN,
        default: false
    },
});

interface StaticBannerProps {
    url: string;
    convert: (url: string) => Promise<string>;
}

const StaticBanner = ErrorBoundary.wrap(({ url, convert }: StaticBannerProps) => {
    const [converted] = useAwaiter(() => convert(url), { fallbackValue: url });
    return <img alt="" src={converted ?? url} className="vc-banners-everywhere-memberlist" />;
}, { noop: true });

interface MemberListBannerProps {
    userId: string;
    preferNameplate: boolean;
    nameplate?: Nameplate;
    getBanner: (userId: string) => string | undefined;
    convert: (url: string) => Promise<string>;
}

const BANNER_SETTINGS: "animate"[] = ["animate"];
const MemberListBanner = ErrorBoundary.wrap(({ userId, nameplate, preferNameplate, getBanner, convert }: MemberListBannerProps) => {
    const { animate } = settings.use(BANNER_SETTINGS);
    const url = useStateFromStores([UserProfileStore], () => getBanner(userId), [userId, animate]);
    if (!url || (preferNameplate && nameplate)) return null;
    if (!animate) return <StaticBanner key={url} url={url} convert={convert} />;
    return <img alt="" src={url} className="vc-banners-everywhere-memberlist" />;
}, { noop: true });

const MAX_PNG_CACHE_SIZE = 100;

export default definePlugin({
    name: "BannersEverywhere",
    description: "Displays banners in the member list ",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.ImLvna, Devs.AutumnVN],
    settings,
    patches: [
        {
            find: "#{intl::GUILD_OWNER}),",
            replacement: [
                {
                    // We add the banner as a property while we can still access the user id
                    match: /(?=avatar:\(0,\i\.jsx\)\(\i,\{user:)/,
                    replace: "banner:$self.memberListBannerHook(arguments[0].user,arguments[0].nameplate),",
                },
                {
                    match: /(?<=\),nameplate:)(\i)/,
                    replace: "$self.nameplate($1)"
                }
            ]
        },
        {
            find: ".MEMBER_LIST}),(0,",
            replacement: {
                // We cant access the user id here, so we take the banner property we set earlier
                match: /children:\[(?=.{0,100}\.MEMBER_LIST)/,
                replace: "$&arguments[0].banner,"
            }
        }
    ],

    managedStyle: style,
    pngCache: new Map<string, Promise<string>>(),
    pendingConversions: new Map<string, () => void>(),
    stop() {
        for (const cancel of this.pendingConversions.values()) cancel();
        this.pngCache.clear();
    },

    nameplate(nameplate: Nameplate | undefined) {
        if (settings.store.preferNameplate) return nameplate;
    },

    memberListBannerHook(user: User, nameplate: Nameplate | undefined) {
        return <MemberListBanner userId={user.id} nameplate={nameplate} preferNameplate={settings.store.preferNameplate} getBanner={this.getBanner} convert={this.gifToPng} />;
    },

    async gifToPng(url: string): Promise<string> {
        const cached = this.pngCache.get(url);
        if (cached) return cached;

        const promise = new Promise<string>(resolve => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            const finish = (value: string) => {
                if (this.pendingConversions.get(url) !== cancel) return;
                clearTimeout(timeout);
                img.onload = null;
                img.onerror = null;
                this.pendingConversions.delete(url);
                resolve(value);
            };
            const cancel = () => {
                finish(url);
                img.removeAttribute("src");
            };
            const timeout = setTimeout(cancel, 30_000);
            this.pendingConversions.set(url, cancel);
            img.onload = () => {
                if (this.pendingConversions.get(url) !== cancel) return;
                try {
                    const canvas = document.createElement("canvas");
                    const scale = Math.min(1, 1024 / img.width, 1024 / img.height);
                    canvas.width = Math.max(1, Math.round(img.width * scale));
                    canvas.height = Math.max(1, Math.round(img.height * scale));
                    const ctx = canvas.getContext("2d");
                    if (!ctx) {
                        finish(url);
                        return;
                    }
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    finish(canvas.toDataURL("image/png"));
                } catch {
                    finish(url);
                }
            };
            img.onerror = () => finish(url);
            img.src = url;
        });
        this.pngCache.set(url, promise);

        if (this.pngCache.size > MAX_PNG_CACHE_SIZE) {
            const oldestKey = this.pngCache.keys().next().value;
            if (oldestKey) {
                this.pendingConversions.get(oldestKey)?.();
                this.pngCache.delete(oldestKey);
            }
        }

        const converted = await promise;
        if (converted === url && this.pngCache.get(url) === promise) this.pngCache.delete(url);
        return converted;
    },

    getBanner(userId: string): string | undefined {
        if (isPluginEnabled(usrbg.name) && usrbg.userHasBackground(userId)) {
            let banner = usrbg.getImageUrl(userId);
            if (banner === null) banner = "";
            return banner;
        }
        // Discord Banners
        const userProfile = UserProfileStore.getUserProfile(userId);
        if (userProfile?.banner)
            return IconUtils.getUserBannerURL({ id: userId, banner: userProfile.banner, canAnimate: settings.store.animate, size: 1024 });
    },
});
