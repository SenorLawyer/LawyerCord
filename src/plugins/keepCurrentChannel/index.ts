/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as DataStore from "@api/DataStore";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin from "@utils/types";
import { ChannelRouter, ChannelStore, NavigationRouter, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

export interface LogoutEvent {
    type: "LOGOUT";
    isSwitchingAccount: boolean;
}

interface ChannelSelectEvent {
    type: "CHANNEL_SELECT";
    channelId: string | null;
    guildId: string | null;
}

interface PreviousChannel {
    guildId: string | null;
    channelId: string | null;
}

function isPreviousChannel(value: unknown): value is PreviousChannel {
    return isObject(value) && "guildId" in value && "channelId" in value
        && (value.guildId === null || typeof value.guildId === "string")
        && (value.channelId === null || typeof value.channelId === "string");
}

const logger = new Logger("KeepCurrentChannel");
let restoreVersion = 0;
let isSwitchingAccount = false;
let previousCache: PreviousChannel | undefined;
let previousSaveTimeout: ReturnType<typeof setTimeout> | undefined;

function hasSamePreviousChannel(previous: PreviousChannel | undefined, next: PreviousChannel) {
    return previous?.guildId === next.guildId && previous.channelId === next.channelId;
}

function clearPreviousSaveTimeout() {
    if (previousSaveTimeout === undefined) return;

    clearTimeout(previousSaveTimeout);
    previousSaveTimeout = undefined;
}

async function savePreviousChannelNow() {
    clearPreviousSaveTimeout();
    if (!previousCache) return;

    await DataStore.set("KeepCurrentChannel_previousData", previousCache).catch((error: unknown) =>
        logger.warn("Could not save the previous channel.", error));
}

function schedulePreviousChannelSave() {
    clearPreviousSaveTimeout();
    previousSaveTimeout = setTimeout(() => void savePreviousChannelNow(), 500);
}

export function clearPreviousChannel() {
    restoreVersion++;
    clearPreviousSaveTimeout();
    previousCache = undefined;
    return DataStore.del("KeepCurrentChannel_previousData").catch((error: unknown) =>
        logger.warn("Could not clear the previous channel.", error));
}

export default definePlugin({
    name: "KeepCurrentChannel",
    description: "Attempt to navigate to the channel you were in before switching accounts or loading Discord.",
    tags: ["Utility", "Organisation"],
    authors: [Devs.Nuckyz],

    patches: [
        {
            find: '"Switching accounts"',
            replacement: {
                match: /goHomeAfterSwitching:\i/,
                replace: "goHomeAfterSwitching:!1"
            }
        }
    ],

    flux: {
        LOGOUT(e: LogoutEvent) {
            restoreVersion++;
            ({ isSwitchingAccount } = e);
            if (previousSaveTimeout !== undefined) void savePreviousChannelNow();
        },

        CONNECTION_OPEN() {
            if (!isSwitchingAccount) return;
            isSwitchingAccount = false;

            if (previousCache?.channelId) {
                if (ChannelStore.hasChannel(previousCache.channelId)) {
                    ChannelRouter.transitionToChannel(previousCache.channelId);
                } else {
                    NavigationRouter.transitionToGuild("@me");
                }
            }
        },

        CHANNEL_SELECT({ guildId, channelId }: ChannelSelectEvent) {
            if (isSwitchingAccount) return;
            restoreVersion++;

            const nextPrevious: PreviousChannel = {
                guildId,
                channelId
            };

            if (hasSamePreviousChannel(previousCache, nextPrevious)) return;

            previousCache = nextPrevious;
            schedulePreviousChannelSave();
        }
    },

    async start() {
        isSwitchingAccount = false;
        previousCache = undefined;
        const version = ++restoreVersion;
        try {
            const previous = await DataStore.get<unknown>("KeepCurrentChannel_previousData");
            if (version !== restoreVersion) return;
            if (previous !== undefined && !isPreviousChannel(previous)) {
                logger.warn("Stored previous channel has an invalid format.");
                return;
            }
            previousCache = previous;
            if (!previousCache) {
                previousCache = {
                    guildId: SelectedGuildStore.getGuildId(),
                    channelId: SelectedChannelStore.getChannelId() ?? null
                };
                await savePreviousChannelNow();
            } else if (previousCache.channelId) {
                ChannelRouter.transitionToChannel(previousCache.channelId);
            }
        } catch (error) {
            logger.error("Could not restore the previous channel.", error);
        }
    },

    stop() {
        restoreVersion++;
        if (previousSaveTimeout !== undefined) void savePreviousChannelNow();
    }
});
