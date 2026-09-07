/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { copyWithToast } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { User } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Toasts } from "@webpack/common";

const logger = new Logger("CopyStatusUrls");

interface MakeContextMenuProps {
    user: User,
    activity: any;
}

// This is an API call if the result is not cached
// i looked for an hour and did not find a better way to do this
const getMetadataFromApi: (activity: any, userId: string) => Promise<any> = findByCodeLazy("null/undefined");

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
                const { button_urls } = await getMetadataFromApi(props.activity, props.user.id);
                if (!button_urls[index]) {
                    throw new Error("button_urls does not contain index");
                }
                await copyWithToast(button_urls[index], "Copied URL");
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
