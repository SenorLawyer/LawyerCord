/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Devs, EquicordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { Providers } from "./Providers";
import { Settings } from "./Settings";
import SongLinker from "./SongLinker";

export const settings = definePluginSettings({
    servicesSettings: {
        type: OptionType.CUSTOM,
        description: "settings for services",
        default: Object.fromEntries(Object.entries(Providers).map(([name, data]) => [name, {
            enabled: true,
            // @ts-ignore
            openInNative: data.native || false
        }]))
    },
    userCountry: {
        type: OptionType.STRING,
        description: "Country used for lookup (Two letter country code)",
        default: "US"
    },
    includeMetadata: {
        type: OptionType.BOOLEAN,
        description: "Include the track title and artist name as a header.",
        default: true,
    },
    servicesComponent: {
        type: OptionType.COMPONENT,
        component: () => <Settings />
    }
});

export type SongLinkResult = {
    info?: {
        title: string;
        artist: string;
    };
    links: {
        [platform: string]: {
            url: string;
            nativeUri?: string;
        };
    };
};

export const Native = VencordNative.pluginHelpers.SongLink as PluginNative<typeof import("./native")>;
const MUSIC_LINK_REGEX = /https:\/\/(?:open|play)\.spotify\.com\/track\/[a-zA-Z0-9]+|https:\/\/(?:music|itunes)\.apple\.com\/[a-z]{2}\/album\/\S+|https:\/\/music\.youtube\.com\/watch\?v=[0-9A-Za-z_-]+|https:\/\/tidal\.com\/track\/[0-9]+\/u/g;
const MAX_SONG_LINK_CACHE_ENTRIES = 100;

function extractMusicLinks(content: string) {
    MUSIC_LINK_REGEX.lastIndex = 0;
    const links = content.match(MUSIC_LINK_REGEX);

    return links?.length ? Array.from(new Set(links)) : null;
}

function formatMessage(data: SongLinkResult): string | null {
    const lines: string[] = [];

    for (const [serviceKey, service] of Object.entries(settings.store.servicesSettings)) {
        if (!service.enabled) continue;

        const platformData = data.links[serviceKey];
        if (!platformData?.url) continue;

        const provider = Providers[serviceKey];
        const name = provider?.name ?? serviceKey;

        lines.push(`- [${name}](<${platformData.url}>)`);
    }

    if (lines.length === 0) return null;

    const parts: string[] = [];

    if (settings.store.includeMetadata && data.info?.title && data.info?.artist) {
        parts.push(`### **${data.info.title}** — *${data.info.artist}*`);
    }

    parts.push(lines.join("\n"));

    return parts.join("\n");
}

function SongLinkerList({ urls }: { urls: string[]; }) {
    const [resolvedKeys, setResolvedKeys] = useState<Record<string, string | null>>(
        () => Object.fromEntries(urls.map(u => [u, null]))
    );

    useEffect(() => {
        setResolvedKeys(Object.fromEntries(urls.map(u => [u, null])));
    }, [urls.join("\n")]);

    function onResolved(url: string, result: SongLinkResult) {
        const key = result.info
            ? `${result.info.title}\0${result.info.artist}`
            : url;
        setResolvedKeys(prev => prev[url] === key ? prev : { ...prev, [url]: key });
    }

    const seenKeys = new Set<string>();
    const dedupedUrls = urls.filter(url => {
        const key = resolvedKeys[url];
        if (key === null) return true;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
    });

    return <div style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        marginTop: "7px"
    }}>
        {dedupedUrls.map(url => (
            <SongLinker key={url} url={url} onResolved={onResolved} />
        ))}
    </div>;
}

export default definePlugin({
    name: "SongLink",
    description: "Adds streaming service buttons below song links",
    dependencies: ["MessageAccessoriesAPI"],
    tags: ["Media", "Utility"],
    authors: [Devs.nin0dev, EquicordDevs.NassCT],
    settings,
    Providers,
    cache: ({} as Record<string, SongLinkResult | undefined>),
    cacheKeys: [] as string[],
    getFromCache(link: string) {
        const cached = this.cache[link];
        if (!cached) return undefined;

        const existingIndex = this.cacheKeys.indexOf(link);
        if (existingIndex >= 0) this.cacheKeys.splice(existingIndex, 1);
        this.cacheKeys.push(link);

        return cached;
    },
    addToCache(link, data: SongLinkResult) {
        const existingIndex = this.cacheKeys.indexOf(link);
        if (existingIndex >= 0) this.cacheKeys.splice(existingIndex, 1);
        this.cacheKeys.push(link);

        this.cache[link] = data;
        while (this.cacheKeys.length > MAX_SONG_LINK_CACHE_ENTRIES) {
            const oldestKey = this.cacheKeys.shift();
            if (oldestKey) delete this.cache[oldestKey];
        }
    },
    renderMessageAccessory(props: Record<string, any>) {
        const { content }: {
            content: string;
        } = props.message;
        if (!content) return;

        const musicLinks = extractMusicLinks(content);
        if (!musicLinks) return;

        return <SongLinkerList urls={musicLinks} />;
    },
    commands: [
        {
            name: "musiclink",
            description: "Convert a music link to other streaming platforms.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "url",
                    description: "Music link (Spotify, Deezer, YouTube, Tidal, Apple Music, SoundCloud)",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                },
            ],
            execute: async (opts, ctx) => {
                const url = findOption<string>(opts, "url", "");

                if (!url) {
                    sendBotMessage(ctx.channel.id, {
                        content: "Please provide a music link.",
                    });
                    return;
                }

                sendBotMessage(ctx.channel.id, {
                    content: "This will take a moment...",
                });

                try {
                    const data = await Native.getTrackData(url);
                    const formatted = formatMessage(data);

                    if (!formatted) {
                        sendBotMessage(ctx.channel.id, {
                            content:
                                "No alternative platforms found for this link.",
                        });
                        return;
                    }

                    await sendMessage(ctx.channel.id, { content: formatted });
                } catch {
                    sendBotMessage(ctx.channel.id, {
                        content: "Failed to resolve or send the music link.",
                    });
                }
            },
        },
    ],
    stop() {
        this.cache = {};
        this.cacheKeys = [];
    },
});
