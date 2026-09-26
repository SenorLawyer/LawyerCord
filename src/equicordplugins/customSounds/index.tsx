/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { AudioProcessor, PreprocessAudioData } from "@api/AudioPlayer";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { React, showToast, TextInput, Toasts } from "@webpack/common";

import { deleteAudio, getAllAudio, getAudioDataURI } from "./audioStore";
import { SoundOverrideComponent } from "./SoundOverrideComponent";
import { makeEmptyOverride, seasonalSounds, SoundOverride, soundTypes } from "./types";

const cl = classNameFactory("vc-custom-sounds-");

const dataUriCache = new Map<string, string>();
const pendingDataUris = new Map<string, Promise<string | null>>();
const logger = new Logger("CustomSounds");
let cacheVersion = 0;

function clearAudioCache() {
    cacheVersion++;
    dataUriCache.clear();
    pendingDataUris.clear();
}

export async function deleteCustomAudio(fileId: string) {
    await deleteAudio(fileId);
    dataUriCache.delete(fileId);
    pendingDataUris.delete(fileId);
}

function getOverride(id: string): SoundOverride {
    const stored = settings.store[id];
    if (!stored) return makeEmptyOverride();

    if (typeof stored === "object") return stored;

    try {
        return JSON.parse(stored);
    } catch {
        return makeEmptyOverride();
    }
}

function setOverride(id: string, override: SoundOverride) {
    settings.store[id] = JSON.stringify(override);
}

function importOverrides(text: string) {
    const imported: unknown = JSON.parse(text);
    if (!isObject(imported) || !("overrides" in imported) || !Array.isArray(imported.overrides)) {
        throw new Error("Invalid sound settings file.");
    }

    const overrides = new Map(soundTypes.map(type => [type.id, makeEmptyOverride()]));
    for (const value of imported.overrides as unknown[]) {
        if (!isObject(value)) throw new Error("Invalid sound override.");
        const { id, enabled = false, selectedSound = "default", selectedFileId, volume = 100 } = value as Record<string, unknown>;
        if (typeof id !== "string" || !overrides.has(id)
            || typeof enabled !== "boolean" || typeof selectedSound !== "string"
            || (!["default", "custom", "halloween", "winter"].includes(selectedSound) && !Object.hasOwn(seasonalSounds, selectedSound))
            || (selectedFileId != null && typeof selectedFileId !== "string")
            || typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 100) {
            throw new Error("Invalid sound override.");
        }
        overrides.set(id, { enabled, selectedSound, selectedFileId: selectedFileId ?? undefined, volume, useFile: false });
    }

    for (const [id, override] of overrides) setOverride(id, override);
    clearAudioCache();
}

export const getCustomSoundURL: AudioProcessor = (data: PreprocessAudioData) => {
    let audioOverride = data.audio;

    if (Object.hasOwn(seasonalSounds, data.audio)) {
        audioOverride = soundTypes.find(sound => sound.seasonal?.includes(data.audio))?.id || data.audio;
    }

    const override = getOverride(audioOverride);

    if (!override?.enabled) {
        return;
    }

    if (override.selectedSound === "custom" && override.selectedFileId) {
        const dataUri = dataUriCache.get(override.selectedFileId);
        if (dataUri) {
            data.audio = dataUri;
            data.volume = override.volume;
            return;
        } else {
            return;
        }
    }

    if (override.selectedSound !== "default" && override.selectedSound !== "custom") {
        if (Object.hasOwn(seasonalSounds, override.selectedSound)) {
            data.audio = seasonalSounds[override.selectedSound];
            data.volume = override.volume;
            return;
        }

        const soundType = soundTypes.find(t => t.id === audioOverride);

        if (soundType?.seasonal) {
            const seasonalId = soundType.seasonal.find(seasonalId =>
                seasonalId.startsWith(`${override.selectedSound}_`)
            );

            if (seasonalId && Object.hasOwn(seasonalSounds, seasonalId)) {
                data.audio = seasonalSounds[seasonalId];
                data.volume = override.volume;
                return;
            }
        }
    }

    data.volume = override.volume;
    return;
};

export function ensureDataURICached(fileId: string): Promise<string | null> {
    const cached = dataUriCache.get(fileId);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = pendingDataUris.get(fileId);
    if (pending) return pending;

    const request = getAudioDataURI(fileId).then(dataUri => {
        if (pendingDataUris.get(fileId) !== request) return null;
        if (dataUri) dataUriCache.set(fileId, dataUri);
        return dataUri ?? null;
    }).catch(error => {
        if (pendingDataUris.get(fileId) === request) logger.error("Could not load a custom sound.", error);
        return null;
    }).finally(() => {
        if (pendingDataUris.get(fileId) === request) pendingDataUris.delete(fileId);
    });
    pendingDataUris.set(fileId, request);
    return request;
}

async function preloadDataURIs() {
    const version = cacheVersion;
    for (const soundType of soundTypes) {
        if (version !== cacheVersion) return;
        const override = getOverride(soundType.id);
        if (override?.enabled && override.selectedSound === "custom" && override.selectedFileId) {
            await ensureDataURICached(override.selectedFileId);
        }
    }
}

