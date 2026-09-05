/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { definePluginSettings, SettingsStore } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Divider } from "@components/Divider";
import { ErrorCard } from "@components/ErrorCard";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Link } from "@components/Link";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { isTruthy } from "@utils/guards";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findComponentByCodeLazy } from "@webpack";
import { ApplicationAssetUtils, Button, FluxDispatcher, React, UserStore } from "@webpack/common";

import { RPCSettings } from "./RpcSettings";

const useProfileThemeStyle = findByCodeLazy("profileThemeStyle:", "--profile-gradient-primary-color");
const ActivityView = findComponentByCodeLazy(".party?(0", "USER_PROFILE_ACTIVITY");
const logger = new Logger("CustomRPC");

const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

const maxAssetCacheSize = 100;
const assetCache = new Map<string, Promise<string>>();

async function getApplicationAsset(key: string): Promise<string> {
    const appId = settings.store.appID || "0";
    const cacheKey = JSON.stringify([appId, key]);
    const cached = assetCache.get(cacheKey);
    if (cached) return await cached;

    if (assetCache.size >= maxAssetCacheSize) {
        const oldestKey = assetCache.keys().next().value;
        if (oldestKey !== undefined) assetCache.delete(oldestKey);
    }

    const promise = ApplicationAssetUtils.fetchAssetIds(appId, [key])
        .then(ids => ids[0]!)
        .catch(error => {
            if (assetCache.get(cacheKey) === promise) assetCache.delete(cacheKey);
            throw error;
        });
    assetCache.set(cacheKey, promise);

    return await promise;
}

export const enum TimestampMode {
    NONE,
    NOW,
    TIME,
    CUSTOM,
}

export const settings = definePluginSettings({
    config: {
        type: OptionType.COMPONENT,
        component: RPCSettings
    },
}).withPrivateSettings<{
    appID?: string;
    appName?: string;
    details?: string;
    detailsURL?: string;
    state?: string;
    stateURL?: string;
    type?: ActivityType;
    streamLink?: string;
    timestampMode?: TimestampMode;
    startTime?: number;
    endTime?: number;
    imageBig?: string;
    imageBigURL?: string;
    imageBigTooltip?: string;
    imageSmall?: string;
    imageSmallURL?: string;
    imageSmallTooltip?: string;
    buttonOneText?: string;
    buttonOneURL?: string;
    buttonTwoText?: string;
    buttonTwoURL?: string;
    partySize?: number;
    partyMaxSize?: number;
}>();

async function createActivity(): Promise<Activity | undefined> {
    const {
        appID,
        appName,
        details,
        detailsURL,
        state,
        stateURL,
        type,
        streamLink,
        startTime,
        endTime,
        imageBig,
        imageBigURL,
        imageBigTooltip,
        imageSmall,
        imageSmallURL,
        imageSmallTooltip,
        buttonOneText,
        buttonOneURL,
        buttonTwoText,
        buttonTwoURL,
        partyMaxSize,
        partySize,
        timestampMode
    } = settings.store;

    if (!appName) return;

    const activity: Activity = {
        application_id: appID || "0",
        name: appName,
        state,
        details,
        type: type ?? ActivityType.PLAYING,
        flags: 1 << 0,
    };

    if (type === ActivityType.STREAMING) activity.url = streamLink;

    switch (timestampMode) {
        case TimestampMode.NOW:
            activity.timestamps = {
                start: Date.now()
            };
            break;
        case TimestampMode.TIME:
            activity.timestamps = {
                start: Date.now() - (new Date().getHours() * 3600 + new Date().getMinutes() * 60 + new Date().getSeconds()) * 1000
            };
            break;
        case TimestampMode.CUSTOM:
            if (startTime || endTime) {
                activity.timestamps = {};
                if (startTime && endTime && endTime > startTime) {
                    const anchor = loopAnchor ?? Date.now();
                    activity.timestamps.start = anchor;
                    activity.timestamps.end = anchor + (endTime - startTime);
                } else {
                    if (startTime) activity.timestamps.start = startTime;
                    if (endTime) activity.timestamps.end = endTime;
                }
            }
            break;
        case TimestampMode.NONE:
        default:
            break;
    }

    if (detailsURL) {
        activity.details_url = detailsURL;
    }

    if (stateURL) {
        activity.state_url = stateURL;
    }

    if (buttonOneText) {
        activity.buttons = [
            buttonOneText,
            buttonTwoText
        ].filter(isTruthy);

        activity.metadata = {
            button_urls: [
                buttonOneURL,
                buttonTwoURL
            ].filter(isTruthy)
        };
    }

    const [largeImageAsset, smallImageAsset] = await Promise.all([
        imageBig ? getApplicationAsset(imageBig) : undefined,
        imageSmall ? getApplicationAsset(imageSmall) : undefined
    ]);

    if (imageBig) {
        activity.assets = {
            large_image: largeImageAsset,
            large_text: imageBigTooltip || undefined,
            large_url: imageBigURL || undefined
        };
    }

    if (imageSmall) {
        activity.assets = {
            ...activity.assets,
            small_image: smallImageAsset,
            small_text: imageSmallTooltip || undefined,
            small_url: imageSmallURL || undefined
        };
    }

    if (partyMaxSize && partySize) {
        activity.party = {
            size: [partySize, partyMaxSize]
        };
    }

    for (const k in activity) {
        if (k === "type") continue;
        const v = activity[k];
        if (!v || v.length === 0)
            delete activity[k];
    }

    return activity;
}

