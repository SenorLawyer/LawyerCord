/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

let active = false;
interface Codec {
    type: string;
    name: string;
    encode?: boolean;
}

const settings = definePluginSettings({
    disableAv1Codec: {
        description: "Make Discord not consider using AV1 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableH265Codec: {
        description: "Make Discord not consider using H265 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableH264Codec: {
        description: "Make Discord not consider using H264 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableVP8Codec: {
        hidden: true,
        description: "Make Discord not consider using VP8 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableVP9Codec: {
        hidden: true,
        description: "Make Discord not consider using VP9 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
});

export default definePlugin({
    name: "StreamingCodecDisabler",
    description: "Disable codecs for streaming of your choice",
    tags: ["Utility", "Voice"],
    authors: [EquicordDevs.davidkra230],
    settings,
    start() {
        active = true;
    },
    stop() {
        active = false;
    },

    patches: [
        {
            find: "setVideoBroadcast(this.shouldConnectionBroadcastVideo",
            group: true,
            replacement: [
                {
                    match: /(?<=codecs:)this\.codecs(?=\})/,
                    replace: "$self.filterCodecs($&,this)"
                },
                {
                    match: /(?<=\.Video(?:Encoder|Decoder)Fallback,)this\.codecs/g,
                    replace: "$self.filterCodecs($&,this)"
                }
            ]
        }
    ],

    filterCodecs(codecs: Codec[], connection: { context: string; userId: string; streamUserId?: string; }) {
        if (!active || connection.context !== "stream" || connection.streamUserId !== connection.userId) return codecs;
        const { disableAv1Codec, disableH265Codec, disableH264Codec } = settings.store;
        return codecs.map(codec => codec.type === "video" && codec.encode && (
            codec.name === "AV1" && disableAv1Codec
            || codec.name === "H265" && disableH265Codec
            || codec.name === "H264" && disableH264Codec
        ) ? { ...codec, encode: false } : codec);
    },
});
