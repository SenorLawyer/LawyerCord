/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { classes } from "@utils/misc";
import { ProfilePreset } from "@vencord/discord-types";
import { openModal, React, SelectedGuildStore, showToast, TextInput, Toasts, UserStore, useStateFromStores } from "@webpack/common";

import { cl, settings } from "../index";
import { createPresetActions, ImportDecision } from "../utils/actions";
import { loadPresetAsPending } from "../utils/profile";
import { createPresetStorage, PresetSection } from "../utils/storage";
import { ImportProfilesModal } from "./confirmModal";
import { PresetList } from "./presetList";

const PRESETS_PER_PAGE = 5;

type PresetManagerProps = {
    section?: PresetSection;
    guildId?: string;
};

export function PresetManager({ section, guildId }: PresetManagerProps) {
    const [presetName, setPresetName] = React.useState("");
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const [isSaving, setIsSaving] = React.useState(false);
    const [currentPage, setCurrentPage] = React.useState(1);
    const [pageInput, setPageInput] = React.useState("1");
    const [selectedPreset, setSelectedPreset] = React.useState<ProfilePreset | null>(null);
    const [searchMode, setSearchMode] = React.useState(false);
    const lastRandomIndexRef = React.useRef<number>(-1);
    const loadController = React.useRef<AbortController | null>(null);
    const resolvedSection: PresetSection = section ?? "main";
    const isServerSection = resolvedSection === "server";
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const lastSelectedGuildId = useStateFromStores(
        [SelectedGuildStore],
        () => SelectedGuildStore.getLastSelectedGuildId() ?? SelectedGuildStore.getGuildId()
    );
    const resolvedGuildId = isServerSection ? (guildId ?? lastSelectedGuildId ?? undefined) : undefined;
    const storage = React.useMemo(() => createPresetStorage(), [resolvedSection, resolvedGuildId, userId]);
    const activeStorage = React.useRef(storage);
    activeStorage.current = storage;
    const preparationController = React.useMemo(() => new AbortController(), [storage]);
    const actions = React.useMemo(() => createPresetActions(storage, preparationController.signal), [storage, preparationController]);
    const { presets } = storage;
    const canUseGuild = !isServerSection || Boolean(resolvedGuildId);

    React.useEffect(() => {
        let isActive = true;
        setIsSaving(false);
        (async () => {
            try {
                await storage.loadPresets(resolvedSection);
            } catch {
                if (isActive) showToast("Could not load the saved profile presets.", Toasts.Type.FAILURE);
            }
            if (!isActive) return;
            setSelectedPreset(null);
            setCurrentPage(1);
            setPageInput("1");
            forceUpdate();
        })();
        return () => {
            isActive = false;
            loadController.current?.abort();
            preparationController.abort();
            storage.unloadPresets();
        };
    }, [resolvedGuildId, resolvedSection, userId, storage, preparationController]);

    const filteredPresets = !searchMode
        ? presets
        : presets.filter(preset => preset.name.toLowerCase().includes(presetName.toLowerCase()));

    const totalPages = Math.ceil(filteredPresets.length / PRESETS_PER_PAGE);
    React.useEffect(() => {
        const lastPage = Math.max(1, totalPages);
        if (currentPage > lastPage) {
            setCurrentPage(lastPage);
            setPageInput(String(lastPage));
        }
    }, [currentPage, totalPages]);

    const startIndex = (currentPage - 1) * PRESETS_PER_PAGE;
    const currentPresets = filteredPresets.slice(startIndex, startIndex + PRESETS_PER_PAGE);

    const handlePageChange = (newPage: number) => {
        if (newPage >= 1 && newPage <= Math.max(1, totalPages)) {
            setCurrentPage(newPage);
            setPageInput(String(newPage));
        }
    };

    const handleSavePreset = async () => {
        if (!canUseGuild || !storage.isCurrentScope(resolvedSection)) return;
        const trimmedName = presetName.trim();
        if (!trimmedName) return;
        setIsSaving(true);
        try {
            await actions.savePreset(trimmedName, resolvedSection, resolvedGuildId);
            if (activeStorage.current !== storage || !storage.isCurrentScope(resolvedSection)) return;
            setPresetName("");
            const newTotalPages = Math.ceil(storage.presets.length / PRESETS_PER_PAGE);
            setCurrentPage(newTotalPages);
            setPageInput(String(newTotalPages));
            forceUpdate();
        } catch {
            if (activeStorage.current === storage && storage.isCurrentScope(resolvedSection))
                showToast("Could not save the profile preset. Reopen this panel before trying again.", Toasts.Type.FAILURE);
        } finally {
            if (activeStorage.current === storage && storage.isCurrentScope(resolvedSection)) setIsSaving(false);
        }
    };

    const applyPreset = (preset: ProfilePreset) => {
        if (!storage.isCurrentScope(resolvedSection) || !storage.presets.includes(preset)) {
            showToast("The profile preset list changed. Reopen this panel before trying again.", Toasts.Type.FAILURE);
            return;
        }
        loadController.current?.abort();
        const controller = loadController.current = new AbortController();
        const isCurrent = () => !controller.signal.aborted
            && activeStorage.current === storage && storage.isCurrentScope(resolvedSection)
            && storage.presets.includes(preset);
        setSelectedPreset(preset);
        loadPresetAsPending(preset, resolvedGuildId, {
            isGuildProfile: resolvedSection === "server",
            signal: controller.signal,
            isCurrent
        }).catch(() => {
            if (isCurrent()) showToast("Could not load the profile preset.", Toasts.Type.FAILURE);
        });
        forceUpdate();
    };

    const handleLoadPreset = (preset: ProfilePreset) => {
        if (!canUseGuild) return;
        applyPreset(preset);
    };

    const handleRandomPreset = () => {
        if (!canUseGuild || !presets.length) return;
        const previousIndex = lastRandomIndexRef.current;
        const skipPrevious = presets.length > 1 && previousIndex >= 0 && previousIndex < presets.length;
        let nextIndex = Math.floor(Math.random() * (presets.length - Number(skipPrevious)));
        if (skipPrevious && nextIndex >= previousIndex) nextIndex++;
        lastRandomIndexRef.current = nextIndex;
        applyPreset(presets[nextIndex]);
    };

    const showImportPrompt = (existingCount: number, recoverLegacy = false): Promise<ImportDecision> => {
        return new Promise(resolve => {
            openModal(props => (
                <ImportProfilesModal
                    {...props}
                    title={recoverLegacy ? "Recover Old Profiles" : "Import Profiles"}
                    message={`${recoverLegacy ? "These old profiles have no recorded account owner. Import them into the account currently signed in? The original data will be retained. " : ""}You have ${existingCount} existing profiles in this section. Do you want to override them or merge with imported profiles?`}
                    onOverride={() => resolve("override")}
                    onMerge={() => resolve("merge")}
                    onCancel={() => resolve("cancel")}
                />
            ), { onCloseCallback: () => resolve("cancel") });
        });
    };

    const { avatarSize } = settings.store;
    const hasPresets = presets.length > 0;
    const shouldShowPagination = filteredPresets.length > PRESETS_PER_PAGE;

    return (
        <div className={classes(cl("section"), isServerSection ? cl("section-server") : "")} >
            <Heading tag="h3" className={cl("heading")}>
                Saved Profiles
            </Heading>

            <div className={cl("text")}>
                <TextInput
                    placeholder={searchMode ? "Search profiles..." : "Profile Name"}
                    value={presetName}
                    onChange={value => {
                        setPresetName(value);
                        if (searchMode) handlePageChange(1);
                    }}
                    className={cl("text-input")}
                />
            </div>

            <div className={cl("search")}>
                {!searchMode && (
                    <Button
                        size="small"
                        disabled={isSaving || !presetName.trim() || !canUseGuild}
                        onClick={handleSavePreset}
                        className={cl("search-button")}
                    >
                        {isSaving ? "Saving..." : "Save Profile"}
                    </Button>
                )}
                {hasPresets && (
                    <Button
                        size="small"
                        variant={searchMode ? "primary" : "secondary"}
                        onClick={() => {
                            setSearchMode(!searchMode);
                            handlePageChange(1);
                        }}
                    >
                        {searchMode ? "Cancel Search" : "Search"}
                    </Button>
                )}
                <Button
                    size="small"
                    variant="secondary"
                    onClick={handleRandomPreset}
                    disabled={!presets.length || !canUseGuild}
                >
                    Random
                </Button>
            </div>
            <div className={cl("import")}>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => actions.importPresets(forceUpdate, showImportPrompt, resolvedSection)}
                    disabled={!canUseGuild}
                >
                    Import
                </Button>
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => actions.exportPresets(resolvedSection)}
                >
                    Export All
                </Button>
                {resolvedSection === "main" && storage.hasLegacyPresets && (
                    <Button
                        size="small"
                        variant="secondary"
                        onClick={() => actions.importPresets(forceUpdate, showImportPrompt, resolvedSection, true)}
                        disabled={!canUseGuild}
                    >
                        Recover Old Profiles
                    </Button>
                )}
            </div>

            {hasPresets && (
                <>
                    <PresetList
                        storage={storage}
                        actions={actions}
                        presets={currentPresets}
                        allPresets={presets}
                        avatarSize={avatarSize}
                        selectedPreset={selectedPreset}
                        onLoad={handleLoadPreset}
                        onUpdate={forceUpdate}
                        guildId={resolvedGuildId}
                        section={resolvedSection}
                        currentPage={currentPage}
                        onPageChange={handlePageChange}
                    />

                    {shouldShowPagination && (
                        <div className={cl("pagination")}>
                            <Button
                                size="small"
                                variant="secondary"
                                disabled={currentPage === 1}
                                onClick={() => handlePageChange(currentPage - 1)}
                            >
                                ←
                            </Button>
                            <div className={cl("page")}>
                                <TextInput
                                    type="text"
                                    aria-label="Page"
                                    value={pageInput}
                                    onChange={value => {
                                        setPageInput(value);
                                        const num = parseInt(value);
                                        if (!isNaN(num) && num >= 1 && num <= totalPages) {
                                            setCurrentPage(num);
                                        }
                                    }}
                                    className={cl("page-input")}
                                />
                                <span className={cl("page-of")}>
                                    / {totalPages}
                                </span>
                            </div>
                            <Button
                                size="small"
                                variant="secondary"
                                disabled={currentPage === totalPages}
                                onClick={() => handlePageChange(currentPage + 1)}
                            >
                                →
                            </Button>
                        </div>
                    )}

                </>
            )}
            <hr className={cl("block")} />
        </div>
    );
}
