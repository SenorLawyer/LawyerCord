/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, ant0n, FieryFlames and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { EmojiIntention } from "@vencord/discord-types/enums";
import { OverridePremiumTypeStore } from "@webpack/common";

export const settings = definePluginSettings({
    superReactByDefault: {
        type: OptionType.BOOLEAN,
        description: "Reaction picker will default to Super Reactions",
        default: true,
    },
    unlimitedSuperReactionPlaying: {
        type: OptionType.BOOLEAN,
        description: "Remove the limit on Super Reactions playing at once",
        default: false,
    },

    superReactionPlayingLimit: {
        description: "Max Super Reactions to play at once. 0 to disable playing Super Reactions",
        type: OptionType.SLIDER,
        default: 20,
        markers: [0, 5, 10, 20, 40, 60, 80, 100],
        stickToMarkers: true,
    },
}, {
    superReactionPlayingLimit: {
        disabled() { return this.store.unlimitedSuperReactionPlaying; },
    }
});

export default definePlugin({
    name: "SuperReactionTweaks",
    performance: {
        impact: "low",
        description: "Changes super reaction selection and animation settings through existing controls."
    },
    description: "Customize the limit of Super Reactions playing at once, and super react by default",
    tags: ["Reactions", "Emotes"],
    authors: [Devs.FieryFlames, Devs.ant0n],
    patches: [
        {
            find: ",BURST_REACTION_EFFECT_PLAY",
            replacement: [
                {
                    // if (inlinedCalculatePlayingCount(a,b) >= limit) return;
                    match: /(?<=\}\)?\(\i,\i\)>=)5(?=\)return;)/,
                    replace: "($self.settings.store.unlimitedSuperReactionPlaying?Infinity:$self.settings.store.superReactionPlayingLimit)"
                }
            ]
        },
        {
            find: ".EMOJI_PICKER_CONSTANTS_EMOJI_CONTAINER_PADDING_HORIZONTAL)",
            replacement: {
                match: /(?<=getGuildId\(\)\?\?\i\?\?null,\[\i,\i\]=\i\.useState\()!1/,
                replace: "$self.shouldSuperReactByDefault(arguments[0].pickerIntention)"
            }
        }
    ],
    settings,

    shouldSuperReactByDefault(pickerIntention: EmojiIntention) {
        return pickerIntention === EmojiIntention.REACTION && settings.store.superReactByDefault && OverridePremiumTypeStore.getState().premiumTypeActual != null;
    }
});
