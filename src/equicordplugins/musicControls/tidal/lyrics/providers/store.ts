/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { settings } from "@equicordplugins/musicControls/settings";
import { getLyrics } from "@equicordplugins/musicControls/tidal/lyrics/api";
import { EnhancedLyric } from "@equicordplugins/musicControls/tidal/lyrics/types";
import { TidalStore } from "@equicordplugins/musicControls/tidal/TidalStore";
import { proxyLazyWebpack } from "@webpack";
import { Flux, FluxDispatcher } from "@webpack/common";

function showNotif(title: string, body: string) {
    if (settings.store.showFailedToasts) {
        showNotification({
            color: "#ee2902",
            title,
            body,
            noPersist: true
        });
    }
}

export const TidalLrcStore = proxyLazyWebpack(() => {
    let lyrics: EnhancedLyric[] | null = null;
    let lastTrackId: string | null = null;
    let fetchGeneration = 0;
    let subscribed = false;

    class TidalLrcStore extends Flux.Store {
        init() {
            if (subscribed) return;
            subscribed = true;
            TidalStore.addChangeListener(handleTidalStoreChange);
            handleTidalStoreChange();
        }
        get lyrics() {
            return lyrics;
        }

        destroy() {
            subscribed = false;
            fetchGeneration++;
            lastTrackId = null;
            lyrics = null;
            TidalStore.removeChangeListener(handleTidalStoreChange);
        }
    }

    const store = new TidalLrcStore(FluxDispatcher);
    function handleTidalStoreChange() {
        const { track } = TidalStore;
        if (!track?.id) {
            fetchGeneration++;
            lastTrackId = null;
            lyrics = null;
            store.emitChange();
            return;
        }

        if (lastTrackId === track.id) return;

        lastTrackId = track.id;
        const generation = ++fetchGeneration;
        getLyrics(track)
            .then(l => {
                if (generation !== fetchGeneration || TidalStore.track?.id !== track.id) return;

                lyrics = l;
                store.emitChange();
            })
            .catch(() => {
                if (generation !== fetchGeneration || TidalStore.track?.id !== track.id) return;

                lyrics = null;
                showNotif("Tidal Lyrics", "Failed to fetch lyrics");
                store.emitChange();
            });
    }

    return store;
});
