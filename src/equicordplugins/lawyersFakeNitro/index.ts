/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "LawyersFakeNitro",
    description: "Unlocks high-quality streaming and Favorites editing without changing other Nitro features.",
    authors: [EquicordDevs.SenorLawyer],

    patches: [
        {
            find: "canStreamQuality:function",
            replacement: {
                match: /(?<=canStreamQuality:function\(\i,\i\)\{)/,
                replace: "return true;"
            }
        },
        {
            find: '"getFavoritesAccess"',
            replacement: {
                match: /hasAccess:\i,isExperimentEnabled:\i,isFreemium:\i,favoriteLimit:\i,canUpsellFavoriteLimit:\i/,
                replace: "hasAccess:true,isExperimentEnabled:true,isFreemium:false,favoriteLimit:0,canUpsellFavoriteLimit:false"
            }
        }
    ]
});
