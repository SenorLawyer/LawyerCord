/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";

export default definePlugin({
    name: "TidalEmbeds",
    description: "Embeds TIDAL songs to make them playable in Discord.",
    tags: ["Appearance", "Chat", "Media"],
    authors: [EquicordDevs.vmohammad],
    dependencies: ["MessageUpdaterAPI"],
    patches: [
        {
            find: "renderEmbeds(",
            replacement: {
                match: /(?<=renderEmbeds\(\i\){.{0,200}?embeds\.map\(\((\i),\i\)?=>{)/,
                replace: "$&if($self.isTidalEmbed($1))return null;"
            }
        }
    ],

    isTidalEmbed(embed: { url?: string; }) {
        return typeof embed.url === "string"
            && /^https:\/\/tidal\.com\/(?:browse\/)?(?:album|track)\/\d+(?:[/?#]|$)/.test(embed.url);
    },

    renderMessageAccessory({ message }: { message?: Message; }) {
        if (!message) return null;
        const tidalEmbeds = message.embeds.filter(embed => this.isTidalEmbed(embed));
        if (!tidalEmbeds.length) return null;

        return tidalEmbeds.map(({ id: embedId, url }) => {
            const match = url.match(/\/(album|track)\/([0-9]+)/);
            if (!match || !match[2]) return null;

            const isAlbum = match[1] === "album";
            const id = match[2];
            const width = isAlbum ? 700 : 400;
            const height = isAlbum ? 300 : 100;
            const src = `https://embed.tidal.com/${isAlbum ? "albums" : "tracks"}/${id}?disableAnalytics=true`;
            return (
                <div key={embedId} className="tidal-embed">
                    <iframe
                        src={src}
                        width={width}
                        height={height}
                        allow="encrypted-media"
                        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                        title="TIDAL Embed Player"
                    />
                </div>
            );
        });
    }
});
