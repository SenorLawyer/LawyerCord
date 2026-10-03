/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { UpdateChannel } from "./updateChannel";

export interface UpdateRelease {
    tag: string;
    name: string;
    channel: UpdateChannel;
    publishedAt: string;
    version?: string;
}

export interface ReleaseCatalog {
    releases: UpdateRelease[];
    hasMore: boolean;
}

export interface ReleaseUpdate extends UpdateRelease {
    commit: string;
    currentVersion: string;
    restartRequired?: boolean;
    relation: "current" | "upgrade" | "rollback" | "switch";
    changes: Record<"hash" | "author" | "message", string>[];
}
