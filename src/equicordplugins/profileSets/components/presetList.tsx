/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { classes } from "@utils/misc";
import { ContextMenuApi, Menu, React, showToast, TextInput, Toasts } from "@webpack/common";

import { cl } from "..";
import { PresetActions } from "../utils/actions";
import { PresetSection, type PresetStorage, type ProfilePresetEx } from "../utils/storage";

const presetKeys = new WeakMap<ProfilePresetEx, number>();
let nextPresetKey = 0;

interface PresetListProps {
    storage: PresetStorage;
    actions: PresetActions;
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
    storage,
    actions,
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
            if (storage.presets !== allPresets) throw new Error("The profile preset list changed.");
            await change();
            onUpdate();
        } catch {
            showToast("Could not save the profile preset change. Reopen this panel before trying again.", Toasts.Type.FAILURE);
        }
    };

    return (
        <div className={cl("list-container")}>
            {presets.map(preset => {
                let key = presetKeys.get(preset);
                if (key === undefined) {
                    key = nextPresetKey++;
                    presetKeys.set(preset, key);
                }
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
                    void runChange(() => actions.renamePreset(actualIndex, nextName, section));
                };

                const showMoveOptions = actualIndex > 0 || actualIndex < allPresets.length - 1 || currentPage > 1;

                const content = (
                    <>
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
                                    }}
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
                    </>
                );

                return (
                    <div
                        key={key}
                        role="group"
                        aria-label={preset.name}
                        className={classes(cl("row"), isSelected ? "selected" : "")}
                    >
                        {isRenaming ? (
                            <div className={cl("avatar-url")}>{content}</div>
                        ) : (
                            <Button variant="none" size="min" className={cl("avatar-url")} aria-label={`Load ${preset.name}`} onClick={() => onLoad(preset)}>
                                {content}
                            </Button>
                        )}
                        <div className={cl("updated")}>
                            <Button
                                variant="none"
                                size="iconOnly"
                                aria-label={`Options for ${preset.name}`}
                                aria-haspopup="menu"
                                onClick={e => {
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
                                                        await actions.refreshPreset(preset, section, guildId);
                                                        onUpdate();
                                                    } catch {
                                                        showToast("Could not update the profile preset. Reopen this panel before trying again.", Toasts.Type.FAILURE);
                                                    }
                                                }}
                                            />
                                            <Menu.MenuSeparator />
                                            {actualIndex > 0 && (
                                                <Menu.MenuItem
                                                    id="move-up"
                                                    label="Move Up"
                                                    action={() => runChange(() => actions.movePreset(actualIndex, actualIndex - 1, section))}
                                                />
                                            )}
                                            {actualIndex < allPresets.length - 1 && (
                                                <Menu.MenuItem
                                                    id="move-down"
                                                    label="Move Down"
                                                    action={() => runChange(() => actions.movePreset(actualIndex, actualIndex + 1, section))}
                                                />
                                            )}
                                            {currentPage > 1 && (
                                                <Menu.MenuItem
                                                    id="move-to-page-1"
                                                    label="Move to Page 1"
                                                    action={() => runChange(async () => {
                                                        await actions.movePreset(actualIndex, 0, section);
                                                        onPageChange(1);
                                                    })}
                                                />
                                            )}
                                            {showMoveOptions && <Menu.MenuSeparator />}
                                            <Menu.MenuItem
                                                id="delete"
                                                label="Delete"
                                                color="danger"
                                                action={() => runChange(() => actions.deletePreset(actualIndex, section))}
                                            />
                                        </Menu.Menu>
                                    ));
                                }}
                            >
                                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                                    <path
                                        fill="currentColor"
                                        d="M10 3a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"
                                    />
                                </svg>
                            </Button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
