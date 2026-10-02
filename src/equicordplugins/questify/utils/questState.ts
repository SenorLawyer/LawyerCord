/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Quest, QuestTask } from "@vencord/discord-types";
import { QuestTaskType } from "@vencord/discord-types/enums";
import { QuestStore } from "@webpack/common";

import { getQuestifySettings, useQuestifySettings } from "../settings/access";
import { ignoredQuestIDsKey } from "../settings/def";
import { type QuestIncludedTypes, questMatchesIncludedTypes } from "./filtering";

export enum QuestStatus {
    Claimed = "CLAIMED",
    Unclaimed = "UNCLAIMED",
    Ignored = "IGNORED",
    Expired = "EXPIRED",
}

const questProgressTaskPriority = [
    QuestTaskType.WATCH_VIDEO,
    QuestTaskType.WATCH_VIDEO_ON_MOBILE,
    QuestTaskType.ACHIEVEMENT_IN_ACTIVITY,
    QuestTaskType.ACHIEVEMENT_IN_GAME,
    QuestTaskType.PLAY_ACTIVITY,
    QuestTaskType.PLAY_ON_DESKTOP,
    QuestTaskType.PLAY_ON_DESKTOP_V2,
    QuestTaskType.STREAM_ON_DESKTOP,
    QuestTaskType.PLAY_ON_PLAYSTATION,
    QuestTaskType.PLAY_ON_XBOX,
] as const satisfies readonly QuestTaskType[];

interface QuestPanelPercentCompleteOptions {
    quest?: Quest | null;
    percentCompleteText?: string;
}

interface QuestPanelPercentCompleteResult {
    percentComplete: number;
    percentCompleteText?: string;
}

interface QuestEmbedProgressResult {
    completedRatio: number;
    completedRatioDisplay?: string;
}

interface QuestProgressEntry {
    eventName?: QuestTaskType;
    heartbeat?: { lastBeatAt?: string | null; } | null;
    updatedAt?: string | null;
}

export function refreshQuest(quest: Quest): Quest {
    return QuestStore.getQuest(quest.id) ?? quest;
}

export function isVideoQuestTask(taskType: QuestTaskType): boolean {
    return taskType === QuestTaskType.WATCH_VIDEO || taskType === QuestTaskType.WATCH_VIDEO_ON_MOBILE;
}

function getQuestTaskByType(quest: Quest, taskType: QuestTaskType): QuestTask | null {
    return quest.config.taskConfigV2?.tasks[taskType] ?? null;
}

function getVideoQuestTask(quest: Quest): QuestTask | null {
    return getQuestTaskByType(quest, QuestTaskType.WATCH_VIDEO)
        ?? getQuestTaskByType(quest, QuestTaskType.WATCH_VIDEO_ON_MOBILE);
}

function getProgressTimestamp(progress: QuestProgressEntry): number {
    const timestamp = progress.heartbeat?.lastBeatAt ?? progress.updatedAt;
    const time = timestamp ? new Date(timestamp).getTime() : 0;

    return Number.isFinite(time) ? time : 0;
}

function getLatestProgressTask(quest: Quest): QuestTask | null {
    const progressEntries = Object.entries(quest.userStatus?.progress ?? {}) as [QuestTaskType, QuestProgressEntry][];
    let latestTask: QuestTask | null = null;
    let latestTime = -Infinity;

    for (const [fallbackTaskType, progress] of progressEntries) {
        const task = getQuestTaskByType(quest, progress.eventName ?? fallbackTaskType);

        if (task) {
            const time = getProgressTimestamp(progress);
            if (time > latestTime) {
                latestTask = task;
                latestTime = time;
            }
        }
    }

    return latestTask;
}

function getQuestProgressTask(quest: Quest): QuestTask | null {
    if (!quest.config.taskConfigV2?.tasks) {
        return null;
    }

    const progressTask = getLatestProgressTask(quest) ?? getVideoQuestTask(quest);

    if (progressTask) {
        return progressTask;
    }

    for (const taskType of questProgressTaskPriority) {
        const task = getQuestTaskByType(quest, taskType);

        if (task) {
            return task;
        }
    }

    return null;
}