const soundSettings = Object.fromEntries(
    soundTypes.map(type => [
        type.id,
        {
            type: OptionType.STRING,
            description: `Override for ${type.name}`,
            default: JSON.stringify(makeEmptyOverride()),
            hidden: true
        }
    ])
);

const settings = definePluginSettings({
    ...soundSettings,
    overrides: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => {
            const [resetTrigger, setResetTrigger] = React.useState(0);
            const [searchQuery, setSearchQuery] = React.useState("");
            const [files, setFiles] = React.useState<Record<string, string>>({});
            const fileInputRef = React.useRef<HTMLInputElement>(null);

            const refreshFiles = async () => {
                const stored = await getAllAudio();
                setFiles(Object.fromEntries(Object.entries(stored)
                    .filter(([id, file]) => !!id && !!file?.name)
                    .map(([id, file]) => [id, file.name])));
            };

            React.useEffect(() => {
                refreshFiles().catch(() => showToast("Could not load custom sound files.", Toasts.Type.FAILURE));
                soundTypes.forEach(type => {
                    if (!settings.store[type.id]) {
                        setOverride(type.id, makeEmptyOverride());
                    }
                });
            }, []);

            const resetOverrides = () => {
                soundTypes.forEach(type => {
                    setOverride(type.id, makeEmptyOverride());
                });
                clearAudioCache();
                setResetTrigger(prev => prev + 1);
                showToast("All overrides reset successfully!");
            };

            const triggerFileUpload = () => {
                fileInputRef.current?.click();
            };

            const handleSettingsUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;

                try {
                    importOverrides(await file.text());
                    await preloadDataURIs();
                    setResetTrigger(prev => prev + 1);
                    showToast("Settings imported successfully!");
                } catch (error) {
                    console.error("Error importing settings:", error);
                    showToast("Error importing settings. Check console for details.");
                }
            };

            const downloadSettings = async () => {
                const overrides = soundTypes.map(type => {
                    const override = getOverride(type.id);
                    return {
                        id: type.id,
                        enabled: override.enabled,
                        selectedSound: override.selectedSound,
                        selectedFileId: override.selectedFileId ?? undefined,
                        volume: override.volume
                    };
                }).filter(o => o.enabled || o.selectedSound !== "default");

                const exportPayload = {
                    overrides,
                    __note: "Audio files are not included in exports and will need to be re-uploaded after import"
                };

                const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "customSounds-settings.json";
                a.click();
                URL.revokeObjectURL(url);

                showToast(`Exported ${overrides.length} settings (audio files not included)`);
            };

            const filteredSoundTypes = soundTypes.filter(type =>
                type.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                type.id.toLowerCase().includes(searchQuery.toLowerCase())
            );

            return (
                <div>
                    <div className="vc-custom-sounds-buttons">
                        <Button variant="primary" onClick={triggerFileUpload}>Import</Button>
                        <Button variant="secondary" onClick={downloadSettings}>Export</Button>
                        <Button variant="dangerPrimary" onClick={resetOverrides}>Reset All</Button>
                        <input
                            className={cl("file-input")}
                            ref={fileInputRef}
                            type="file"
                            accept=".json"
                            onChange={handleSettingsUpload}
                        />
                    </div>

                    <div className={cl("search")}>
                        <Heading>Search Sounds</Heading>
                        <TextInput
                            value={searchQuery}
                            onChange={e => setSearchQuery(e)}
                            placeholder="Search by name or ID"
                        />
                    </div>

                    <div className={cl("sounds-list")}>
                        {filteredSoundTypes.map(type => {
                            const currentOverride = getOverride(type.id);

                            return (
                                <SoundOverrideComponent
                                    key={`${type.id}-${resetTrigger}`}
                                    type={type}
                                    override={currentOverride}
                                    files={files}
                                    refreshFiles={refreshFiles}
                                    onChange={async () => {

                                        setOverride(type.id, currentOverride);

                                        if (currentOverride.enabled && currentOverride.selectedSound === "custom" && currentOverride.selectedFileId) {
                                            try {
                                                await ensureDataURICached(currentOverride.selectedFileId);
                                            } catch (error) {
                                                console.error(`[CustomSounds] Failed to cache data URI for ${type.id}:`, error);
                                                showToast("Error loading custom sound file");
                                            }
                                        }

                                        console.log(`[CustomSounds] Settings saved for ${type.id}:`, currentOverride);
                                    }}
                                />
                            );
                        })}
                    </div>
                </div>
            );
        }
    }
});

export default definePlugin({
    name: "CustomSounds",
    description: "Customize Discord's sounds.",
    dependencies: ["AudioPlayerAPI"],
    tags: ["Customisation", "Notifications", "Voice"],
    authors: [Devs.ScattrdBlade, Devs.TheKodeToad],
    settings,
    startAt: StartAt.Init,
    audioProcessor: getCustomSoundURL,

    async start() {
        try {
            await preloadDataURIs();
        } catch (error) {
            logger.error("Could not preload custom sounds.", error);
        }
    },

    stop() {
        clearAudioCache();
    }
});
