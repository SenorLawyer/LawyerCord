/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MediaEngineStore } from "@webpack/common";

let active = false;
let generation = 0;

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
        description: "Make Discord not consider using VP8 for streaming.",
        type: OptionType.BOOLEAN,
        default: false
    },
    disableVP9Codec: {
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
        generation++;
    },
    stop() {
        active = false;
        generation++;
    },

    patches: [
        {
            find: "setVideoBroadcast(this.shouldConnectionBroadcastVideo",
            replacement: {
                match: /setGoLiveSource\(.,.\)\{/,
                replace: "$&$self.updateDisabledCodecs();"
            },
        }
    ],

    async updateDisabledCodecs() {
        if (!active) return;
        const currentGeneration = generation;
        const mediaEngine = MediaEngineStore.getMediaEngine();
        const response = await new Promise<string>(resolve => mediaEngine.getCodecCapabilities(resolve));
        if (currentGeneration !== generation) return;
        const capabilities = JSON.parse(response);
        const { disableAv1Codec, disableH265Codec, disableH264Codec } = settings.store;
        capabilities.forEach((codec: { codec: string; encode: boolean; }) => {
            switch (codec.codec) {
                case "AV1":
                    mediaEngine.setAv1Enabled(codec.encode && !disableAv1Codec);
                    break;
                case "H265":
                    mediaEngine.setH265Enabled(codec.encode && !disableH265Codec);
                    break;
                case "H264":
                    mediaEngine.setH264Enabled(codec.encode && !disableH264Codec);
                    break;
            }
        });
    },
});
