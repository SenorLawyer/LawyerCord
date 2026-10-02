/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Settings, useSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Link } from "@components/Link";
import { Notice } from "@components/Notice";
import { CatalogPagination, PluginDependencyList } from "@components/settings/tabs/plugins";
import { catalogPage } from "@components/settings/tabs/plugins/catalog";
import { PluginCard } from "@components/settings/tabs/plugins/PluginCard";
import { ChangeList } from "@utils/ChangeList";
import { classNameFactory } from "@utils/css";
import { useForceUpdater } from "@utils/react";
import { RenderModalProps } from "@vencord/discord-types";
import { closeModal, Modal, openModal, showToast, Toasts, Tooltip, useMemo, useState } from "@webpack/common";
import { ReactNode } from "react";

import Plugins from "~plugins";

import { getNewPluginChanges, KnownPluginSettingsMap, writeKnownSettings } from "./knownSettings";

const cl = classNameFactory("vc-new-plugins-");

const MODAL_KEY = "vc-new-plugins";
let hasSeen = false;
let modalOpen = false;

interface ModalComponentProps {
    modalProps: RenderModalProps;
    newPlugins: Set<string>;
    newSettings: KnownPluginSettingsMap;
}

function NewPluginsModal({ modalProps, newPlugins, newSettings }: ModalComponentProps) {
    const enabledPaths = useMemo(() => ["plugins", ...Object.keys(Plugins).flatMap(name => [`plugins.${name}` as const, `plugins.${name}.enabled` as const])] as const, []);
    const settings = useSettings(enabledPaths);
    const [page, setPage] = useState(0);
    const [acknowledging, setAcknowledging] = useState(false);
    const changes = useMemo(() => new ChangeList<string>(), []);
    const forceUpdate = useForceUpdater();

    const depMap = useMemo(() => {
        const o = {} as Record<string, string[]>;
        for (const plugin in Plugins) {
            const deps = Plugins[plugin].dependencies;
            if (deps) {
                for (const dep of deps) {
                    o[dep] ??= [];
                    o[dep].push(plugin);
                }
            }
        }
        return o;
    }, []);

    const sortedPlugins = useMemo(() => {
        const mapPlugins = (array: string[]) => array.map(pn => Plugins[pn]).sort((a, b) => a.name.localeCompare(b.name));
        return [
            ...mapPlugins([...newPlugins]),
            ...mapPlugins([...newSettings.keys()].filter(p => !newPlugins.has(p)))
        ];
    }, []);

    const onRestartNeeded = (name: string) => {
        changes.handleChange(name);
        forceUpdate();
    };

    const visiblePlugins = sortedPlugins.filter(plugin => !plugin.hidden);
    const isRequired = (name: string) => Plugins[name].required || depMap[name]?.some(dependency => settings.plugins[dependency].enabled);
    const orderedPlugins = [...visiblePlugins.filter(plugin => !isRequired(plugin.name)), ...visiblePlugins.filter(plugin => isRequired(plugin.name))];
    const visible = catalogPage(orderedPlugins, page);
    const pluginCards: ReactNode[] = [];
    const requiredPluginCards: ReactNode[] = [];

    for (const p of visible.entries) {
        if (isRequired(p.name)) {
            const tooltipText = p.required
                ? "This plugin is required for LawyerCord to function."
                : <PluginDependencyList deps={depMap[p.name]?.filter(d => settings.plugins[d].enabled)} />;

            requiredPluginCards.push(
                <Tooltip text={tooltipText} key={p.name}>
                    {({ onMouseLeave, onMouseEnter }) => (
                        <PluginCard
                            onMouseLeave={onMouseLeave}
                            onMouseEnter={onMouseEnter}
                            onRestartNeeded={onRestartNeeded}
                            disabled={true}
                            plugin={p}
                            isNew={newPlugins.has(p.name)}
                        />
                    )}
                </Tooltip>
            );
        } else {
            pluginCards.push(
                <PluginCard
                    onRestartNeeded={onRestartNeeded}
                    disabled={false}
                    plugin={p}
                    key={p.name}
                    isNew={newPlugins.has(p.name)}
                />
            );
        }
    }

    const totalCount = orderedPlugins.length;

    const handleContinue = async (disable = false) => {
        if (acknowledging) return;
        setAcknowledging(true);
        try {
            await writeKnownSettings();
            hasSeen = true;
            if (disable) Settings.plugins.NewPluginsManager.enabled = false;
            if (changes.hasChanges) location.reload();
            else modalProps.onClose();
        } catch {
            setAcknowledging(false);
            showToast("Could not save your acknowledgment. Please try again.", Toasts.Type.FAILURE);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={
                <div className={cl("header-content")}>
                    <BaseText size="lg" weight="semibold" className={cl("title")}>
                        New Plugins and Settings ({totalCount})
                    </BaseText>
                </div>
            }
            subtitle={
                <>
                    <BaseText size="sm" className={cl("description")}>
                        New plugins have been added since your last visit. Enable any you'd like or continue to dismiss.
                    </BaseText>
                    <br />
                    <Notice.Info className={cl("notice")}>
                        Equicord is Open Source Software. If you enjoy using it, consider supporting us <Link href="https://github.com/sponsors/thororen1234" target="_blank" rel="noopener noreferrer">here</Link>.
                    </Notice.Info>
                </>
            }
            actions={[
                {
                    text: "Don't show this again",
                    onClick: () => handleContinue(true),
                    disabled: acknowledging,
                    variant: "secondary"
                },
                {
                    text: changes.hasChanges ? "Restart" : "Continue",
                    onClick: () => handleContinue(),
                    disabled: acknowledging,
                    variant: "primary"
                }
            ]}
        >
            <CatalogPagination page={visible.page} pageCount={visible.pageCount} onChange={setPage} label="New plugins and settings" />
            <div className={cl("grid")}>
                {pluginCards}
                {requiredPluginCards}
            </div>
        </Modal >
    );
}

export async function openNewPluginsModal() {
    if (hasSeen || modalOpen) return;
    modalOpen = true;
    try {
        const { newPlugins, newSettings } = await getNewPluginChanges();
        if (!newPlugins.size && !newSettings.size) {
            modalOpen = false;
            return;
        }
        openModal(modalProps => (
            <ErrorBoundary noop onError={() => closeModal(MODAL_KEY)}>
                <NewPluginsModal
                    modalProps={modalProps}
                    newPlugins={newPlugins}
                    newSettings={newSettings}
                />
            </ErrorBoundary>
        ), { modalKey: MODAL_KEY, onCloseCallback: () => { modalOpen = false; } });
    } catch (error) {
        modalOpen = false;
        throw error;
    }
}
