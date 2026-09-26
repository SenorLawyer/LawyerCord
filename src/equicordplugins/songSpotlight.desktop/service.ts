/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Song } from "@song-spotlight/api/structs";
import { sid } from "@song-spotlight/api/util";
import { useAwaiter } from "@utils/react";
import { PluginNative } from "@utils/types";

export function useRender(song: Song) {
    const id = sid(song);
    const [result] = useAwaiter(async () => ({ id, render: await Native.renderSong(song).catch(() => null) }), {
        fallbackValue: null,
        deps: [id],
    });
    const current = result?.id === id ? result : null;
    return { failed: !!current && !current.render, render: current?.render ?? null };
}

export const Native = VencordNative.pluginHelpers.SongSpotlight as PluginNative<typeof import("./native")>;