export async function setRpc(disable = false) {
    const generation = ++rpcGeneration;
    if (disable) {
        stopTimestampLoop();
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: "CustomRPC" });
        return;
    }
    if (!pluginActive) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) { stopTimestampLoop(); return; }
    updateTimestampLoop();
    const activity = await createActivity();
    if (!pluginActive || generation !== rpcGeneration || userId !== UserStore.getCurrentUser()?.id) return;
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: activity ?? null, socketId: "CustomRPC" });
}

function queueSetRpc(disable = false) {
    void setRpc(disable).catch(error => logger.error("Failed to update custom RPC", error));
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
let loopTimeout: ReturnType<typeof setTimeout> | undefined;
let updateTimeout: ReturnType<typeof setTimeout> | undefined;
let loopAnchor: number | undefined;
let loopDuration: number | undefined;
let rpcGeneration = 0;
let pluginActive = false;

function validTimestamp(value: unknown) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP ? value : undefined;
}

function handleSettingsChange(_data?: unknown, path = "") {
    if (!pluginActive || (path && path !== "plugins" && path !== "plugins.CustomRPC" && !path.startsWith("plugins.CustomRPC."))) return;
    rpcGeneration++;
    clearTimeout(updateTimeout);
    updateTimestampLoop();
    updateTimeout = setTimeout(() => {
        updateTimeout = undefined;
        queueSetRpc();
    }, 300);
}

function updateTimestampLoop() {
    const { timestampMode, startTime, endTime, appName } = settings.store;
    const start = validTimestamp(startTime);
    const end = validTimestamp(endTime);
    const duration = pluginActive && UserStore.getCurrentUser() && appName && timestampMode === TimestampMode.CUSTOM && start !== undefined && end !== undefined && end > start && end - start <= MAX_TIMESTAMP - Date.now()
        ? end - start : undefined;
    if (duration === loopDuration) return;
    stopTimestampLoop();
    loopDuration = duration;
    if (duration !== undefined) {
        loopAnchor = Date.now();
        scheduleTimestampLoop(duration);
    }
}

function scheduleTimestampLoop(duration: number) {
    if (!pluginActive || loopAnchor === undefined || loopDuration !== duration) return;
    const delay = Math.min(Math.max(loopAnchor + duration - Date.now(), 1000), MAX_TIMEOUT_MS);
    loopTimeout = setTimeout(() => {
        loopTimeout = undefined;
        if (!pluginActive || loopAnchor === undefined || loopDuration !== duration) return;
        if (Date.now() >= loopAnchor + duration) {
            loopAnchor = Date.now();
            queueSetRpc();
        }
        scheduleTimestampLoop(duration);
    }, delay);
}

