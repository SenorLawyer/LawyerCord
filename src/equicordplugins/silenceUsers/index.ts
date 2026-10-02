/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

const USER_ID_REGEX = /^\d{17,20}$/;
let mutedIds = new Set<string>();

const settings = definePluginSettings({
    mutedUserIds: {
        type: OptionType.STRING,
        description: "Comma-separated Discord user IDs to silence pings and server badges.",
        default: "",
        onChange: value => { mutedIds = parseUserIdSet(value); },
        isValid(value: string) {
            if (!value) return true;

            for (const rawId of value.split(",")) {
                const id = rawId.trim();
                if (!id) continue;
                if (!USER_ID_REGEX.test(id)) return `${id} isn't a valid user id`;
            }

            return true;
        },
        restartNeeded: false,
    },
});

function parseUserIdSet(value: string): Set<string> {
    const ids = new Set<string>();

    for (const rawId of value.split(",")) {
        const id = rawId.trim();
        if (USER_ID_REGEX.test(id)) ids.add(id);
    }

    return ids;
}

function interceptor(event: any) {
    try {
        if (!mutedIds.size) return;

        if (event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") {
            const msg = event.message;
            if (!msg) return;

            const authorId = String(msg.author?.id ?? "");
            if (!authorId || !mutedIds.has(authorId)) return;

            msg.mention_everyone = false;
            msg.mention_roles = [];
            msg.mentions = [];
        }

        if (event.type === "NOTIFICATION_CREATE") {
            const msg = event?.message ?? event?.notification?.message;
            if (!msg) return;

            const authorId = String(msg?.author?.id ?? "");
            if (!authorId || !mutedIds.has(authorId)) return;

            return false;
        }
    } catch { }
}

export default definePlugin({
    name: "SilenceUsers",
    performance: { impact: "low", description: "Checks author IDs when processing message and notification events." },
    description: "Silences @mention pings and server badge counts from specific users. Regular messages and DMs are untouched.",
    authors: [EquicordDevs.dka],
    tags: ["Chat", "Notifications", "Privacy"],
    settings,
    start() {
        mutedIds = parseUserIdSet(settings.store.mutedUserIds);
        FluxDispatcher.addInterceptor(interceptor);
    },
    stop() {
        const list = FluxDispatcher._interceptors ?? [];
        const idx = list.indexOf(interceptor);
        if (idx !== -1) list.splice(idx, 1);
        mutedIds = new Set();
    },
});
