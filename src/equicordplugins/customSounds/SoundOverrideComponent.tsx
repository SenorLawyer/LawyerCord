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
import { chooseFile } from "@utils/web";
import { React, Select, showToast, Slider } from "@webpack/common";

import { saveAudio } from "./audioStore";
import { deleteCustomAudio, ensureDataURICached, logger } from "./index";
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
    const update = useForceUpdater();
    const sound = React.useRef<AudioPlayerInterface | null>(null);
    const previewVersion = React.useRef(0);
    const editVersion = React.useRef(0);
    const current = React.useRef({ override, onChange });
    current.current = { override, onChange };

    const stopPreview = () => {
        previewVersion.current++;
        sound.current?.stop();
        sound.current = null;
    };

    React.useEffect(() => stopPreview, [override.enabled, override.selectedSound, override.selectedFileId]);
    React.useEffect(() => () => { editVersion.current++; }, [override.enabled, override.selectedSound, override.selectedFileId, override.volume]);

    const saveAndNotify = () => {
        editVersion.current++;
        const saved = current.current.onChange();
        update();
        return saved;
    };

    const previewSound = async () => {
        stopPreview();
        const version = previewVersion.current;

        if (override.enabled && override.selectedSound === "custom") {
            try {
                const dataUri = override.selectedFileId ? await ensureDataURICached(override.selectedFileId) : null;
                if (version !== previewVersion.current) return;

                if (!dataUri) {
                    showToast("No custom sound file available for preview");
                    return;
                }

                sound.current = playAudio(dataUri, {
                    volume: override.volume, onError: e => {
                        if (version !== previewVersion.current) return;
                        logger.error("Could not play the custom sound.", e);
                        showToast("Error playing custom sound. File may be corrupted.");
                    }
                });
            } catch (error) {
                if (version !== previewVersion.current) return;
                logger.error("Could not preview the sound.", error);
                showToast("Error playing sound.");
            }
        } else {
            sound.current = playAudio(type.id);
        }
    };

    const uploadFile = async () => {
        const version = ++editVersion.current;
        try {
            const file = await chooseFile(AUDIO_EXTENSIONS.map(extension => `.${extension}`).join(","));
            if (!file || version !== editVersion.current) return;

            const fileExtension = file.name.split(".").pop()?.toLowerCase();
            if (!fileExtension || !AUDIO_EXTENSIONS.includes(fileExtension)) {
                showToast("Invalid file type. Please upload an audio file.");
                return;
            }

            showToast("Uploading file...");
            const id = await saveAudio(file);

            if (version === editVersion.current) {
                stopPreview();
                current.current.override.selectedFileId = id;
                current.current.override.selectedSound = "custom";
                await saveAndNotify();
            }
            await refreshFiles();

            showToast(`File uploaded successfully: ${file.name}`);
        } catch (error) {
            logger.error("Could not upload the sound file.", error);
            showToast(`Error uploading file: ${error}`);
        }
    };

    const deleteFile = async (id: string) => {
        const version = ++editVersion.current;
        try {
            await deleteCustomAudio(id);

            if (version === editVersion.current && current.current.override.selectedFileId === id) {
                stopPreview();
                current.current.override.selectedFileId = undefined;
                current.current.override.selectedSound = "default";
                await saveAndNotify();
            }
            await refreshFiles();
            showToast("File deleted successfully");
        } catch (error) {
            logger.error("Could not delete the sound file.", error);
            showToast("Error deleting file.");
        }
    };

    const customFileOptions = Object.entries(files).map(([value, label]) => ({ value, label }));
    const { selectedFileId } = override;

    return (
        <Card className={cl("card")}>
            <FormSwitch
                title={type.name}
                value={override.enabled}
                onChange={async val => {
                    stopPreview();
                    override.enabled = val;

                    await saveAndNotify();
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
                                override.volume = val;
                                saveAndNotify();
                                if (sound.current) sound.current.volume = val;
                            }}
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
                            <div className={cl("override-controls")}>
                                <Button
                                    variant="primary"
                                    onClick={uploadFile}
                                >
                                    Upload New
                                </Button>

                                {selectedFileId && files[selectedFileId] && (
                                    <Button
                                        variant="dangerPrimary"
                                        onClick={() => deleteFile(selectedFileId)}
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