function stopTimestampLoop() {
    clearTimeout(loopTimeout);
    loopTimeout = undefined;
    loopAnchor = undefined;
    loopDuration = undefined;
}

export default definePlugin({
    name: "CustomRPC",
    description: "Add a fully customisable Rich Presence (Game status) to your Discord profile",
    tags: ["Activity", "Customisation"],
    authors: [Devs.captain, Devs.AutumnVN, Devs.nin0dev],
    dependencies: ["UserSettingsAPI"],
    // This plugin's patch is not important for functionality, so don't require a restart
    requiresRestart: false,
    settings,

    start() {
        if (pluginActive) return;
        pluginActive = true;
        SettingsStore.addGlobalChangeListener(handleSettingsChange);
        queueSetRpc();
    },
    stop() {
        if (!pluginActive) return;
        pluginActive = false;
        SettingsStore.removeGlobalChangeListener(handleSettingsChange);
        clearTimeout(updateTimeout);
        updateTimeout = undefined;
        queueSetRpc(true);
        assetCache.clear();
    },

    flux: {
        CONNECTION_OPEN() { queueSetRpc(); },
        LOGOUT() {
            clearTimeout(updateTimeout);
            updateTimeout = undefined;
            queueSetRpc(true);
            assetCache.clear();
        }
    },

    // Discord hides buttons on your own Rich Presence for some reason. This patch disables that behaviour
    patches: [
        {
            find: ".USER_PROFILE_ACTIVITY_BUTTONS),",
            replacement: {
                match: /.getId\(\)===\i.id/,
                replace: "$& && false"
            },
        }
    ],

    settingsAboutComponent: () => {
        const [activity] = useAwaiter(createActivity, { fallbackValue: undefined, deps: Object.values(settings.store) });
        const gameActivityEnabled = ShowCurrentGame.useSetting();
        const { profileThemeStyle } = useProfileThemeStyle({});

        return (
            <>
                {!gameActivityEnabled && (
                    <ErrorCard
                        className={classes(Margins.top16, Margins.bottom16)}
                        style={{ padding: "1em" }}
                    >
                        <Heading>Notice</Heading>
                        <Paragraph>Activity Sharing isn't enabled, people won't be able to see your custom rich presence!</Paragraph>

                        <Button
                            color={Button.Colors.TRANSPARENT}
                            className={Margins.top8}
                            onClick={() => ShowCurrentGame.updateSetting(true)}
                        >
                            Enable
                        </Button>
                    </ErrorCard>
                )}

                <Flex flexDirection="column" gap=".5em" className={Margins.top16}>
                    <Paragraph>
                        Go to the <Link href="https://discord.com/developers/applications">Discord Developer Portal</Link> to create an application and
                        get the application ID.
                    </Paragraph>
                    <Paragraph>
                        Upload images in the Rich Presence tab to get the image keys.
                    </Paragraph>
                    <Paragraph>
                        If you want to use an image link, download your image and reupload the image to <Link href="https://imgur.com">Imgur</Link> and get the image link by right-clicking the image and selecting "Copy image address".
                    </Paragraph>
                    <Paragraph>
                        You can't see your own buttons on your profile, but everyone else can see it fine.
                    </Paragraph>
                    <Paragraph>
                        Some weird unicode text ("fonts" 𝖑𝖎𝖐𝖊 𝖙𝖍𝖎𝖘) may cause the rich presence to not show up, try using normal letters instead.
                    </Paragraph>
                </Flex>

                <Divider className={Margins.top8} />

                <div style={{ width: "284px", ...profileThemeStyle, marginTop: 8, borderRadius: 8, background: "var(--background-mod-muted)" }}>
                    {activity && <ActivityView
                        activity={activity}
                        user={UserStore.getCurrentUser()}
                        currentUser={UserStore.getCurrentUser()}
                    />}
                </div>
            </>
        );
    }
});
