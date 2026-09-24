/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { ContextMenuApi, Menu, React, showToast, TextInput, Toasts } from "@webpack/common";

import { cl } from "..";
import { deletePreset, movePreset, refreshPreset, renamePreset } from "../utils/actions";
import { presets as currentPresets, PresetSection, type ProfilePresetEx } from "../utils/storage";

interface PresetListProps {
    presets: ProfilePresetEx[];
    allPresets: ProfilePresetEx[];
    avatarSize: number;
    selectedPreset: ProfilePresetEx | null;
    onLoad: (preset: ProfilePresetEx) => void;
    onUpdate: () => void;
    guildId?: string;
    section: PresetSection;
    currentPage: number;
    onPageChange: (page: number) => void;
}

export function PresetList({
    presets,
    allPresets,
    avatarSize,
    selectedPreset,
    onLoad,
    onUpdate,
    guildId,
    section,
    currentPage,
    onPageChange
}: PresetListProps) {
    const [renaming, setRenaming] = React.useState<ProfilePresetEx | null>(null);
    const [renameText, setRenameText] = React.useState("");

    const runChange = async (change: () => Promise<void>) => {
        try {
            if (currentPresets !== allPresets) throw new Error("The profile preset list changed.");
            await change();
            onUpdate();
        } catch {
            showToast("Could not save the profile preset change.", Toasts.Type.FAILURE);
        }
    };

    return (
        <div className={cl("list-container")}>
            {presets.map(preset => {
                const actualIndex = allPresets.indexOf(preset);
                const isRenaming = renaming === preset;
                const isSelected = !isRenaming && selectedPreset === preset;
                const date = new Date(preset.timestamp);
                const formattedDate = date.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric"
                });
                const formattedTime = date.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit"
                });

                const commitRename = () => {
                    const nextName = renameText.trim();
                    if (!nextName) return;
                    void runChange(() => renamePreset(actualIndex, nextName, section));
                };

                const showMoveOptions = actualIndex > 0 || actualIndex < allPresets.length - 1 || currentPage > 1;

                return (
                    <div
                        key={actualIndex}
                        tabIndex={isRenaming ? -1 : 0}
                        role="button"
                        onClick={() => {
                            if (!isRenaming) {
                                onLoad(preset);
                            }
                        }}
                        onKeyDown={e => {
                            if (!isRenaming && (e.key === "Enter" || e.key === " ")) {
                                e.preventDefault();
                                onLoad(preset);
                            }
                        }}
                        className={classes(cl("row"), isSelected ? "selected" : "")}
                    >
                        <div className={cl("avatar-url")}>
                            {preset.avatarDataUrl && (
                                <img
                                    src={preset.avatarDataUrl}
                                    alt=""
                                    className={cl("avatar")}
                                    style={{ width: `${avatarSize}px`, height: `${avatarSize}px` }}
                                />
                            )}
                            <div className={cl("rename")}>
                                {isRenaming ? (
                                    <TextInput
                                        value={renameText}
                                        onChange={setRenameText}
                                        onBlur={() => {
                                            commitRename();
                                            setRenaming(null);
                                        }}
                                        onKeyDown={e => {
                                            if (e.key === "Enter") {
                                                commitRename();
                                                setRenaming(null);
                                            } else if (e.key === "Escape") {
                                                setRenaming(null);
                                            }
                                            e.stopPropagation();
                                        }}
                                        onClick={e => e.stopPropagation()}
                                        autoFocus
                                    />
                                ) : (
                                    <>
                                        <div className={cl("name")}>
                                            {preset.name}
                                        </div>
                                        <div className={cl("timestamp")}>
                                            {formattedDate} at {formattedTime}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className={cl("updated")}>
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 20 20"
                                className={cl("menu-icon")}
                                onClick={e => {
                                    e.stopPropagation();
                                    ContextMenuApi.openContextMenu(e, () => (
                                        <Menu.Menu navId="preset-options" onClose={ContextMenuApi.closeContextMenu}>
                                            <Menu.MenuItem
                                                id="rename"
                                                label="Rename"
                                                action={() => {
                                                    setRenaming(preset);
                                                    setRenameText(preset.name);
                                                }}
                                            />
                                            <Menu.MenuItem
                                                id="update"
                                                label="Update"
                                                action={async () => {
                                                    try {
                                                        await refreshPreset(preset, section, guildId);
                                                        onUpdate();
                                                    } catch {
                                                        showToast("Could not update the profile preset.", Toasts.Type.FAILURE);
                                                    }
                                                }}
                                            />
                                            <Menu.MenuSeparator />
                                            {actualIndex > 0 && (
                                                <Menu.MenuItem
                                                    id="move-up"
                                                    label="Move Up"
                                                    action={() => runChange(() => movePreset(actualIndex, actualIndex - 1, section))}
                                                />
                                            )}
                                            {actualIndex < allPresets.length - 1 && (
                                                <Menu.MenuItem
                                                    id="move-down"
                                                    label="Move Down"
                                                    action={() => runChange(() => movePreset(actualIndex, actualIndex + 1, section))}
                                                />
                                            )}
                                            {currentPage > 1 && (
                                                <Menu.MenuItem
                                                    id="move-to-page-1"
                                                    label="Move to Page 1"
                                                    action={() => runChange(async () => {
                                                        await movePreset(actualIndex, 0, section);
                                                        onPageChange(1);
                                                    })}
                                                />
                                            )}
                                            {showMoveOptions && <Menu.MenuSeparator />}
                                            <Menu.MenuItem
                                                id="delete"
                                                label="Delete"
                                                color="danger"
                                                action={() => runChange(() => deletePreset(actualIndex, section))}
                                            />
                                        </Menu.Menu>
                                    ));
                                }}
                            >
                                <path
                                    fill="currentColor"
                                    d="M10 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"
                                />
                            </svg>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
