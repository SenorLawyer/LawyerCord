/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserStore } from "@webpack/common";

export let initialQuestDataFetched = false;
let settingsModalOpen = false;
export let questSession: { userId: string; } | undefined;

export function beginQuestSession(): void {
    const userId = UserStore.getCurrentUser()?.id;
    questSession = userId ? { userId } : undefined;
}

export function endQuestSession(): void {
    questSession = undefined;
}

export function isQuestSessionCurrent(session = questSession): boolean {
    return session !== undefined && session === questSession && session.userId === UserStore.getCurrentUser()?.id;
}

export function setInitialQuestDataFetched(fetched: boolean): void {
    initialQuestDataFetched = fetched;
}

export function setSettingsModalOpen(open: boolean): void {
    settingsModalOpen = open;
}

export function getSettingsModalOpen(): boolean {
    return settingsModalOpen;
}
