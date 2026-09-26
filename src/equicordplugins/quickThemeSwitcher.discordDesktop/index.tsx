/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings, SettingsStore } from "@api/Settings";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { debounce } from "@shared/debounce";
import { Devs, IS_MAC } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

const { VencordNative } = window;

interface ThemeItem {
    name: string;
    id: string;
    type: "local" | "online";
}

interface ThemeFile {
    fileName: string;
}

let themeList: ThemeItem[] = [];
let currentIndex = 0;
let fileWatcher: ReturnType<typeof setTimeout> | null = null;
let fileWatcherRunning = false;
let lastThemeCount = 0;
let pluginStarted = false;
let skipNextIndexUpdate = false;
let startGeneration = 0;
const fileWatcherIntervalMs = 2000;

function countLocalThemeItems(themes: ThemeItem[]) {
    let count = 0;
    for (const theme of themes) {
        if (theme.type === "local") count++;
    }
    return count;
}

function countLocalThemeFiles(themes: ThemeFile[]) {
    let count = 0;
    for (const theme of themes) {
        if (theme.fileName.endsWith(".css") && theme.fileName !== "source.theme.css") count++;
    }
    return count;
}

const updateCurrentIndex = () => {
    if (skipNextIndexUpdate) return skipNextIndexUpdate = false;
    currentIndex = findCurrentThemeIndex();
};

const refreshThemeList = async (silent = false, generation = startGeneration) => {
    if (!pluginStarted || generation !== startGeneration) return;

    const oldTheme = themeList[currentIndex];
    const oldCount = themeList.length;

    const nextThemeList = await getAllThemes();
    if (!pluginStarted || generation !== startGeneration) return;

    themeList = nextThemeList;
    currentIndex = findCurrentThemeIndex();

    if (oldTheme && themeList[currentIndex]?.id !== oldTheme.id) {
        const newIndex = themeList.findIndex(t => t.id === oldTheme.id && t.type === oldTheme.type);
        if (~newIndex) currentIndex = newIndex;
    }

    if (!silent && themeList.length !== oldCount) {
        const diff = themeList.length - oldCount;
        const action = diff > 0 ? "Added" : "Removed";
        const count = Math.abs(diff);
        showToast(`${action} ${count} theme${count > 1 ? "s" : ""}`, Toasts.Type.SUCCESS);
    }
};

const debouncedRefresh = debounce(() => void refreshThemeList(), 500);

const settings = definePluginSettings({
    includeLocal: {
        type: OptionType.BOOLEAN,
        description: "Include local themes",
        default: true,
        onChange: () => {
            void refreshThemeList();
            syncFileWatcher();
        },
    },
    includeOnline: {
        type: OptionType.BOOLEAN,
        description: "Include online themes",
        default: true,
        onChange: refreshThemeList,
    },
    sortOrder: {
        type: OptionType.SELECT,
        description: "Sort method",
        options: [
            { label: "A-Z", value: "alphabetical", default: true },
            { label: "Z-A", value: "reverse" },
            { label: "Recent", value: "recent" },
        ],
        onChange: refreshThemeList,
    },
    autoRefresh: {
        type: OptionType.BOOLEAN,
        description: "Auto-refresh theme list when changes are detected",
        default: true,
        onChange: syncFileWatcher,
    },
    showNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show notifications when themes are added/removed",
        default: true,
    },
});

async function getAllThemes(): Promise<ThemeItem[]> {
    const themes: ThemeItem[] = [];

    if (settings.store.includeLocal) {
        const localThemes: ThemeFile[] = await VencordNative.themes.getThemesList();
        localThemes.forEach(({ fileName }) => {
            if (!fileName.endsWith(".css") || fileName === "source.theme.css") return;
            themes.push({
                name: Settings.themeNames?.[fileName] ?? fileName.replace(/\.css$/, ""),
                id: fileName,
                type: "local",
            });
        });
    }

    if (settings.store.includeOnline && Settings.themeLinks) {
        Settings.themeLinks.forEach((link: string) => {
            const cleanLink = link.replace(/^@(?:light|dark)\s+/, "");
            const name =
                Settings.themeNames?.[cleanLink] ??
                cleanLink
                    .split("/")
                    .pop()
                    ?.replace(/\.css$/, "") ??
                cleanLink;
            themes.push({
                name,
                id: link,
                type: "online",
            });
        });
    }

    const { sortOrder } = settings.store;
    if (sortOrder === "alphabetical") {
        themes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } else if (sortOrder === "reverse") {
        themes.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base" }));
    }

    return themes;
}

function switchTheme(direction: "next" | "prev") {
    // empty arrays are truthy so need length to check emptiness
    if (!themeList.length) return;

    currentIndex =
        direction === "next"
            ? (currentIndex + 1) % themeList.length
            : (currentIndex - 1 + themeList.length) % themeList.length;

    applyTheme(themeList[currentIndex]);
}

function applyTheme(theme: ThemeItem) {
    const isLocal = theme.type === "local";
    Settings.enabledThemes = isLocal ? [theme.id] : [];
    Settings.enabledThemeLinks = isLocal ? [] : [theme.id];
}

function findCurrentThemeIndex(): number {
    const enabledLocal = Settings.enabledThemes?.[0];
    const enabledOnline = Settings.enabledThemeLinks?.[0];

    const idx = themeList.findIndex(
        t => (t.type === "local" && t.id === enabledLocal) || (t.type === "online" && t.id === enabledOnline),
    );

    return ~idx ? idx : 0;
}

