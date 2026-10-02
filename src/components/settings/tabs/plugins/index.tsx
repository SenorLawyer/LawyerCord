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

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { hasAnyVisibleSettings, isPluginEnabled, stopPlugin } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab } from "@components/settings";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { makeLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { useAwaiter, useCleanupEffect } from "@utils/react";
import { PluginTags } from "@utils/types";
import { Alerts, ConfirmModal, lodash, openModal, Parser, React, SearchableSelect, Select, TextInput, Toasts, Tooltip, useCallback, useRef, useState } from "@webpack/common";

import Plugins, { ExcludedPlugins, PluginMeta } from "~plugins";

import { CatalogFilters, catalogPage, createCatalog, DEFAULT_FILTERS, filterCatalog, IMPACT_LABELS } from "./catalog";
import { PluginCard } from "./PluginCard";
import { openWarningModal } from "./PluginModal";
import { StockPluginsCard, UserPluginsCard } from "./PluginStatCards";
import { UIElementsButton } from "./UIElements";

export const cl = classNameFactory("vc-plugins-");
export const logger = new Logger("PluginSettings", "#a6d189");

function showErrorToast(message: string) {
    Toasts.show({
        message,
        type: Toasts.Type.FAILURE,
        id: Toasts.genId(),
        options: {
            position: Toasts.Position.BOTTOM
        }
    });
}

function ReloadRequiredCard({ required, enabledPlugins, openWarningModal, resetCheckAndDo }) {
    return (
        <Card className={classes(cl("info-card"), required && "vc-warning-card")}>
            {required ? (
                <>
                    <HeadingTertiary>Restart required!</HeadingTertiary>
                    <Paragraph className={cl("dep-text")}>
                        Restart now to apply new plugins and their settings
                    </Paragraph>
                    <Button variant="primary" className={cl("restart-button")} onClick={() => location.reload()}>
                        Restart
                    </Button>
                </>
            ) : (
                <>
                    <HeadingTertiary>Plugin Management</HeadingTertiary>
                    <Paragraph>Press the cog wheel or info icon to get more info on a plugin</Paragraph>
                    <Paragraph>Plugins with a cog wheel have settings you can modify!</Paragraph>
                </>
            )}
            {enabledPlugins.length > 0 && !required && (
                <Button
                    variant="secondary"
                    size="small"
                    className={"vc-plugins-disable-warning vc-modal-align-reset"}
                    onClick={() => {
                        return openWarningModal(null, undefined, false, enabledPlugins.length, resetCheckAndDo);
                    }}
                >
                    Disable All Plugins
                </Button>
            )}
        </Card>
    );
}

const getCatalog = makeLazy(() => createCatalog(Plugins, PluginMeta));
const getEnabledPaths = makeLazy(() => ["plugins" as const, ...getCatalog().flatMap(({ plugin }) => [`plugins.${plugin.name}` as const, `plugins.${plugin.name}.enabled` as const])]);
const getDependencyMap = makeLazy(() => {
    const dependencies: Record<string, string[]> = {};
    for (const { plugin } of getCatalog()) for (const dependency of plugin.dependencies ?? []) {
        (dependencies[dependency] ??= []).push(plugin.name);
    }
    return dependencies;
});

export const ExcludedReasons: Record<"web" | "discordDesktop" | "vesktop" | "equibop" | "desktop" | "dev", string> = {
    desktop: "Discord Desktop app or Vesktop/Equibop",
    discordDesktop: "Discord Desktop app",
    vesktop: "Vesktop/Equibop apps",
    equibop: "Vesktop/Equibop apps",
    web: "Vesktop/Equibop apps & Discord web",
    dev: "Developer version of LawyerCord"
};

function ExcludedPluginsList({ search }: { search: string; }) {
    const matchingExcludedPlugins = search
        ? Object.entries(ExcludedPlugins)
            .filter(([name]) => name.toLowerCase().includes(search))
        : [];

    return (
        <Paragraph className={Margins.top16}>
            {matchingExcludedPlugins.length
                ? <>
                    <Paragraph>Are you looking for:</Paragraph>
                    <ul>
                        {matchingExcludedPlugins.map(([name, reason]) => (
                            <li key={name}>
                                <b>{name}</b>: Only available on the {ExcludedReasons[reason]}
                            </li>
                        ))}
                    </ul>
                </>
                : "No plugins meet the search criteria."
            }
        </Paragraph>
    );
}

export default function PluginSettings() {
    const settings = useSettings(getEnabledPaths());
    const catalog = getCatalog();
    const depMap = getDependencyMap();
    const hasUserPlugins = !IS_STANDALONE && Object.values(PluginMeta).some(meta => meta.userPlugin);
    const changeRef = useRef<ChangeList<string>>(null);
    const changes = changeRef.current ??= new ChangeList<string>();

    useCleanupEffect(() => {
        return () => {
            if (!changes.hasChanges) return;

            const allChanges = [...changes.getChanges()];
            const pluginNames = [...new Set(allChanges.map(s => s.split(":")[0]))];
            const maxDisplay = 15;
            const displayed = pluginNames.slice(0, maxDisplay);
            const remainingCount = pluginNames.length - displayed.length;

            openModal(props => (
                <ConfirmModal
                    {...props}
                    title="Restart required"
                    confirmText="Restart now"
                    cancelText="Later!"
                    variant="primary"
                    onConfirm={() => location.reload()}
                >
                    <>
                        <p>The following plugins require a restart:</p>
                        <div>
                            {displayed.map((s, i) => (
                                <span key={i}>
                                    {i > 0 && ", "}
                                    {Parser.parse("`" + s + "`")}
                                </span>
                            ))}
                            {remainingCount > 0 && <span> and {remainingCount} more</span>}
                        </div>
                    </>
                </ConfirmModal>
            ));
        };
    }, []);

    const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_FILTERS);
    const [page, setPage] = useState(0);
    const [requiredPage, setRequiredPage] = useState(0);
    const search = filters.query.trim().toLowerCase();
    function updateFilters(update: Partial<CatalogFilters>) {
        setFilters(previous => ({ ...previous, ...update }));
        setPage(0);
        setRequiredPage(0);
    }
    const sortedPlugins = catalog.map(entry => entry.plugin);

    const [newPluginsSet] = useAwaiter(() => DataStore.get("Vencord_existingPlugins").then((cachedPlugins: Record<string, number> | undefined) => {
        const now = Date.now() / 1000;
        const existingTimestamps: Record<string, number> = {};
        const sortedPluginNames = Object.values(sortedPlugins).map(plugin => plugin.name);

        const newPlugins: string[] = [];
        for (const { name: p } of sortedPlugins) {
            const time = existingTimestamps[p] = cachedPlugins?.[p] ?? now;
            if ((time + 60 * 60 * 24 * 2) > now) {
                newPlugins.push(p);
            }
        }
        if (!lodash.isEqual(cachedPlugins, existingTimestamps)) void DataStore.set("Vencord_existingPlugins", existingTimestamps).catch(error => logger.error("Could not save new plugin history", error));

        return lodash.isEqual(newPlugins, sortedPluginNames) ? null : new Set(newPlugins);
    }));

    const handleRestartNeeded = useCallback((name: string, key: string) => changes.handleChange(`${name}:${key}`), [changes]);

    const enabled = new Set(catalog.filter(({ plugin }) => isPluginEnabled(plugin.name)).map(({ plugin }) => plugin.name));
    const plugins = [] as typeof sortedPlugins;
    const requiredPlugins = [] as typeof sortedPlugins;
    for (const plugin of filterCatalog(catalog, filters, enabled, newPluginsSet, plugin => hasAnyVisibleSettings(plugin) || Boolean(plugin.settingsAboutComponent))) {
        const required = plugin.required || plugin.isDependency || depMap[plugin.name]?.some(name => enabled.has(name));
        (required ? requiredPlugins : plugins).push(plugin);
    }
    const visible = catalogPage(plugins, page);
    const requiredVisible = catalogPage(requiredPlugins, requiredPage);

    function resetCheckAndDo() {
        let restartNeeded = false;

        for (const plugin of enabledPlugins) {
            const pluginSettings = settings.plugins[plugin];

            if (Plugins[plugin].patches?.length) {
                pluginSettings.enabled = false;
                changes.handleChange(plugin);
                restartNeeded = true;
                continue;
            }

            const result = stopPlugin(Plugins[plugin]);

            if (!result) {
                logger.error(`Error while stopping plugin ${plugin}`);
                showErrorToast(`Error while stopping plugin ${plugin}`);
                continue;
            }

            pluginSettings.enabled = false;
        }

        if (restartNeeded) {
            Alerts.show({
                title: "Restart Required",
                body: (
                    <>
                        <p style={{ textAlign: "center" }}>Some plugins require a restart to fully disable.</p>
                        <p style={{ textAlign: "center" }}>Would you like to restart now?</p>
                    </>
                ),
                confirmText: "Restart Now",
                cancelText: "Later",
                onConfirm: () => location.reload()
            });
        }
    }

    const totalPlugins = sortedPlugins.filter(plugin => !plugin.name.endsWith("API") && !plugin.required && !plugin.hidden);
    const enabledPlugins = totalPlugins.filter(plugin => enabled.has(plugin.name)).map(plugin => plugin.name);
    const totalStockPlugins = totalPlugins.filter(plugin => !PluginMeta[plugin.name].userPlugin).length;
    const totalUserPlugins = totalPlugins.length - totalStockPlugins;
    const enabledStockPlugins = enabledPlugins.filter(name => !PluginMeta[name].userPlugin).length;
    const enabledUserPlugins = enabledPlugins.length - enabledStockPlugins;

    return (
        <SettingsTab>
            <ReloadRequiredCard required={changes.hasChanges} enabledPlugins={enabledPlugins} openWarningModal={openWarningModal} resetCheckAndDo={resetCheckAndDo} />

            <div className={cl("stats-container")}>
                <StockPluginsCard
                    totalStockPlugins={totalStockPlugins}
                    enabledStockPlugins={enabledStockPlugins}
                />
                <UserPluginsCard
                    totalUserPlugins={totalUserPlugins}
                    enabledUserPlugins={enabledUserPlugins}
                />
            </div>

            <div className={cl("ui-elements")}>
                <UIElementsButton />
            </div>

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Filters
            </HeadingTertiary>

            <ErrorBoundary noop>
                <TextInput
                    inputClassName={cl("filter-control")}
                    placeholder="Search for a plugin..."
                    value={filters.query}
                    onChange={query => updateFilters({ query })}
                    autoFocus
                />
            </ErrorBoundary>

            <ErrorBoundary noop>
                <div className={classes(Margins.bottom20, Margins.top8, cl("filter-controls"))}>
                    <Select
                        options={[{ label: "All statuses", value: "all" }, { label: "Enabled", value: "enabled" }, { label: "Disabled", value: "disabled" }]}
                        serialize={String}
                        select={status => updateFilters({ status })}
                        isSelected={value => value === filters.status}
                        closeOnSelect
                        placeholder="Status"
                    />
                    <Select
                        options={[{ label: "All sources", value: "all" }, { label: "LawyerCord", value: "lawyercord" }, { label: "Vencord", value: "vencord" }, ...hasUserPlugins ? [{ label: "User plugins", value: "user" }] : []]}
                        serialize={String}
                        select={source => updateFilters({ source })}
                        isSelected={value => value === filters.source}
                        closeOnSelect
                        placeholder="Source"
                    />
                    <Select
                        options={[{ label: "All plugins", value: "all" }, { label: "New plugins", value: "new" }, { label: "With settings", value: "settings" }, { label: "API plugins", value: "api" }]}
                        serialize={String}
                        select={feature => updateFilters({ feature })}
                        isSelected={value => value === filters.feature}
                        closeOnSelect
                        placeholder="Features"
                    />
                    <Select
                        options={[{ label: "All performance impacts", value: "all" }, ...Object.entries(IMPACT_LABELS).map(([value, label]) => ({ label, value }))]}
                        serialize={String}
                        select={impact => updateFilters({ impact })}
                        isSelected={value => value === filters.impact}
                        closeOnSelect
                        placeholder="Expected impact"
                    />
                    <Select
                        options={[{ label: "Name", value: "name" }, { label: "Lowest expected impact", value: "impact" }, { label: "New plugins first", value: "new" }]}
                        serialize={String}
                        select={sort => updateFilters({ sort })}
                        isSelected={value => value === filters.sort}
                        closeOnSelect
                        placeholder="Sort"
                    />
                    <SearchableSelect
                        options={PluginTags.map(tag => ({ label: tag, value: tag }))}
                        value={filters.tags}
                        onChange={tags => updateFilters({ tags })}
                        closeOnSelect={false}
                        placeholder="Filter by Tags"
                        multi
                    />
                </div>
            </ErrorBoundary>

            <HeadingTertiary className={Margins.top20}>Plugins ({plugins.length})</HeadingTertiary>
            <Paragraph className={cl("impact-help")}>Expected impact is a source review of background work, not an FPS measurement. Plugins without a review are marked Not reviewed.</Paragraph>

            {plugins.length || requiredPlugins.length
                ? (
                    <>
                        <div className={cl("grid")}>
                            {visible.entries.length
                                ? visible.entries.map(plugin => <PluginCard key={plugin.name} plugin={plugin} disabled={false} onRestartNeeded={handleRestartNeeded} isNew={newPluginsSet?.has(plugin.name)} />)
                                : <Paragraph>No plugins meet the search criteria.</Paragraph>
                            }
                        </div>
                        <CatalogPagination page={visible.page} pageCount={visible.pageCount} onChange={setPage} label="Plugins" />
                    </>
                )
                : <ExcludedPluginsList search={search} />
            }

            <Divider className={Margins.top20} />

            <HeadingTertiary className={classes(Margins.top20, Margins.bottom8)}>
                Required Plugins ({requiredPlugins.length})
            </HeadingTertiary>

            <div className={cl("grid")}>
                {requiredVisible.entries.length
                    ? requiredVisible.entries.map(plugin => (
                        <Tooltip key={plugin.name} text={plugin.required || !depMap[plugin.name]
                            ? "This plugin is required for LawyerCord to function."
                            : <PluginDependencyList deps={depMap[plugin.name].filter(name => enabled.has(name))} />}>
                            {({ onMouseLeave, onMouseEnter }) => <PluginCard plugin={plugin} disabled onMouseLeave={onMouseLeave} onMouseEnter={onMouseEnter} onRestartNeeded={handleRestartNeeded} />}
                        </Tooltip>
                    ))
                    : <Paragraph>No plugins meet the search criteria.</Paragraph>
                }
            </div>
            <CatalogPagination page={requiredVisible.page} pageCount={requiredVisible.pageCount} onChange={setRequiredPage} label="Required plugins" />
        </SettingsTab >
    );
}

interface CatalogPaginationProps { page: number; pageCount: number; label: string; onChange(page: number): void; }

export function CatalogPagination({ page, pageCount, label, onChange }: CatalogPaginationProps) {
    if (pageCount <= 1) return null;
    return (
        <div className={cl("pagination")} aria-label={`${label} pages`}>
            <Button variant="secondary" size="small" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label={`Previous ${label.toLowerCase()} page`}>Previous</Button>
            <Paragraph>{page + 1} of {pageCount}</Paragraph>
            <Button variant="secondary" size="small" disabled={page === pageCount - 1} onClick={() => onChange(page + 1)} aria-label={`Next ${label.toLowerCase()} page`}>Next</Button>
        </div>
    );
}

export function PluginDependencyList({ deps }: { deps: string[]; }) {
    return (
        <>
            <Paragraph>This plugin is required by:</Paragraph>
            {deps.map((dep: string) => <Paragraph key={dep} className={cl("dep-text")}>{dep}</Paragraph>)}
        </>
    );
}
