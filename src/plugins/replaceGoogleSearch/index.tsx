/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings, migratePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Menu } from "@webpack/common";

const DefaultEngines = {
    Google: "https://www.google.com/search?q=",
    DuckDuckGo: "https://duckduckgo.com/?q=",
    Brave: "https://search.brave.com/search?q=",
    Bing: "https://www.bing.com/search?q=",
    Yahoo: "https://search.yahoo.com/search?p=",
    Yandex: "https://yandex.com/search/?text=",
    GitHub: "https://github.com/search?q=",
    Reddit: "https://www.reddit.com/search?q=",
    Wikipedia: "https://wikipedia.org/w/index.php?search=",
    Startpage: "https://www.startpage.com/sp/search?query="
} as const;

const enum ReplacementEngineValue {
    OFF = "off",
    CUSTOM = "custom",
}

interface SearchEngineEntry {
    name: string;
    url: string;
    iconUrl: string | null;
}

function getEngineIconUrl(url: string) {
    try {
        return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`;
    } catch {
        return null;
    }
}

function makeEngineEntry(name: string, url: string): SearchEngineEntry {
    return {
        name,
        url,
        iconUrl: getEngineIconUrl(url),
    };
}

const defaultEngineEntries = Object.entries(DefaultEngines).map(([name, url]) => makeEngineEntry(name, url));
const defaultEngineOptions = defaultEngineEntries.map(({ name }) => ({ label: name, value: name }));

const settings = definePluginSettings({
    customEngineName: {
        description: "Name of the custom search engine",
        type: OptionType.STRING,
        placeholder: "Google"
    },
    customEngineURL: {
        displayName: "Custom Engine URL",
        description: "The URL of your Engine",
        type: OptionType.STRING,
        placeholder: "https://google.com/search?q="
    },
    replacementEngine: {
        description: "Replace with a specific search engine instead of adding a menu",
        type: OptionType.SELECT,
        options: [
            { label: "Off", value: ReplacementEngineValue.OFF, default: true },
            { label: "Custom Engine", value: ReplacementEngineValue.CUSTOM },
            ...defaultEngineOptions
        ]
    }
});

function search(src: string, engine: string) {
    open(engine + encodeURIComponent(src.trim()), "_blank");
}

function makeSearchItem(src: string) {
    const { customEngineName, customEngineURL, replacementEngine } = settings.store;

    const customName = customEngineName?.trim();
    const customUrl = customEngineURL?.trim();
    const customEngine = customName && customUrl ? makeEngineEntry(customName, customUrl) : null;
    const engineEntries = customEngine
        ? defaultEngineEntries.some(({ name }) => name === customEngine.name)
            ? defaultEngineEntries.map(entry => entry.name === customEngine.name ? customEngine : entry)
            : [...defaultEngineEntries, customEngine]
        : defaultEngineEntries;
    const hasCustomEngine = Boolean(customEngine);
    const hasValidReplacementEngine = replacementEngine !== ReplacementEngineValue.OFF && !(replacementEngine === ReplacementEngineValue.CUSTOM && !hasCustomEngine);

    if (hasValidReplacementEngine) {
        const engine = replacementEngine === ReplacementEngineValue.CUSTOM && customEngine
            ? customEngine
            : engineEntries.find(({ name }) => name === replacementEngine);

        if (!engine) return null;

        return (
            <Menu.MenuItem
                label={`Search with ${engine.name}`}
                key="search-custom-engine"
                id="vc-search-custom-engine"
                action={() => search(src, engine.url)}
            />
        );
    }

    return (
        <Menu.MenuItem
            label="Search Text"
            key="search-text"
            id="vc-search-text"
        >
            {engineEntries.map(({ name, url, iconUrl }) => {
                const key = "vc-search-content-" + name;
                return (
                    <Menu.MenuItem
                        key={key}
                        id={key}
                        label={
                            <Flex gap="0.5em" alignItems="center">
                                {iconUrl && (
                                    <img
                                        style={{
                                            borderRadius: "50%"
                                        }}
                                        aria-hidden="true"
                                        height={16}
                                        width={16}
                                        src={iconUrl}
                                    />
                                )}
                                {name}
                            </Flex>
                        }
                        action={() => search(src, url)}
                    />
                );
            })}
        </Menu.MenuItem>
    );
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, _props) => {
    const selection = document.getSelection()?.toString();
    if (!selection) return;

    const group = findGroupChildrenByChildId("search-google", children);
    if (group) {
        const idx = group.findIndex(c => c?.props?.id === "search-google");
        if (idx !== -1) group[idx] = makeSearchItem(selection);
    }
};

migratePluginSettings("ReplaceGoogleSearch", "Search");
export default definePlugin({
    name: "ReplaceGoogleSearch",
    performance: {
        impact: "low",
        description: "Builds search engine choices when a text context menu opens."
    },
    description: "Replaces the Google search with different Engine(s)",
    tags: ["Utility", "Customisation"],
    authors: [Devs.Moxxie, Devs.Ethan],

    settings,

    contextMenus: {
        "message": messageContextMenuPatch
    }
});