export function getQuestStoredProgress(quest: Quest, task: QuestTask): number | null {
    if (quest.userStatus?.completedAt) {
        return task.target;
    }

    const progressMap = quest.userStatus?.progress;

    if (!progressMap) {
        return null;
    }

    if (isVideoQuestTask(task.type)) {
        const watchProgress = progressMap.WATCH_VIDEO?.value;
        const mobileProgress = progressMap.WATCH_VIDEO_ON_MOBILE?.value;

        return watchProgress !== undefined || mobileProgress !== undefined
            ? Math.max(watchProgress ?? 0, mobileProgress ?? 0)
            : null;
    }

    return progressMap[task.type]?.value ?? null;
}

function getMostRecentlyCompletedUnclaimedQuest(): Quest | null {
    const ignoredQuestIds = getQuestifySettings().ignoredQuestIDs[ignoredQuestIDsKey] ?? [];
    let latestQuest: Quest | null = null;
    let latestTime = -Infinity;

    for (const quest of QuestStore.quests.values()) {
        const completedAt = quest.userStatus?.completedAt;
        if (!completedAt || getQuestStatus(quest, ignoredQuestIds) !== QuestStatus.Unclaimed) continue;
        const time = new Date(completedAt).getTime();
        if (!latestQuest || time > latestTime) {
            latestQuest = quest;
            latestTime = time;
        }
    }

    return latestQuest;
}

export function getQuestPanelOverride(quest: Quest | null): Quest | null {
    const panelState = useQuestifySettings(["disableQuestsEverything", "disableAccountPanelPromo", "disableAccountPanelQuestProgress"]);

    if (panelState.disableQuestsEverything) {
        return null;
    }

    if (panelState.disableAccountPanelPromo && panelState.disableAccountPanelQuestProgress) {
        return null;
    }

    if (panelState.disableAccountPanelQuestProgress) {
        return quest;
    }

    const nextQuest = getMostRecentlyCompletedUnclaimedQuest();

    return nextQuest ?? (panelState.disableAccountPanelPromo ? null : quest);
}

export function getQuestPanelPercentComplete({
    quest,
    percentCompleteText,
}: QuestPanelPercentCompleteOptions): QuestPanelPercentCompleteResult | null {
    if (!quest) {
        return null;
    }

    const refreshedQuest = refreshQuest(quest);
    const task: QuestTask | null = getQuestProgressTask(refreshedQuest);

    if (!task) {
        return null;
    }

    const questTarget = task.target;
    const questProgress = getQuestStoredProgress(refreshedQuest, task);

    if (!questTarget || questProgress === null) {
        return null;
    }

    const percentComplete = Math.min(1, questProgress / questTarget);

    if (!percentCompleteText) {
        return { percentComplete };
    }

    return {
        percentComplete,
        percentCompleteText: `${Math.floor(percentComplete * 100)}%`,
    };
}

export function getQuestEmbedProgress(quest: Quest | null): QuestEmbedProgressResult | null {
    const progress = getQuestPanelPercentComplete({ quest, percentCompleteText: " " });

    return progress
        ? { completedRatio: progress.percentComplete, completedRatioDisplay: progress.percentCompleteText }
        : null;
}

export function getQuestStatus(
    quest: Quest,
    ignoredQuestIds: ReadonlyArray<string>,
    checkIgnored: boolean = true,
): QuestStatus {
    if (quest.userStatus?.claimedAt) {
        return QuestStatus.Claimed;
    }

    const completedQuest = quest.userStatus?.completedAt;
    const expiredQuest = new Date(quest.config.expiresAt).getTime() < Date.now();
    if (checkIgnored && ignoredQuestIds.includes(quest.id) && (!expiredQuest || completedQuest)) {
        return QuestStatus.Ignored;
    }

    if (completedQuest || !expiredQuest) {
        return QuestStatus.Unclaimed;
    }

    return QuestStatus.Expired;
}

export function countIncludedUnclaimedQuests(
    quests: Quest[],
    ignoredQuestIds: ReadonlyArray<string>,
    includedTypes: QuestIncludedTypes,
): number {
    let count = 0;

    for (const quest of quests) {
        const questStatus = getQuestStatus(quest, ignoredQuestIds);

        if (questMatchesIncludedTypes(quest, includedTypes) && questStatus === QuestStatus.Unclaimed) {
            count++;
        }
    }

    return count;
}
