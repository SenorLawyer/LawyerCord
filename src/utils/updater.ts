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

import { flushSettings } from "@api/Settings";
import type { ReleaseUpdate } from "@shared/updateRelease";

import gitHash from "~git-hash";

import { Logger } from "./Logger";
import { relaunch } from "./native";
import { IpcRes } from "./types";
import { classifyUpdateChanges } from "./updateClassification";

export const UpdateLogger = /* #__PURE__*/ new Logger("Updater", "white");
export let isOutdated = false;
export let isNewer = false;
export let updateError: any;
export let changes: Record<"hash" | "author" | "message", string>[] = [];

export let selectedRelease: ReleaseUpdate | undefined;
export let restartRequired = false;
export let isUpdating = false;

let updateCheck = Symbol();
let needsRebuild = false;
let pendingUpdate: Promise<boolean> | undefined;
const updateListeners = new Set<() => void>();

export const getUpdateState = () => Number(isUpdating) | Number(restartRequired) << 1;
export function subscribeUpdateState(listener: () => void) {
    updateListeners.add(listener);
    return () => { updateListeners.delete(listener); };
}

export const waitForPendingUpdate = () => pendingUpdate;

function Unwrap<T>(res: IpcRes<T>) {
    if (res.ok) return res.value;

    updateError = res.error;
    throw res.error;
}

export const getReleaseCatalog = async (page = 1) => Unwrap(await VencordNative.updater.getReleases(page));

export async function checkForUpdates(tag?: string) {
    if (pendingUpdate || needsRebuild || restartRequired) return isOutdated;
    const check = updateCheck = Symbol();
    updateError = undefined;
    if (IS_STANDALONE) {
        const result = await VencordNative.updater.checkRelease(Vencord.Settings.updateChannel, tag);
        if (check !== updateCheck) return isOutdated;
        selectedRelease = Unwrap(result);
        changes = selectedRelease.changes;
        if (selectedRelease.restartRequired) {
            restartRequired = true;
            isOutdated = isNewer = false;
            updateListeners.forEach(listener => listener());
            return false;
        }
        isNewer = selectedRelease.relation === "rollback";
        return (isOutdated = selectedRelease.relation === "upgrade");
    }
    const result = await VencordNative.updater.getUpdates(Vencord.Settings.updateChannel);
    if (check !== updateCheck) return isOutdated;
    changes = Unwrap(result);

    const classification = classifyUpdateChanges(changes, gitHash);
    isNewer = classification.isNewer;
    return (isOutdated = classification.isOutdated);
}

export function resetUpdateState() {
    if (pendingUpdate || needsRebuild || restartRequired) return;
    selectedRelease = undefined;
    updateCheck = Symbol();
    needsRebuild = false;
    isOutdated = false;
    isNewer = false;
    updateError = undefined;
    changes = [];
}

export async function update(tag?: string) {
    if (pendingUpdate) return pendingUpdate;
    if (restartRequired) return true;
    if (!isOutdated && !(IS_STANDALONE && tag)) return true;

    const check = updateCheck = Symbol();
    isUpdating = true;
    pendingUpdate = (async () => {
        if (!needsRebuild) {
            if (IS_STANDALONE) await flushSettings();
            const result = await VencordNative.updater.update(Vencord.Settings.updateChannel, tag);
            if (check !== updateCheck) return false;
            if (!Unwrap(result)) return false;
            needsRebuild = true;
        }

        const result = await VencordNative.updater.rebuild();
        if (check !== updateCheck) return false;
        if (!Unwrap(result))
            throw new Error(IS_STANDALONE ? "The update could not be installed. Try downloading it again." : "The build failed. Try building the update manually.");

        needsRebuild = false;
        restartRequired = IS_STANDALONE;
        isOutdated = false;
        if (IS_STANDALONE) {
            selectedRelease = undefined;
            try {
                const installed = await VencordNative.updater.checkRelease(Vencord.Settings.updateChannel);
                if (installed.ok) selectedRelease = installed.value;
            } catch (error) {
                UpdateLogger.warn("Could not read the downloaded release details", error);
            }
        }
        return true;
    })().finally(() => {
        pendingUpdate = undefined;
        if (IS_STANDALONE && !restartRequired) needsRebuild = false;
        isUpdating = false;
        updateListeners.forEach(listener => listener());
    });
    updateListeners.forEach(listener => listener());
    return pendingUpdate;
}

export const getRepo = async () => Unwrap(await VencordNative.updater.getRepo());

export async function maybePromptToUpdate(confirmMessage: string, checkForDev = false) {
    if (IS_WEB || IS_UPDATER_DISABLED) return;
    if (checkForDev && IS_DEV) return;

    try {
        const isOutdated = await checkForUpdates();
        if (isOutdated) {
            const wantsUpdate = confirm(confirmMessage);
            if (wantsUpdate && isNewer) return alert("Your local copy has more recent commits. Please stash or reset them.");
            if (wantsUpdate && await update()) relaunch();
        }
    } catch (err) {
        UpdateLogger.error(err);
        alert("That also failed :( Try updating or re-installing with the installer!");
    }
}
