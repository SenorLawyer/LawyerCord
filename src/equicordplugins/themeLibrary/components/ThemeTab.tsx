/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { Settings } from "@api/Settings";
import { ErrorCard } from "@components/ErrorCard";
import { HeadingPrimary, HeadingTertiary } from "@components/Heading";
import { OpenExternalIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings";
import { SearchStatus, Theme, ThemeLikeProps } from "@equicordplugins/themeLibrary/types";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { findCssClassesLazy } from "@webpack";
import { Button, React, SearchableSelect, TextInput, useEffect, useState } from "@webpack/common";

import { ThemeCard } from "./ThemeCard";

const InputStyles = findCssClassesLazy("inputWrapper", "inputError", "error");

export const apiUrl = "https://themes.equicord.org/api";
export const logger = new Logger("ThemeLibrary", "#e5c890");

export async function fetchAllThemes(signal?: AbortSignal): Promise<Theme[]> {
    const response = await themeRequest("/themes", { signal });
    if (!response.ok) throw new Error("Could not fetch the theme list.");
    const data = await response.json();
    const themes: Theme[] = Object.values(data);
    themes.forEach(theme => {
        if (!theme.source) {
            theme.source = `${apiUrl}/${theme.id}`;
        }
    });
    return themes.sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
}

export async function themeRequest(path: string, options: RequestInit = {}) {
    return fetch(apiUrl + path, options);
}

const SearchTags = {
    [SearchStatus.THEME]: "THEME",
    [SearchStatus.SNIPPET]: "SNIPPET",
    [SearchStatus.LIKED]: "LIKED",
    [SearchStatus.DARK]: "DARK",
    [SearchStatus.LIGHT]: "LIGHT",
};

function ThemeTab() {
    const [themes, setThemes] = useState<Theme[]>([]);
    const [themeLinks, setThemeLinks] = useState(Settings.themeLinks);
    const [likedThemes, setLikedThemes] = useState<ThemeLikeProps>();
    const [searchValue, setSearchValue] = useState({ value: "", status: SearchStatus.ALL });
    const [hideWarningCard, setHideWarningCard] = useState(Settings.plugins.ThemeLibrary.hideWarningCard);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    const onSearch = (query: string) => setSearchValue(prev => ({ ...prev, value: query }));
    const onStatusChange = (status: SearchStatus) => setSearchValue(prev => ({ ...prev, status }));

    const themeFilter = (theme: Theme) => {
        const enabled = themeLinks.includes(`${apiUrl}/${theme.id}`);

        const tags = new Set(theme.tags.map(tag => tag?.toLowerCase()));

        const anyTags = SearchTags[searchValue.status];
        if (anyTags && !tags.has(anyTags?.toLowerCase())) return false;

        if ((enabled && searchValue.status === SearchStatus.DISABLED) || (!enabled && searchValue.status === SearchStatus.ENABLED)) return false;

        if (!searchValue.value.length) return true;

        const v = searchValue.value?.toLowerCase();
        return (
            theme.name?.toLowerCase().includes(v) ||
            theme.description?.toLowerCase().includes(v) ||
            (Array.isArray(theme.author) ? theme.author.some(author => author.discord_name?.toLowerCase()?.includes(v)) : theme.author.discord_name?.toLowerCase()?.includes(v)) ||
            tags.has(v)
        );
    };

    const fetchLikes = async (signal: AbortSignal) => {
        try {
            const token = await DataStore.get("ThemeLibrary_uniqueToken");
            if (!token || signal.aborted) return;
            const response = await themeRequest("/likes/get", {
                signal,
                headers: {
                    "Authorization": `Bearer ${token}`,
                },
            });
            if (!response.ok) throw new Error("Could not fetch theme likes.");
            return await response.json();
        } catch (err) {
            if (!signal.aborted) logger.error(err);
        }
    };

    useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        const fetchData = async () => {
            try {
                const [themes, likes] = await Promise.all([fetchAllThemes(signal), fetchLikes(signal)]);
                if (signal.aborted) return;
                setThemes(themes);
                setLikedThemes(likes);
            } catch (err) {
                if (signal.aborted) return;
                logger.error(err);
                setError(true);
            } finally {
                if (!signal.aborted) setLoading(false);
            }
        };
        fetchData();
        return () => controller.abort();
    }, []);

    const sortedThemes = [...themes].sort(searchValue.status === SearchStatus.LIKED
        ? (a, b) => b.likes - a.likes
        : (a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
    // likes only update after 12_000 due to cache
    // replacement of themeFilter which wont work with SearchStatus.LIKED
    const filteredThemes = searchValue.status === SearchStatus.LIKED
        ? sortedThemes.filter(theme => theme.name.includes(searchValue.value))
        : sortedThemes.filter(themeFilter);

    return (
        <div>
            <>
                {loading ? (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "center",
                            alignItems: "center",
                            height: "70vh",
                            fontSize: "1.5em",
                            color: "var(--text-default)"
                        }}>
                        <p> Getting the latest themes... </p>
                        <p style={{
                            fontSize: ".75em",
                            color: "var(--text-muted)"
                        }}> This won't take long! </p>

                    </div>
                ) : error ? (
                    <ErrorCard>
                        <HeadingTertiary>Failed to fetch themes</HeadingTertiary>
                        <Paragraph className={Margins.top8}>Could not fetch the theme list. Try again later.</Paragraph>
                    </ErrorCard>
                ) : (
                    <>
                        {hideWarningCard ? null : (
                            <ErrorCard>
                                <HeadingTertiary>Want your theme removed?</HeadingTertiary>
                                <Paragraph className={Margins.top8}>
                                    If you want your theme(s) permanently removed, please open an issue on <a href="https://github.com/Faf4a/plugins/issues/new?labels=removal&projects=&template=request_removal.yml&title=Theme+Removal">GitHub <OpenExternalIcon height={16} width={16} /></a>
                                </Paragraph>
                                <Button
                                    onClick={() => {
                                        Settings.plugins.ThemeLibrary.hideWarningCard = true;
                                        setHideWarningCard(true);
                                    }}
                                    size={Button.Sizes.SMALL}
                                    color={Button.Colors.RED}
                                    look={Button.Looks.FILLED}
                                    className={classes(Margins.top16, "vce-warning-button")}
                                >Hide</Button>
                            </ErrorCard>
                        )}
                        <div className={classes(Margins.bottom8, Margins.top16)}>
                            <HeadingPrimary
                                style={{
                                    overflowWrap: "break-word",
                                    marginTop: 8,
                                }}>
                                {searchValue.status === SearchStatus.LIKED ? "Most Liked" : "Newest Additions"}
                            </HeadingPrimary>

                            {sortedThemes.slice(0, 2).map((theme: Theme) => (
                                <ThemeCard
                                    key={theme.id}
                                    theme={theme}
                                    themeLinks={themeLinks}
                                    likedThemes={likedThemes}
                                    setThemeLinks={setThemeLinks}
                                    removePreview={true}
                                />
                            ))}
                        </div>
                        <HeadingPrimary style={{
                            overflowWrap: "break-word",
                            marginTop: 20,
                        }}>
                            Themes
                        </HeadingPrimary>
                        <div className={classes(Margins.bottom20, "vce-search-grid")}>
                            <TextInput value={searchValue.value} placeholder="Search for a theme..." onChange={onSearch} />
                            <div className={InputStyles.inputWrapper}>
                                <SearchableSelect
                                    options={[
                                        { label: "Show All", value: SearchStatus.ALL, default: true },
                                        { label: "Show Themes", value: SearchStatus.THEME },
                                        { label: "Show Snippets", value: SearchStatus.SNIPPET },
                                        { label: "Show Most Liked", value: SearchStatus.LIKED },
                                        { label: "Show Dark", value: SearchStatus.DARK },
                                        { label: "Show Light", value: SearchStatus.LIGHT },
                                        { label: "Show Enabled", value: SearchStatus.ENABLED },
                                        { label: "Show Disabled", value: SearchStatus.DISABLED },
                                    ]}
                                    // @ts-ignore
                                    value={searchValue.status}
                                    clearable={false}
                                    onChange={v => onStatusChange(v as SearchStatus)}
                                    closeOnSelect={true}
                                />
                            </div>
                        </div>
                        <div>
                            {filteredThemes.length ? filteredThemes.map((theme: Theme) => (
                                <ThemeCard
                                    key={theme.id}
                                    theme={theme}
                                    themeLinks={themeLinks}
                                    likedThemes={likedThemes}
                                    setThemeLinks={setThemeLinks}
                                />
                            )) : <div
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    justifyContent: "center",
                                    alignItems: "center",
                                }}>
                                <p style={{
                                    fontSize: "1em",
                                    color: "var(--text-default)"
                                }}> No theme found. </p>
                                <p style={{
                                    fontSize: ".75em",
                                    color: "var(--text-muted)"
                                }}> Try narrowing your search down. </p>
                            </div>
                            }
                        </div>
                    </>)}
            </>
        </div>
    );
}

function ThemeLibrary() {
    return (
        <SettingsTab>
            <ThemeTab />
        </SettingsTab>
    );
}

export default wrapTab(ThemeLibrary, "Theme Library");