function toggleCurrentTheme(enable: boolean) {
    // empty arrays are truthy so need length to check emptiness
    if (!themeList.length) return;

    const theme = themeList[currentIndex];
    const isLocal = theme.type === "local";
    const arr = isLocal ? Settings.enabledThemes : Settings.enabledThemeLinks;
    const isEnabled = arr.includes(theme.id);

    if (enable === isEnabled) return;

    skipNextIndexUpdate = true;

    if (isLocal) {
        Settings.enabledThemes = enable ? [...arr, theme.id] : arr.filter((t: string) => t !== theme.id);
    } else {
        Settings.enabledThemeLinks = enable ? [...arr, theme.id] : arr.filter((t: string) => t !== theme.id);
    }
}

async function reloadThemes() {
    await refreshThemeList(true);
    showToast(`Reloaded ${themeList.length} themes`, Toasts.Type.SUCCESS);
}

async function watchForLocalThemeChanges(generation = startGeneration) {
    if (!pluginStarted || generation !== startGeneration || !settings.store.autoRefresh || !settings.store.includeLocal) return;

    const currentThemes = await VencordNative.themes.getThemesList();
    if (!pluginStarted || generation !== startGeneration) return;

    const currentCount = countLocalThemeFiles(currentThemes);

    if (currentCount !== lastThemeCount) {
        const diff = currentCount - lastThemeCount;
        await refreshThemeList(true, generation);
        if (!pluginStarted || generation !== startGeneration) return;

        if (settings.store.showNotifications) {
            const action = diff > 0 ? "Added" : "Removed";
            const count = Math.abs(diff);
            showToast(`${action} ${count} local theme${count > 1 ? "s" : ""}`, Toasts.Type.SUCCESS);
        }
    }

    lastThemeCount = currentCount;
}

function startFileWatcher() {
    if (fileWatcherRunning || !settings.store.autoRefresh || !settings.store.includeLocal) return;

    fileWatcherRunning = true;
    const generation = startGeneration;
    void watchForLocalThemeChanges(generation).finally(() => scheduleNextFileWatch(generation));
}

function scheduleNextFileWatch(generation = startGeneration) {
    if (!pluginStarted || generation !== startGeneration || !fileWatcherRunning || fileWatcher || !settings.store.autoRefresh || !settings.store.includeLocal) return;

    fileWatcher = setTimeout(() => {
        fileWatcher = null;
        void watchForLocalThemeChanges(generation).finally(() => scheduleNextFileWatch(generation));
    }, fileWatcherIntervalMs);
}

function stopFileWatcher() {
    fileWatcherRunning = false;
    if (!fileWatcher) return;

    clearTimeout(fileWatcher);
    fileWatcher = null;
}

function syncFileWatcher() {
    if (settings.store.autoRefresh && settings.store.includeLocal) startFileWatcher();
    else stopFileWatcher();
}

const isCtrl = (e: KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);

function handleKeyDown(e: KeyboardEvent) {
    // using || because we want to exit if EITHER condition is false (need both ctrl AND shift)
    if (!isCtrl(e) || !e.shiftKey) return;

    if (e.altKey) {
        e.preventDefault();
        reloadThemes();
        return;
    }

    const actions: Record<string, () => void> = {
        ArrowRight: () => switchTheme("next"),
        ArrowLeft: () => switchTheme("prev"),
        ArrowUp: () => toggleCurrentTheme(true),
        ArrowDown: () => toggleCurrentTheme(false),
    };

    const action = actions[e.key];
    if (!action) return;

    e.preventDefault();
    action();
}

const handleThemeLinksChange = () => settings.store.autoRefresh && debouncedRefresh();

const handleThemeNamesChange = () => settings.store.autoRefresh && debouncedRefresh();

export default definePlugin({
    name: "QuickThemeSwitcher",
    description: "Quickly switch between themes using keyboard shortcuts.",
    tags: ["Appearance", "Utility"],
    authors: [Devs.prism],
    settings,
    startAt: StartAt.DOMContentLoaded,
    settingsAboutComponent: () => (
        <>
            <HeadingSecondary>Bindings</HeadingSecondary>
            <Paragraph>
                Use Ctrl/Cmd+Shift+Arrows to navigate (Left/Right: cycle themes, Up: enable, Down: disable).
                <br />
                Press Ctrl/Cmd+Shift+Alt to reload the theme list.
            </Paragraph>
        </>
    ),

    async start() {
        pluginStarted = true;
        const generation = ++startGeneration;

        themeList = await getAllThemes();
        if (!pluginStarted || generation !== startGeneration) return;

        currentIndex = findCurrentThemeIndex();
        lastThemeCount = countLocalThemeItems(themeList);

        document.addEventListener("keydown", handleKeyDown);

        SettingsStore.addChangeListener("themeLinks", handleThemeLinksChange);
        SettingsStore.addChangeListener("themeNames", handleThemeNamesChange);
        SettingsStore.addChangeListener("enabledThemes", updateCurrentIndex);
        SettingsStore.addChangeListener("enabledThemeLinks", updateCurrentIndex);

        syncFileWatcher();
    },

    stop() {
        pluginStarted = false;
        startGeneration++;

        document.removeEventListener("keydown", handleKeyDown);

        SettingsStore.removeChangeListener("themeLinks", handleThemeLinksChange);
        SettingsStore.removeChangeListener("themeNames", handleThemeNamesChange);
        SettingsStore.removeChangeListener("enabledThemes", updateCurrentIndex);
        SettingsStore.removeChangeListener("enabledThemeLinks", updateCurrentIndex);

        stopFileWatcher();

        themeList = [];
        currentIndex = 0;
        lastThemeCount = 0;
        skipNextIndexUpdate = false;
    },
});
