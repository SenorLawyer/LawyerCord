/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Plugin, PluginTag } from "@utils/types";

export const PAGE_SIZE = 36;
export const IMPACT_LABELS = { low: "Low", medium: "Moderate", high: "High", unknown: "Not reviewed" } as const;

export interface CatalogFilters {
    query: string;
    tags: PluginTag[];
    status: "all" | "enabled" | "disabled";
    source: "all" | "lawyercord" | "vencord" | "user";
    feature: "all" | "new" | "settings" | "api";
    impact: "all" | keyof typeof IMPACT_LABELS;
    sort: "name" | "impact" | "new";
}

export const DEFAULT_FILTERS: CatalogFilters = { query: "", tags: [], status: "all", source: "all", feature: "all", impact: "all", sort: "name" };

interface PluginOrigin { folderName: string; userPlugin: boolean; }

export function createCatalog(plugins: Record<string, Plugin>, meta: Record<string, PluginOrigin>) {
    return Object.values(plugins).map(plugin => ({
        plugin,
        source: meta[plugin.name].userPlugin ? "user" : meta[plugin.name].folderName.startsWith("src/equicordplugins/") ? "lawyercord" : "vencord",
        search: [plugin.name, plugin.name.match(/[A-Z]/g)?.join("") ?? "", plugin.description, ...plugin.searchTerms ?? []].map(text => text.toLowerCase()),
        name: plugin.name.toLowerCase()
    })).sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
}

export function filterCatalog(catalog: ReturnType<typeof createCatalog>, filters: CatalogFilters, enabled: Set<string>, newPlugins: Set<string> | null, hasSettings: (plugin: Plugin) => boolean) {
    const query = filters.query.trim().toLowerCase();
    const compactQuery = query.replace(/\s+/g, "");
    const ranks = { low: 0, medium: 1, high: 2, unknown: 3 };
    const matches = catalog.filter(({ plugin, source, search, name }) => {
        if (plugin.hidden || (plugin.name.endsWith("API") && !hasSettings(plugin) && filters.feature !== "api")) return false;
        if (filters.status !== "all" && enabled.has(plugin.name) !== (filters.status === "enabled")) return false;
        if (filters.source !== "all" && filters.source !== source) return false;
        if (filters.feature === "new" && !newPlugins?.has(plugin.name)) return false;
        if (filters.feature === "settings" && !hasSettings(plugin)) return false;
        if (filters.feature === "api" && !plugin.name.endsWith("API")) return false;
        if (filters.impact !== "all" && filters.impact !== (plugin.performance?.impact ?? "unknown")) return false;
        if (filters.tags.some(tag => !plugin.tags?.includes(tag))) return false;
        return !query || name.includes(compactQuery) || search.some(text => text.includes(query));
    });
    if (filters.sort === "impact") matches.sort((a, b) => ranks[a.plugin.performance?.impact ?? "unknown"] - ranks[b.plugin.performance?.impact ?? "unknown"]);
    if (filters.sort === "new") matches.sort((a, b) => Number(newPlugins?.has(b.plugin.name) ?? false) - Number(newPlugins?.has(a.plugin.name) ?? false));
    return matches.map(entry => entry.plugin);
}

export function catalogPage<T>(entries: T[], requestedPage: number) {
    const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
    return { entries: entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), page, pageCount };
}
