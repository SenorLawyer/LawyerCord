/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin from "@utils/types";
import { Activity, User } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Toasts } from "@webpack/common";

const logger = new Logger("CopyStatusUrls");

interface MakeContextMenuProps {
    user: User,
    activity: Activity;
}

// This is an API call if the result is not cached
// i looked for an hour and did not find a better way to do this
const getMetadataFromApi: (activity: Activity, userId: string) => Promise<unknown> = findByCodeLazy("null/undefined");

export default definePlugin({
    name: "CopyStatusUrls",
    description: "Copy the users status url when you right-click it",
    tags: ["Activity", "Utility"],
    authors: [Devs.sadan],

    patches: [
        {
            find: '?"PRESS_WATCH_ON_CRUNCHYROLL_BUTTON"',
            replacement: {
                match: /(?=onClick)(?=.*index:(\i))/,
                replace: "onContextMenu: $self.makeContextMenu(arguments[0], $1),"
            }
        }
    ],

    makeContextMenu(props: MakeContextMenuProps, index: number) {
        return async () => {
            try {
                const metadata = await getMetadataFromApi(props.activity, props.user.id);
                const url: unknown = isObject(metadata) && "button_urls" in metadata && Array.isArray(metadata.button_urls)
                    ? metadata.button_urls[index] : undefined;
                if (typeof url !== "string" || !url) {
                    throw new Error("The status button has no URL.");
                }
                await copyWithToast(url, "Copied URL");
            } catch (e) {
                logger.error("Could not copy the status URL.", e);
                Toasts.show({
                    id: Toasts.genId(),
                    message: "Could not copy the status URL.",
                    type: Toasts.Type.FAILURE,
                    options: {
                        position: Toasts.Position.TOP
                    }
                });
            }
        };
    }
});
