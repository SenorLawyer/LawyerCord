/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { makeLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import { useAwaiter, useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { React, showToast, Toasts } from "@webpack/common";

import { ReplaceSettings, ReplaceTutorial } from "./ReplaceSettings";

const APP_IDS_KEY = "ReplaceActivityType_appids";

export type AppIdSetting = {
    disableAssets: boolean;
    disableTimestamps: boolean;
    appId: string;
    enabled: boolean;
    newActivityType: ActivityType;
    newName: string,
    newDetails: string,
    newState: string,
    newLargeImageUrl: string,
    newLargeImageText: string,
    newSmallImageUrl: string,
    newSmallImageText: string;
    newStreamUrl: string;
};

export const makeEmptyAppId: () => AppIdSetting = () => ({
    appId: "",
    enabled: true,
    newActivityType: ActivityType.PLAYING,
    newName: "",
    newDetails: "",
    newState: "",
    newLargeImageUrl: "",
    newLargeImageText: "",
    newSmallImageUrl: "",
    newSmallImageText: "",
    newStreamUrl: "",
    disableTimestamps: false,
    disableAssets: false
});

function isAppIdSetting(value: unknown): value is AppIdSetting {
    if (!isObject(value)) return false;
    const entry = value as Record<string, unknown>;
    return Object.entries(makeEmptyAppId()).every(([key, fallback]) => typeof entry[key] === typeof fallback)
        && [ActivityType.PLAYING, ActivityType.STREAMING, ActivityType.LISTENING, ActivityType.WATCHING, ActivityType.COMPETING].some(type => entry.newActivityType === type);
}

let appIds: AppIdSetting[] = [];
let savedAppIds: string | undefined;
let saveQueue = Promise.resolve();
const logger = new Logger("RPCEditor");
const loadAppIds = makeLazy(async () => {
    const stored = await DataStore.get<unknown>(APP_IDS_KEY);
    const entries = stored ?? [];
    if (!Array.isArray(entries) || !entries.every(isAppIdSetting))
        throw new Error("Saved activities are invalid.");
    savedAppIds = JSON.stringify(stored);
    appIds = entries.length ? entries : [makeEmptyAppId()];
});

function AppSettings() {
    const [, error, pending] = useAwaiter(loadAppIds);
    const update = useForceUpdater();
    if (pending) return <Paragraph>Loading saved activities...</Paragraph>;
    if (error) return <Paragraph>Could not load saved activities. Reload Discord to try again.</Paragraph>;

    return <ReplaceSettings appIds={appIds} update={update} save={() => {
        const next = structuredClone(appIds);
        return saveQueue = saveQueue.then(async () => {
            let conflict = false;
            try {
                await DataStore.update<unknown>(APP_IDS_KEY, current => {
                    if (JSON.stringify(current) !== savedAppIds) {
                        conflict = true;
                        throw new Error("Saved activities changed.");
                    }
                    return next;
                });
                savedAppIds = JSON.stringify(next);
            } catch {
                showToast(conflict ? "Activity settings changed elsewhere. Reload Discord before saving." : "Failed to save activity settings.", Toasts.Type.FAILURE);
            }
        });
    }} />;
}

const settings = definePluginSettings({
    replacedAppIds: {
        type: OptionType.COMPONENT,
        description: "",
        component: AppSettings
    },
});

export default definePlugin({
    name: "RPCEditor",
    performance: { impact: "low", description: "Applies saved replacements when your local activity changes." },
    description: "Edit the type and content of any Rich Presence",
    tags: ["Customisation"],
    authors: [Devs.Nyako, Devs.nin0dev],
    patches: [
        {
            find: '"LocalActivityStore"',
            replacement: {
                match: /LOCAL_ACTIVITY_UPDATE:function\(\i\)\{let\{(?=[^{}]{0,150}\bactivity:(\i)[,}])[^{}]{1,150}\}=\i,\i=\i\[\i\];/,
                replace: "$&$self.patchActivity($1);",
            }
        }
    ],
    settings,
    settingsAboutComponent: () => <ReplaceTutorial />,

    start() {
        return loadAppIds().catch(() => logger.error("Failed to load saved activities."));
    },
    parseField(text: string, originalActivity: Activity): string {
        if (text === "null") return "";
        return text
            .replaceAll(":name:", () => originalActivity.name)
            .replaceAll(":details:", () => originalActivity.details ?? "")
            .replaceAll(":state:", () => originalActivity.state ?? "")
            .replaceAll(":large_image:", () => originalActivity.assets?.large_image ?? "")
            .replaceAll(":large_text:", () => originalActivity.assets?.large_text ?? "")
            .replaceAll(":small_image:", () => originalActivity.assets?.small_image ?? "")
            .replaceAll(":small_text:", () => originalActivity.assets?.small_text ?? "");
    },
    patchActivity(activity: Activity) {
        if (!activity) return;
        appIds.forEach(app => {
            if (app.enabled && app.appId === activity.application_id) {
                const oldActivity = { ...activity, assets: { ...activity.assets } };
                activity.type = app.newActivityType;
                if (app.newName) activity.name = this.parseField(app.newName, oldActivity);
                if (app.newActivityType === ActivityType.STREAMING && app.newStreamUrl) activity.url = app.newStreamUrl;
                if (app.newDetails) activity.details = this.parseField(app.newDetails, oldActivity);
                if (app.newState) activity.state = this.parseField(app.newState, oldActivity);
                if (!activity.assets) activity.assets = {};
                if (app.newLargeImageText) activity.assets.large_text = this.parseField(app.newLargeImageText, oldActivity);
                if (app.newLargeImageUrl) activity.assets.large_image = this.parseField(app.newLargeImageUrl, oldActivity);
                if (app.newSmallImageText) activity.assets.small_text = this.parseField(app.newSmallImageText, oldActivity);
                if (app.newSmallImageUrl) activity.assets.small_image = this.parseField(app.newSmallImageUrl, oldActivity);
                if (app.disableAssets) activity.assets = {};
                if (app.disableTimestamps) activity.timestamps = {};
            }
        });
    },
});
