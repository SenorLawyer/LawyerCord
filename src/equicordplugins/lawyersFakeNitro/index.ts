/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { UserSettingsProtoStore } from "@webpack/common";

const FAVORITES_KEY = "LawyersFakeNitro_favoriteChannels";

type RecordValue = Record<string, unknown>;

let localFavoriteChannels: RecordValue | undefined;

function record(value: unknown): RecordValue | undefined {
    return typeof value === "object" && value !== null ? value as RecordValue : undefined;
}

function favoriteChannels(proto: unknown): RecordValue | undefined {
    return record(record(proto)?.favorites) && record(record(record(proto)?.favorites)?.favoriteChannels);
}

function stateFavoriteChannels(state: unknown): RecordValue | undefined {
    const stateRecord = record(state);
    if (!stateRecord) return favoriteChannels(state);

    return favoriteChannels(state) ?? Object.values(stateRecord).map(value => favoriteChannels(value) ?? favoriteChannels(record(value)?.proto)).find(value => value !== undefined);
}

function saveFavoriteChannels(state: unknown) {
    const channels = stateFavoriteChannels(state);
    if (!channels) return;

    localFavoriteChannels = { ...channels };
    void DataStore.set(FAVORITES_KEY, localFavoriteChannels);
}

export default definePlugin({
    name: "LawyersFakeNitro",
    description: "Unlocks high-quality streaming and stores Favorites locally without changing other Nitro features.",
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
        },
        {
            find: '"UserSettingsProtoStore"',
            replacement: [
                {
                    match: /(?<=CONNECTION_OPEN:function\((\i)\)\{)/,
                    replace: (_, props) => `$self.applyLocalFavorites(${props}.userSettingsProto);`
                },
                {
                    match: /let\{settings:/,
                    replace: "arguments[0].local||$self.applyLocalFavorites(arguments[0].settings.proto);$&"
                }
            ]
        }
    ],

    start() {
        void DataStore.get<RecordValue>(FAVORITES_KEY).then(value => {
            localFavoriteChannels = value;
            this.applyLocalFavorites(UserSettingsProtoStore.getFullState());
        });
    },

    stop() {
        localFavoriteChannels = undefined;
    },

    applyLocalFavorites(proto: unknown) {
        if (!localFavoriteChannels) return;

        const apply = (value: unknown) => {
            const favorites = record(record(value)?.favorites);
            if (favorites) favorites.favoriteChannels = { ...localFavoriteChannels };
        };

        apply(proto);
        const state = record(proto);
        if (state) Object.values(state).forEach(value => {
            apply(value);
            apply(record(value)?.proto);
        });
    },

    flux: {
        USER_SETTINGS_PROTO_UPDATE(event: { local?: boolean; settings?: { proto?: unknown; }; }) {
            if (!event.local) return;

            saveFavoriteChannels(event.settings?.proto);
        }
    }
});
