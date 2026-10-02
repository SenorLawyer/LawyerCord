/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { playAudio } from "@api/AudioPlayer";
import { showNotification } from "@api/Notifications";
import { sleep } from "@utils/misc";
import type { PluginNative } from "@utils/types";
import type { Quest } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { QuestStore, RestAPI } from "@webpack/common";
import { NavigationRouter } from "@webpack/common/utils";

import { getQuestifySettings } from "../settings/access";
import { questIsIgnored } from "../settings/ignoredQuests";
import { isQuestSessionCurrent, questSession } from "../state";
import { getNewQuests, normalizeQuestName, type QuestIncludedTypes, questMatchesIncludedTypes } from "./filtering";
import { QL } from "./logging";
import { QUEST_PAGE } from "./ui";

const QuestifyNative = VencordNative?.pluginHelpers?.Questify as PluginNative<typeof import("../native")> | undefined;

export const fetchAndDispatchQuests = findByCodeLazy("QUESTS_FETCH_CURRENT_QUESTS_BEGIN");
const parseQuestConfig = findByCodeLazy("config).with({config_version:");
const formatQuestData = findByCodeLazy("config),userStatus:null==");
let pendingFetch: { session: typeof questSession; promise: Promise<Quest[] | null>; } | undefined;

async function fetchQuestById(questId: string): Promise<Quest | null> {
    try {
        const { body } = await RestAPI.get({ url: `/quests/${questId}`, retries: 3 });
        const valid = !!parseQuestConfig({ config: body });

        if (!valid) {
            QL.warn("FETCH_QUEST_BY_ID_INVALID_BODY", { questId, body });

            return null;
        }

        return formatQuestData(body);
    } catch (error: unknown) {
        QL.warn("FETCH_QUEST_BY_ID_FAILED", { questId, error });

        return null;
    }
}

async function fetchExcludedQuestConfigs(questIds: string[], session: typeof questSession): Promise<Quest[]> {
    const quests: Quest[] = [];

    for (const [index, questId] of questIds.entries()) {
        if (index > 0) {
            await sleep(1000);
        }
        if (!isQuestSessionCurrent(session)) break;

        const quest = await fetchQuestById(questId);
        if (!isQuestSessionCurrent(session)) break;

        if (quest) {
            quests.push(quest);
        }
    }

    return quests;
}

export function canOpenDevToolsWindow(): boolean {
    return typeof QuestifyNative?.canOpenDevTools === "function"
        && typeof QuestifyNative?.openDevTools === "function";
}

export async function openDevToolsWindow(): Promise<boolean> {
    if (!canOpenDevToolsWindow()) {
        return false;
    }

    const native = QuestifyNative!;

    return await native.canOpenDevTools()
        ? native.openDevTools()
        : false;
}

function getQuestNotificationText(quests: Quest[], excluded: boolean): { title: string; body: string; } {
    const firstQuest = quests[0];
    const firstQuestName = normalizeQuestName(firstQuest);

    if (quests.length === 1) {
        return {
            title: excluded ? "New Excluded Quest Detected!" : "New Quest Detected!",
            body: excluded
                ? `The excluded ${firstQuestName} Quest was detected. ID: ${firstQuest.id}`
                : `The ${firstQuestName} Quest is now available.`
        };
    }

    return {
        title: excluded ? "New Excluded Quests Detected!" : "New Quests Detected!",
        body: excluded
            ? `${quests.length} new excluded Quests were detected. Review your Questify excluded quest settings.`
            : `${quests.length} new Quests are now available.`
    };
}

function notifyNewQuests(quests: Quest[], excluded: boolean, session: typeof questSession): void {
    if (quests.length === 0) return;

    const firstQuest = quests[0];
    const { title, body } = getQuestNotificationText(quests, excluded);
    const onClick = excluded
        ? canOpenDevToolsWindow() ? openDevToolsWindow : undefined
        : () => NavigationRouter.transitionTo(`${QUEST_PAGE}#${firstQuest.id}`);

    showNotification({
        title,
        body,
        dismissOnClick: true,
        onClick: onClick ? () => { if (isQuestSessionCurrent(session)) void onClick(); } : undefined
    });
}

async function doFetchAndAlertQuests(session: typeof questSession): Promise<Quest[] | null> {
    const settings = getQuestifySettings();
    const alertSound = settings.newQuestAlertSound;
    const alertVolume = settings.newQuestAlertVolume;
    const excludedAlertSound = settings.newExcludedQuestAlertSound;
    const excludedAlertVolume = settings.newExcludedQuestAlertVolume;
    const shouldFetchExcludedQuests = settings.notifyOnNewExcludedQuests || Boolean(excludedAlertSound);
    const currentQuests = Array.from(QuestStore.quests.values());
    const currentExcludedQuestIds = new Set(Array.from(QuestStore.excludedQuests.values()).map(quest => quest.id));
    const includedTypes = settings.questButtonIncludedTypes as QuestIncludedTypes;

    await fetchAndDispatchQuests();
    if (!isQuestSessionCurrent(session)) return null;
    await sleep(1000);
    if (!isQuestSessionCurrent(session)) return null;

    const nextQuests = Array.from(QuestStore.quests.values());

    if (currentQuests.length === 0) {
        return nextQuests;
    }

    const newQuests = getNewQuests(currentQuests, nextQuests);
    const newExcludedQuestIds = shouldFetchExcludedQuests
        ? Array.from(QuestStore.excludedQuests.values())
            .map(quest => quest.id)
            .filter(questId => !currentExcludedQuestIds.has(questId))
        : [];

    if (newQuests.length === 0 && newExcludedQuestIds.length === 0) {
        return nextQuests;
    }

    const newExcludedQuests = newExcludedQuestIds.length > 0 ? await fetchExcludedQuestConfigs(newExcludedQuestIds, session) : [];
    if (!isQuestSessionCurrent(session)) return null;
    const newIncludedQuests = newQuests.filter(quest => questMatchesIncludedTypes(quest, includedTypes) && !questIsIgnored(quest.id));
    const newIncludedExcludedQuests = newExcludedQuests.filter(quest => questMatchesIncludedTypes(quest, includedTypes) && !questIsIgnored(quest.id));
    const shouldNotify = settings.notifyOnNewQuests && newIncludedQuests.length > 0;
    const shouldNotifyExcluded = settings.notifyOnNewExcludedQuests && newIncludedExcludedQuests.length > 0;

    if (alertSound && newIncludedQuests.length > 0) {
        playAudio(
            alertSound,
            { volume: Math.max(0, Math.min(100, alertVolume)) }
        );
    }

    if (excludedAlertSound && newIncludedExcludedQuests.length > 0) {
        playAudio(
            excludedAlertSound,
            { volume: Math.max(0, Math.min(100, excludedAlertVolume)) }
        );
    }

    if (shouldNotify) {
        notifyNewQuests(newIncludedQuests, false, session);
    }

    if (shouldNotifyExcluded) {
        notifyNewQuests(newIncludedExcludedQuests, true, session);
    }

    return nextQuests;
}

export async function fetchAndAlertQuests(_source: string): Promise<Quest[] | null> {
    const session = questSession;
    if (!isQuestSessionCurrent(session)) return null;
    if (pendingFetch && pendingFetch.session === session) {
        return pendingFetch.promise;
    }

    const request = { session, promise: doFetchAndAlertQuests(session).catch(error => {
        if (isQuestSessionCurrent(session)) QL.warn("Could not fetch quests", error);
        return null;
    }) };
    pendingFetch = request;

    try {
        return await request.promise;
    } finally {
        if (pendingFetch === request) pendingFetch = undefined;
    }
}
