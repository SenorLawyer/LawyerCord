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

import "./styles.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy, findCssClassesLazy, findStoreLazy } from "@webpack";
import { Constants, React, RestAPI, SettingsRouter, Tooltip, UserStore } from "@webpack/common";

import { NewButton, RenameButton } from "./components/RenameButton";
import { Session, SessionInfo } from "./types";
import { cl, fetchNamesFromDataStore, fetchSessionFromDataStore, getDefaultName, GetOsColor, GetPlatformIcon, savedSessionsCache, saveSessionsToDataStore } from "./utils";

const AuthSessionsStore = findStoreLazy("AuthSessionsStore");
const TimestampClasses = findCssClassesLazy("timestamp", "blockquoteContainer");
const BlobMask = findComponentByCodeLazy("!1,lowerBadgeSize:");

const MIN_BACKGROUND_CHECK_INTERVAL_MINUTES = 1;
let checkNewSessionsPromise: Promise<void> | undefined;
let lifecycleGeneration = 0;
const logger = new Logger("BetterSessions");

const settings = definePluginSettings({
    backgroundCheck: {
        type: OptionType.BOOLEAN,
        description: "Check for new sessions in the background, and display notifications when they are detected",
        default: false,
        restartNeeded: true
    },
    checkInterval: {
        description: "How often to check for new sessions in the background (if enabled), in minutes",
        type: OptionType.NUMBER,
        default: 20,
        restartNeeded: true
    }
});

