/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AudioPlayerInterface, playAudio } from "@api/AudioPlayer";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { useForceUpdater } from "@utils/react";
import { makeRange } from "@utils/types";
import { React, Select, showToast, Slider } from "@webpack/common";

import { saveAudio } from "./audioStore";
import { deleteCustomAudio, ensureDataURICached } from "./index";
import { SoundOverride, SoundType } from "./types";

const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm", "wma", "mp4"];
const cl = classNameFactory("vc-custom-sounds-");

const capitalizeWords = (str: string) =>
    str.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

interface SoundOverrideProps {
    type: SoundType;
    override: SoundOverride;
    onChange: () => Promise<void>;
    files: Record<string, string>;
    refreshFiles: () => Promise<void>;
}

export function SoundOverrideComponent({ type, override, onChange, files, refreshFiles }: SoundOverrideProps) {
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const update = useForceUpdater();
    const sound = React.useRef<AudioPlayerInterface | null>(null);
    const previewVersion = React.useRef(0);

    const stopPreview = () => {
        previewVersion.current++;
        sound.current?.stop();
        sound.current = null;
    };

    React.useEffect(() => stopPreview, [override.enabled, override.selectedSound, override.selectedFileId]);

    const saveAndNotify = () => {
        const saved = onChange();
        update();
        return saved;
    };

    const previewSound = async () => {
        stopPreview();
        const version = previewVersion.current;

        if (!override.enabled) {
            sound.current = playAudio(type.id);
            return;
        }

        const { selectedSound } = override;

        if (selectedSound === "custom" && override.selectedFileId) {
            try {
                const dataUri = await ensureDataURICached(override.selectedFileId);
                if (version !== previewVersion.current) return;

                if (!dataUri || !dataUri.startsWith("data:audio/")) {
                    showToast("No custom sound file available for preview");
                    return;
                }

                sound.current = playAudio(dataUri, {
                    volume: override.volume, onError: e => {
                        if (version !== previewVersion.current) return;
                        console.error("[CustomSounds] Error playing custom audio:", e);
                        showToast("Error playing custom sound. File may be corrupted.");
                    }
                });
            } catch (error) {
                if (version !== previewVersion.current) return;
                console.error("[CustomSounds] Error in previewSound:", error);
                showToast("Error playing sound.");
            }
        } else if (selectedSound === "default") {
            sound.current = playAudio(type.id);
        } else {
            sound.current = playAudio(selectedSound);
        }
    };

    const uploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const fileExtension = file.name.split(".").pop()?.toLowerCase();
        if (!fileExtension || !AUDIO_EXTENSIONS.includes(fileExtension)) {
            showToast("Invalid file type. Please upload an audio file.");
            event.target.value = "";
            return;
        }

        try {
            showToast("Uploading file...");
            const id = await saveAudio(file);

            stopPreview();
            override.selectedFileId = id;
            override.selectedSound = "custom";

            await saveAndNotify();
            await refreshFiles();

            showToast(`File uploaded successfully: ${file.name}`);
        } catch (error) {
            console.error("[CustomSounds] Error uploading file:", error);
            showToast(`Error uploading file: ${error}`);
        }

        event.target.value = "";
    };

    const deleteFile = async (id: string) => {
        try {
            await deleteCustomAudio(id);
            stopPreview();

            if (override.selectedFileId === id) {
                override.selectedFileId = undefined;
                override.selectedSound = "default";
                await saveAndNotify();
            }
            await refreshFiles();
            showToast("File deleted successfully");
        } catch (error) {
            console.error("[CustomSounds] Error deleting file:", error);
            showToast("Error deleting file.");
        }
    };

    const customFileOptions = Object.entries(files).map(([value, label]) => ({ value, label }));

    return (
        <Card className={cl("card")}>
            <FormSwitch
                title={type.name}
                value={override.enabled || false}
                onChange={async val => {
                    stopPreview();
                    console.log(`[CustomSounds] Setting ${type.id} enabled to:`, val);

                    override.enabled = val;

                    await saveAndNotify();
                    console.log("[CustomSounds] After setting enabled, override.enabled =", override.enabled);
                }}
                className={Margins.bottom16}
                hideBorder
            />

            {override.enabled && (
                <>
                    <div className={cl("override-controls")}>
                        <Button
                            variant="positive"
                            onClick={previewSound}
                        >
                            Preview
                        </Button>
                        <Button
                            variant="dangerPrimary"
                            onClick={stopPreview}
                        >
                            Stop
                        </Button>
                    </div>

                    <div className={Margins.bottom16}>
                        <Heading>Volume</Heading>
                        <Slider
                            markers={makeRange(0, 100, 10)}
                            initialValue={override.volume}
                            onValueChange={val => {
                                sound.current && (sound.current.volume = val);
                                override.volume = val;
                                saveAndNotify();
                            }}
                            disabled={!override.enabled}
                        />
                    </div>

                    <div className={Margins.bottom16}>
                        <Heading>Sound Source</Heading>
                        <Select
                            options={[
                                { value: "default", label: "Default" },
                                ...(type.seasonal?.map(id => ({ value: id, label: capitalizeWords(id) })) ?? []),
                                { value: "custom", label: "Custom" }
                            ]}
                            isSelected={v => v === override.selectedSound}
                            select={async v => {
                                stopPreview();
                                override.selectedSound = v;

                                await saveAndNotify();
                            }}
                            serialize={opt => opt.value}
                        />
                    </div>

                    {override.selectedSound === "custom" && (
                        <>
                            <div className={Margins.bottom8}>
                                <Heading>Custom File</Heading>
                                <Select
                                    options={[
                                        { value: "", label: "Select a file..." },
                                        ...customFileOptions
                                    ]}
                                    isSelected={v => v === (override.selectedFileId || "")}
                                    select={async id => {
                                        stopPreview();
                                        if (!id) {
                                            override.selectedFileId = undefined;
                                        } else {
                                            override.selectedFileId = id;
                                        }

                                        await saveAndNotify();
                                    }}
                                    serialize={opt => opt.value}
                                />
                            </div>
                            <input
                                className={cl("file-input")}
                                ref={fileInputRef}
                                type="file"
                                accept=".mp3,.wav,.ogg,.m4a,.flac,.aac,.webm,.wma,.mp4"
                                onChange={uploadFile}
                            />
                            <div className={cl("override-controls")}>
                                <Button
                                    variant="primary"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    Upload New
                                </Button>

                                {override.selectedFileId && files[override.selectedFileId] && (
                                    <Button
                                        variant="dangerPrimary"
                                        onClick={() => deleteFile(override.selectedFileId!)}
                                    >
                                        Delete Selected File
                                    </Button>
                                )}
                            </div>
                        </>
                    )}
                </>
            )}
        </Card>
    );
}
