/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { notifyPaletteChange } from "../api/registry";

const logger = new Logger("CommandPalette");

export function createPersistedValue<T>(key: string, fallback: T) {
    const fullKey = `CommandPalette_${key}`;
    let value = fallback;
    let revision = 0;

    return {
        async load() {
            const loadingRevision = ++revision;
            const stored = await DataStore.get<T>(fullKey);
            if (loadingRevision === revision && stored !== undefined) value = stored;
        },
        get(): T {
            return value;
        },
        set(next: T) {
            revision++;
            value = next;
            void DataStore.set(fullKey, next).catch(error => logger.error("Failed to save palette settings", error));
            notifyPaletteChange();
        }
    };
}
