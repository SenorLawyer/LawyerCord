/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { PluginCard } from "@components/settings/tabs/plugins/PluginCard";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { makeLazy } from "@utils/lazy";
import { Margins } from "@utils/margins";
import { useForceUpdater } from "@utils/react";
import type { Plugin } from "@utils/types";
import { React, Tooltip } from "@webpack/common";

import Plugins from "~plugins";

const cl = classNameFactory("vc-changelog-");

const getDependencyMap = makeLazy(() => {
    const dependents = new Map<string, string[]>();
    for (const plugin of Object.values(Plugins)) {
        for (const dependency of plugin.dependencies ?? []) {
            const names = dependents.get(dependency) ?? [];
            names.push(plugin.name);
            dependents.set(dependency, names);
        }
    }
    return dependents;
});

function visiblePlugins(names: string[]) {
    return names.map(name => Plugins[name]).filter(plugin => plugin && !plugin.hidden);
}

function usePluginSettings(plugins: Plugin[]) {
    const paths = React.useMemo(() => [...new Set(plugins.flatMap(plugin =>
        [plugin.name, ...getDependencyMap().get(plugin.name) ?? []]
    ))].map(name => `plugins.${name}.enabled` as const), [plugins]);
    return useSettings(paths);
}

interface NewPluginsSectionProps {
    newPlugins: string[];
}

export function NewPluginsSection({
    newPlugins,
}: NewPluginsSectionProps) {
    const changes = React.useMemo(() => new ChangeList<string>(), []);
    const forceUpdate = useForceUpdater();

    const sortedPlugins = React.useMemo(
        () => visiblePlugins(newPlugins).sort((a, b) => a.name.localeCompare(b.name)),
        [newPlugins],
    );
    const settings = usePluginSettings(sortedPlugins);

    if (sortedPlugins.length === 0) {
        return null;
    }

    const makeDependencyList = (deps: string[]) => {
        if (!deps.length) return null;
        return (
            <React.Fragment>
                <Paragraph>This plugin is required by:</Paragraph>
                {deps.map((dep: string) => (
                    <Paragraph key={dep} className="vc-changelog-dep-text">
                        {dep}
                    </Paragraph>
                ))}
            </React.Fragment>
        );
    };

    return (
        <div className={cl("new-plugins-section")}>
            <Heading className={Margins.bottom8}>
                New Plugins ({sortedPlugins.length})
            </Heading>

            <Paragraph className={Margins.bottom16}>
                The following plugins have been added in recent updates:
            </Paragraph>

            <div className={cl("new-plugins-grid")}>
                {sortedPlugins.map(plugin => {
                    const dependents = getDependencyMap().get(plugin.name)?.filter(name => settings.plugins[name].enabled) ?? [];
                    const isRequired =
                        plugin.required ||
                        dependents.length > 0 ||
                        plugin.name.endsWith("API");
                    const tooltipText = plugin.required
                        ? "This plugin is required for LawyerCord to function."
                        : makeDependencyList(dependents);

                    if (isRequired) {
                        return (
                            <Tooltip text={tooltipText} key={plugin.name}>
                                {({ onMouseLeave, onMouseEnter }) => (
                                    <Card
                                        className={cl(
                                            "new-plugin-card",
                                            "required",
                                        )}
                                    >
                                        <PluginCard
                                            onMouseLeave={onMouseLeave}
                                            onMouseEnter={onMouseEnter}
                                            onRestartNeeded={name => {
                                                changes.handleChange(name);
                                                forceUpdate();
                                            }}
                                            disabled={true}
                                            plugin={plugin}
                                            isNew={true}
                                        />
                                    </Card>
                                )}
                            </Tooltip>
                        );
                    }

                    return (
                        <Card
                            key={plugin.name}
                            className={cl("new-plugin-card")}
                        >
                            <PluginCard
                                onRestartNeeded={name => {
                                    changes.handleChange(name);
                                    forceUpdate();
                                }}
                                disabled={false}
                                plugin={plugin}
                                isNew={true}
                            />
                        </Card>
                    );
                })}
            </div>

            {changes.hasChanges && (
                <div className={cl("restart-notice")}>
                    <Tooltip
                        text={
                            <>
                                The following plugins require a restart:
                                <div className={Margins.bottom8} />
                                <ul>
                                    {changes.map(p => (
                                        <li key={p}>{p}</li>
                                    ))}
                                </ul>
                            </>
                        }
                    >
                        {tooltipProps => (
                            <Button
                                {...tooltipProps}
                                variant="link"
                                size="small"
                                onClick={() => location.reload()}
                                className={Margins.top16}
                            >
                                Restart Required
                            </Button>
                        )}
                    </Tooltip>
                </div>
            )}
        </div>
    );
}

interface NewPluginsCompactProps {
    newPlugins: string[];
    maxDisplay?: number;
}

function CompactPluginCard({
    plugin,
    settings,
}: {
    plugin: Plugin;
    settings: ReturnType<typeof useSettings>;
}) {
    const dependents = getDependencyMap().get(plugin.name)?.filter(name => settings.plugins[name].enabled) ?? [];

    const isRequired =
        plugin.required ||
        dependents.length > 0;

    const tooltipText = plugin.required
        ? "This plugin is required for LawyerCord to function."
        : dependents.length > 0
            ? `This plugin is required by: ${dependents.join(", ")}`
            : null;

    return (
        <div className={`vc-changelog-entry ${isRequired ? "required" : ""}`}>
            <div className="vc-changelog-entry-header">
                <span className="vc-changelog-entry-hash">
                    {plugin.name}
                    {isRequired && " *"}
                </span>
                <span className="vc-changelog-entry-author">
                    {plugin.authors?.[0]?.name || "Unknown"}
                </span>
            </div>
            <div className="vc-changelog-entry-message">
                {plugin.description || "No description available"}
            </div>
            {tooltipText && (
                <div className="vc-changelog-dep-text">{tooltipText}</div>
            )}
        </div>
    );
}

export function NewPluginsCompact({
    newPlugins,
    maxDisplay = 20,
}: NewPluginsCompactProps) {
    const availablePlugins = React.useMemo(() => visiblePlugins(newPlugins), [newPlugins]);
    const displayPlugins = React.useMemo(() => availablePlugins.slice(0, maxDisplay), [availablePlugins, maxDisplay]);
    const settings = usePluginSettings(displayPlugins);

    if (availablePlugins.length === 0) {
        return null;
    }

    const hasMore = availablePlugins.length > maxDisplay;

    return (
        <div className={cl("new-plugins-compact")}>
            <div className="vc-changelog-plugins-list">
                {displayPlugins.map(plugin => (
                    <CompactPluginCard
                        key={plugin.name}
                        plugin={plugin}
                        settings={settings}
                    />
                ))}

                {hasMore && (
                    <div className="vc-changelog-entry">
                        <div className="vc-changelog-entry-message">
                            +{availablePlugins.length - maxDisplay} more plugins
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