export default definePlugin({
    name: "BetterSessions",
    description: "Enhances the sessions (devices) menu. Allows you to view exact timestamps, give each session a custom name, and receive notifications about new sessions.",
    authors: [Devs.amia],
    tags: ["Notifications", "Customisation", "Utility"],
    settings: settings,

    patches: [
        {
            find: "#{intl::AUTH_SESSIONS_OS_UNKNOWN}",
            replacement: [
                {
                    match: /(#{intl::AUTH_SESSIONS_ACTIVE_RECENTLY}.{0,230}role:"listitem",children:\[.{0,15},\{Icon:)\i/,
                    replace: "$1()=>$self.renderIcon(arguments[0])"
                },
                {
                    match: /("horizontal",gap:"xs",children:)\[.{0,250}"text-subtle",children:\i\}\)\]\}\),/,
                    replace: "$1$self.renderName(arguments[0])}),"
                },
                {
                    match: /("text-muted",children:)\i(?=\}\)\]\}\),.{0,120}\.client_info\?\.location)/,
                    replace: "$1$self.renderDescription(arguments[0])"
                },
                {
                    match: /:\i\(\i\.approx_last_used_time\).{0,40}\(0,\i\.jsxs?\)\(\i,\{/,
                    replace: "$&session:arguments[0]?.session,"
                },
            ]
        },
    ],

    renderName: ErrorBoundary.wrap(({ session }: SessionInfo) => {
        const state = React.useState({ name: "", isNew: false });
        const [{ name, isNew }] = state;
        const [, error, pending] = useAwaiter(() => fetchSessionFromDataStore(session.id_hash), {
            fallbackValue: undefined,
            deps: [session.id_hash],
            onSuccess: saved => state[1](saved ?? { name: "", isNew: true }),
            onError: error => logger.warn("Failed to load session name", error)
        });
        // Show a "NEW" badge if the session is seen for the first time
        return (
            <>
                <Paragraph size="md" weight="semibold" color="text-strong">{name ? `${name}*` : getDefaultName(session.client_info)}</Paragraph>
                <div className={cl("footer-buttons")}>
                    {!pending && !error && isNew && (
                        <NewButton />
                    )}
                    <RenameButton session={session} state={state} disabled={pending || !!error} />
                </div>
            </>
        );
    }, { noop: true }),

    renderDescription: ErrorBoundary.wrap(({ session, description }: { session: Session, description: string; }) => {
        const [label, timeLabel] = description.split(" \xb7 ");

        return (
            <div className={cl("description")}>
                <Paragraph size="sm" weight="normal" color="text-muted">{label}</Paragraph>
                {timeLabel && (
                    <>
                        {" \xb7 "}
                        <Tooltip text={session.approx_last_used_time.toLocaleString()}>
                            {props => (
                                <span {...props} className={TimestampClasses.timestamp}>
                                    {timeLabel}
                                </span>
                            )}
                        </Tooltip>
                    </>
                )}
            </div>
        );
    }, { noop: true }),

    renderIcon: ErrorBoundary.wrap(({ session, icon: DeviceIcon }: { session: Session; icon: React.ComponentType<any>; }) => {
        const PlatformIcon = GetPlatformIcon(session.client_info.platform);

        return (
            <BlobMask
                isFolder
                style={{ cursor: "unset" }}
                selected={false}
                lowerBadge={
                    <div className={cl("lowerBadge")}>
                        <PlatformIcon width={14} height={14} className={cl("lowerBadge-icon")} />
                    </div>
                }
                lowerBadgeSize={{
                    width: 20,
                    height: 20
                }}
            >
                <div
                    className={cl("icon")}
                    style={{ backgroundColor: GetOsColor(session.client_info.os) }}
                >
                    <DeviceIcon size="md" color="currentColor" />
                </div>
            </BlobMask>
        );
    }, { noop: true }),

    async checkNewSessions(generation = lifecycleGeneration) {
        if (generation !== lifecycleGeneration) return;
        if (checkNewSessionsPromise) return checkNewSessionsPromise;

        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) return;
        const promise = (async () => {
            const data = await RestAPI.get({
                url: Constants.Endpoints.AUTH_SESSIONS
            });

            if (generation !== lifecycleGeneration || userId !== UserStore.getCurrentUser()?.id) return;

            const newSessions: Session[] = data.body.user_sessions.filter((session: Session) => !savedSessionsCache.has(session.id_hash));
            if (!newSessions.length) return;

            await saveSessionsToDataStore(sessions => {
                for (const session of newSessions) {
                    if (!sessions.has(session.id_hash)) sessions.set(session.id_hash, { name: "", isNew: true });
                }
            });
            if (generation !== lifecycleGeneration || userId !== UserStore.getCurrentUser()?.id) return;

            for (const session of newSessions) {
                if (savedSessionsCache.has(session.id_hash)) continue;

                savedSessionsCache.set(session.id_hash, { name: "", isNew: true });
                showNotification({
                    title: "BetterSessions",
                    body: `New session:\n${session.client_info.os} · ${session.client_info.platform} · ${session.client_info.location}`,
                    permanent: true,
                    onClick: () => SettingsRouter.openUserSettings("sessions_panel")
                });
            }
        })();

        checkNewSessionsPromise = promise;

        try {
            await promise;
        } catch (error) {
            logger.error("Failed to check sessions", error);
        } finally {
            if (checkNewSessionsPromise === promise) checkNewSessionsPromise = undefined;
        }
    },

    flux: {
        LOGOUT(this: { stop(): void; }) { this.stop(); },
        CONNECTION_OPEN(this: { start(): Promise<void>; }) { return this.start(); },
        USER_SETTINGS_ACCOUNT_RESET_AND_CLOSE_FORM() {
            const lastFetchedHashes = new Set<string>(
                AuthSessionsStore.getSessions().map((session: SessionInfo["session"]) => session.id_hash)
            );

            const updateSessions = (sessions: typeof savedSessionsCache) => {
                // Add new sessions to cache
                lastFetchedHashes.forEach(idHash => {
                    if (sessions.has(idHash)) return;

                    sessions.set(idHash, { name: "", isNew: false });
                });

                // Delete removed sessions from cache
                if (lastFetchedHashes.size > 0) {
                    sessions.forEach((_, idHash) => {
                        if (lastFetchedHashes.has(idHash)) return;

                        sessions.delete(idHash);
                    });
                }

                // Dismiss the "NEW" badge of all sessions.
                // Since the only way for a session to be marked as "NEW" is going to the Devices tab,
                // closing the settings means they've been viewed and are no longer considered new.
                sessions.forEach(data => {
                    if (!data.isNew) return;

                    data.isNew = false;
                });
            };
            updateSessions(savedSessionsCache);
            return saveSessionsToDataStore(updateSessions);
        }
    },

    async start() {
        clearInterval(this.checkInterval);
        this.checkInterval = undefined;
        checkNewSessionsPromise = undefined;
        const generation = ++lifecycleGeneration;
        await fetchNamesFromDataStore(() => generation === lifecycleGeneration);
        if (generation !== lifecycleGeneration) return;

        void this.checkNewSessions(generation);
        if (settings.store.backgroundCheck) {
            const minutes = settings.store.checkInterval;
            const checkIntervalMinutes = Number.isFinite(minutes) && minutes >= MIN_BACKGROUND_CHECK_INTERVAL_MINUTES && minutes <= 0x7FFFFFFF / 60000 ? minutes : 20;
            this.checkInterval = setInterval(() => void this.checkNewSessions(generation), checkIntervalMinutes * 60 * 1000);
        }
    },

    stop() {
        lifecycleGeneration++;
        savedSessionsCache.clear();
        checkNewSessionsPromise = undefined;
        clearInterval(this.checkInterval);
        this.checkInterval = undefined;
    }
});
