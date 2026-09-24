/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { get, set, updateMany } from "@api/DataStore";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { useTimer } from "@utils/react";
import definePlugin from "@utils/types";
import { VoiceState } from "@vencord/discord-types";
import { findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { Alerts, Button, SelectedChannelStore, showToast, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

const wrapperClasses = findCssClassesLazy("memberSinceWrapper");
const containerClasses = findCssClassesLazy("memberSince");
const Section = findComponentByCodeLazy("headingVariant:", '"section"', "headingIcon:");

const storageKey = "VoiceStats_totals";
const saveIntervalMs = 30_000;
const logger = new Logger("VoiceStats");

const sessionStarts = new Map<string, number>();
const totalsByUser = new Map<string, number>();
let activeUserId: string | undefined;
const pendingTotalsByAccount = new Map<string, Record<string, number>>();
let trackedChannelId: string | null = null;
let saveIntervalId: ReturnType<typeof setInterval> | null = null;
let totalsDirty = false;
let pluginStarted = false;
let pluginEnabled = false;
let startGeneration = 0;
let pendingSave = Promise.resolve();
let recovering = false;

async function persistTotals() {
    const userId = activeUserId;
    if (!totalsDirty || !userId) return;

    const snapshot = Object.fromEntries(totalsByUser);
    pendingTotalsByAccount.set(userId, snapshot);
    totalsDirty = false;
    pendingSave = pendingSave.then(async () => {
        try {
            await set(`${storageKey}:${userId}`, snapshot);
            if (pendingTotalsByAccount.get(userId) === snapshot) pendingTotalsByAccount.delete(userId);
        } catch (error) {
            if (activeUserId === userId) totalsDirty = true;
            logger.error("Could not save voice statistics.", error);
        }
    });
    await pendingSave;
}

function flushActiveSessions() {
    const now = performance.now();
    for (const [userId, startedAt] of sessionStarts) {
        const accrued = Math.floor((now - startedAt) / 1000);
        if (accrued <= 0) continue;

        totalsByUser.set(userId, (totalsByUser.get(userId) ?? 0) + accrued);
        sessionStarts.set(userId, startedAt + accrued * 1000);
        totalsDirty = true;
    }
}

function startSaveInterval() {
    if (saveIntervalId || sessionStarts.size === 0) return;

    saveIntervalId = setInterval(() => {
        flushActiveSessions();
        void persistTotals();
    }, saveIntervalMs);
}

function stopSaveInterval() {
    if (!saveIntervalId) return;

    clearInterval(saveIntervalId);
    saveIntervalId = null;
}

function startTrackingChannel(channelId: string, myId: string) {
    if (trackedChannelId === channelId) return;
    if (trackedChannelId) stopTrackingChannel();

    trackedChannelId = channelId;
    sessionStarts.clear();

    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    const now = performance.now();
    for (const state of Object.values(states) as VoiceState[]) {
        if (state.userId !== myId) sessionStarts.set(state.userId, now);
    }
    startSaveInterval();
}

function stopTrackingChannel() {
    stopSaveInterval();
    if (!trackedChannelId) return;
    flushActiveSessions();
    sessionStarts.clear();
    trackedChannelId = null;
    void persistTotals();
}

function getLiveSeconds(userId: string): number {
    if (!activeUserId || UserStore.getCurrentUser()?.id !== activeUserId) return 0;
    const stored = totalsByUser.get(userId) ?? 0;
    const startedAt = sessionStarts.get(userId);
    return startedAt !== undefined ? stored + Math.floor((performance.now() - startedAt) / 1000) : stored;
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

const VoiceStatsSection = ErrorBoundary.wrap(({ userId, isSideBar }: { userId: string; isSideBar: boolean; }) => {
    useTimer({});

    const seconds = getLiveSeconds(userId);
    if (seconds <= 0) return null;

    const text = formatDuration(seconds);

    if (isSideBar) {
        return (
            <Section
                heading="Voice Time"
                headingVariant="text-xs/semibold"
                headingColor="text-strong"
            >
                <BaseText size="sm">{text}</BaseText>
            </Section>
        );
    }

    return (
        <Section
            heading="Voice Time"
            headingVariant="text-xs/medium"
            headingColor="text-default"
            className="vc-voicestats-profile-section"
        >
            <div className={wrapperClasses.memberSinceWrapper}>
                <div className={containerClasses.memberSince}>
                    <svg
                        aria-hidden="true"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="var(--interactive-icon-default)"
                    >
                        <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4Z" />
                        <path d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z" />
                    </svg>
                    <BaseText size="sm">{text}</BaseText>
                </div>
            </div>
        </Section>
    );
}, { noop: true });

function isTotals(value: unknown): value is Record<string, number> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.values(value).every(seconds => typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0);
}

async function recoverLegacyTotals(userId: string) {
    if (recovering || UserStore.getCurrentUser()?.id !== userId) return;
    recovering = true;
    const resume = pluginEnabled;
    pluginStarted = false;
    stopTrackingChannel();
    const generation = ++startGeneration;
    try {
        await persistTotals();
        await pendingSave;
        if (pendingTotalsByAccount.has(userId)) throw new Error("Save pending totals before recovering old statistics.");
        let recovered = false;
        let legacyTotals: Record<string, number> = {};
        await updateMany<[unknown, unknown, Record<string, number>]>([
            [storageKey, legacy => {
                if (!isTotals(legacy)) throw new Error("No valid old statistics were found.");
                legacyTotals = legacy;
                return legacy;
            }],
            [`${storageKey}:recovered:${userId}`, marker => {
                recovered = marker === true;
                return true;
            }],
            [`${storageKey}:${userId}`, current => {
                if (generation !== startGeneration || UserStore.getCurrentUser()?.id !== userId) throw new Error("The account changed during recovery.");
                if (current !== undefined && !isTotals(current)) throw new Error("Saved statistics are invalid.");
                if (recovered) return current ?? {};
                const totals = new Map(Object.entries(current ?? {}));
                for (const [id, seconds] of Object.entries(legacyTotals)) {
                    const total = (totals.get(id) ?? 0) + seconds;
                    if (!Number.isSafeInteger(total)) throw new Error("Recovered statistics exceed the supported total.");
                    totals.set(id, total);
                }
                return Object.fromEntries(totals);
            }]
        ]);
        showToast(recovered ? "Old statistics were already recovered for this account." : "Old statistics recovered.", Toasts.Type.SUCCESS);
    } catch (error) {
        logger.error("Could not recover old voice statistics.", error);
        showToast("Could not recover old voice statistics. Your saved records were kept.", Toasts.Type.FAILURE);
    } finally {
        recovering = false;
        if (resume && generation === startGeneration && UserStore.getCurrentUser()?.id === userId) await loadAccountTotals();
    }
}

function RecoverySettings() {
    return <Button onClick={() => {
        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) return;
        Alerts.show({
            title: "Recover Old Voice Statistics",
            body: "Old totals have no recorded account owner. Add them to this account once? The original record will be kept.",
            confirmText: "Recover",
            onConfirm: () => { void recoverLegacyTotals(userId); }
        });
    }}>Recover Old Voice Statistics</Button>;
}

async function loadAccountTotals() {
    pluginStarted = false;
    stopTrackingChannel();
    const generation = ++startGeneration;
    const userId = UserStore.getCurrentUser()?.id;
    activeUserId = userId;
    totalsByUser.clear();
    totalsDirty = false;
    if (!userId) return;

    let saved: unknown;
    try {
        saved = await get<unknown>(`${storageKey}:${userId}`);
    } catch (error) {
        logger.error("Could not load voice statistics.", error);
        return;
    }
    if (generation !== startGeneration || UserStore.getCurrentUser()?.id !== userId) return;
    if (saved !== undefined && !isTotals(saved)) {
        logger.error("Saved voice statistics are invalid. Tracking has been paused to preserve them.");
        return;
    }
    const pending = pendingTotalsByAccount.get(userId);
    totalsDirty = pending !== undefined;
    for (const [id, value] of Object.entries(pending ?? (saved ?? {}))) totalsByUser.set(id, value);
    pluginStarted = true;

    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (channelId) startTrackingChannel(channelId, userId);
}

export default definePlugin({
    name: "VoiceStats",
    description: "Shows how long you've spent in voice with each user in their profile",
    tags: ["Voice", "Friends"],
    authors: [EquicordDevs.Moowi],
    dependencies: ["ProfileSectionsAPI"],
    settingsAboutComponent: RecoverySettings,
    renderProfileSection: {
        render: VoiceStatsSection,
        priority: 0,
    },
    flux: {
        LOGOUT() {
            startGeneration++;
            stopTrackingChannel();
            activeUserId = undefined;
            totalsByUser.clear();
            totalsDirty = false;
        },
        CONNECTION_OPEN: loadAccountTotals,
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            if (!pluginStarted) return;

            const myId = UserStore.getCurrentUser()?.id;
            if (!myId || myId !== activeUserId) return;

            for (const state of voiceStates) {
                const { userId, channelId, oldChannelId } = state;

                if (userId === myId) {
                    if (!oldChannelId && channelId) startTrackingChannel(channelId, myId);
                    else if (oldChannelId && !channelId) stopTrackingChannel();
                    else if (channelId && channelId !== oldChannelId) {
                        startTrackingChannel(channelId, myId);
                    }
                    continue;
                }

                const joinedMyChannel = trackedChannelId !== null && channelId === trackedChannelId && oldChannelId !== trackedChannelId;
                const leftMyChannel = trackedChannelId !== null && oldChannelId === trackedChannelId && channelId !== trackedChannelId;

                if (joinedMyChannel) {
                    if (!sessionStarts.has(userId)) {
                        sessionStarts.set(userId, performance.now());
                        startSaveInterval();
                    }
                } else if (leftMyChannel && sessionStarts.has(userId)) {
                    const startedAt = sessionStarts.get(userId)!;
                    const accrued = Math.floor((performance.now() - startedAt) / 1000);
                    if (accrued > 0) {
                        totalsByUser.set(userId, (totalsByUser.get(userId) ?? 0) + accrued);
                        totalsDirty = true;
                    }
                    sessionStarts.delete(userId);
                    if (sessionStarts.size === 0) stopSaveInterval();
                    void persistTotals();
                }
            }
        }
    },

    start() {
        pluginEnabled = true;
        return loadAccountTotals();
    },

    stop() {
        pluginEnabled = false;
        pluginStarted = false;
        startGeneration++;
        stopTrackingChannel();
        sessionStarts.clear();
    }
});
