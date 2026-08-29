/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { RestAPI } from "@webpack/common";

const FAVORITES_KEY = "LawyersFakeNitro_favoriteChannels";
const FAVORITES_PROTO_URL = "/users/@me/settings-proto/1";

type RecordValue = Record<string, unknown>;

let localFavoriteChannels: RecordValue | undefined;
let originalPatch: typeof RestAPI.patch;
let originalPut: typeof RestAPI.put;

function record(value: unknown): RecordValue | undefined {
    return typeof value === "object" && value !== null ? value as RecordValue : undefined;
}

function favoriteChannels(proto: unknown): RecordValue | undefined {
    return record(record(proto)?.favorites) && record(record(record(proto)?.favorites)?.favoriteChannels);
}

function isFavoritesProtoRequest(url: unknown): boolean {
    return typeof url === "string" && url === FAVORITES_PROTO_URL;
}

function localResponse() {
    return Promise.resolve({ body: {}, ok: true, status: 200 });
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
        originalPatch = RestAPI.patch;
        originalPut = RestAPI.put;
        RestAPI.patch = request => isFavoritesProtoRequest(request.url) ? localResponse() : originalPatch(request);
        RestAPI.put = request => isFavoritesProtoRequest(request.url) ? localResponse() : originalPut(request);
        void DataStore.get<RecordValue>(FAVORITES_KEY).then(value => {
            localFavoriteChannels = value;
        });
    },

    stop() {
        RestAPI.patch = originalPatch;
        RestAPI.put = originalPut;
        localFavoriteChannels = undefined;
    },

    applyLocalFavorites(proto: unknown) {
        const favorites = record(record(proto)?.favorites);
        if (favorites && localFavoriteChannels) favorites.favoriteChannels = { ...localFavoriteChannels };
    },

    flux: {
        USER_SETTINGS_PROTO_UPDATE(event: { local?: boolean; settings?: { proto?: unknown; }; }) {
            if (!event.local) return;

            const channels = favoriteChannels(event.settings?.proto);
            if (!channels) return;

            localFavoriteChannels = { ...channels };
            void DataStore.set(FAVORITES_KEY, localFavoriteChannels);
        }
    }
});
