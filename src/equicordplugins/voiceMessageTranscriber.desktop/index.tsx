/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button, TextButton } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { getLanguages, translateText, TranslationValue } from "@plugins/translate/utils";
import { DEFAULT_WAVEFORM, VoiceMessage } from "@plugins/voiceMessages";
import { generateWaveform } from "@plugins/voiceMessages/waveform";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { lodash, Modal, openModal, ScrollerAuto, SearchableSelect, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { detectAudioMimeType } from "./audioValidation";
import { buildTargetLanguageOptions, getVoiceMessageMedia, LanguageOption, resolveTargetLanguage } from "./options";
import { formatTimestampedTranscript, normalizeTranscriptionResult, TranscriptionProgress, TranscriptionResult } from "./transcriptionData";
import { cl, decodeAudio, LANGUAGES, TranscriptionWorker } from "./utils";

const Native = VencordNative.pluginHelpers.VoiceMessageTranscriber as PluginNative<typeof import("./native")>;
const MAX_RESULT_CACHE_ENTRIES = 100;
const MAX_PREPARED_AUDIO_CACHE_ENTRIES = 3;

type ProcessingStatus = "idle" | "downloading_audio" | "processing_audio" | "loading" | "transcribing" | "translating" | "complete";
type CopyTarget = "transcript" | "translation" | null;

interface CachedResult {
    targetLanguage?: string;
    targetLanguageLabel?: string;
    transcript: TranscriptionResult;
    translation?: TranslationValue;
}

const resultCache = new Map<string, CachedResult>();
interface PreparedAudio {
    blob: Blob;
    samples: Float32Array;
    waveform: string;
}

const preparedAudioCache = new Map<string, Promise<PreparedAudio>>();

function prepareAudio(src: string): Promise<PreparedAudio> {
    const cached = preparedAudioCache.get(src);
    if (cached) return cached;

    const pending = Native.fetchAudio(src)
        .then(async bytes => {
            const blob = new Blob([bytes as any], { type: detectAudioMimeType(bytes) ?? "application/octet-stream" });
            const samples = await decodeAudio(blob);
            return {
                blob,
                samples,
                waveform: generateWaveform(samples, 16_000)
            };
        })
        .catch(error => {
            preparedAudioCache.delete(src);
            throw error;
        });

    preparedAudioCache.set(src, pending);
    if (preparedAudioCache.size > MAX_PREPARED_AUDIO_CACHE_ENTRIES) {
        const oldest = preparedAudioCache.keys().next().value;
        if (oldest) preparedAudioCache.delete(oldest);
    }

    return pending;
}

function cacheResult(messageId: string, result: CachedResult): void {
    resultCache.delete(messageId);
    resultCache.set(messageId, result);

    if (resultCache.size > MAX_RESULT_CACHE_ENTRIES) {
        const oldest = resultCache.keys().next().value;
        if (oldest) resultCache.delete(oldest);
    }
}

const whisperLanguageOptions = [
    { label: "Auto Detect", value: "auto", default: true },
    ...Object.entries(LANGUAGES).map(([value, name]) => ({
        label: name.charAt(0).toUpperCase() + name.slice(1),
        value
    }))
];

const settings = definePluginSettings({
    autoTranscribe: {
        type: OptionType.BOOLEAN,
        description: "Automatically transcribe voice messages when they appear in chat",
        default: false,
        restartNeeded: false
    },
    audioLanguage: {
        type: OptionType.SELECT,
        description: "Spoken language in received voice messages. Auto Detect is recommended.",
        options: whisperLanguageOptions,
        restartNeeded: false
    },
    selectedModel: {
        type: OptionType.SELECT,
        description: "On-device Whisper model size",
        options: [
            { label: "Tiny (fastest, lowest accuracy)", value: "Xenova/whisper-tiny" },
            { label: "Base (recommended)", value: "Xenova/whisper-base", default: true },
            { label: "Small", value: "Xenova/whisper-small" },
            { label: "Medium (slowest, best accuracy)", value: "Xenova/whisper-medium" }
        ],
        restartNeeded: false
    },
    quantized: {
        type: OptionType.BOOLEAN,
        description: "Use a smaller, faster quantized model with slightly lower accuracy",
        default: true,
        restartNeeded: false
    },
    targetLanguage: {
        type: OptionType.STRING,
        description: "Last language selected for voice-message translation",
        default: "en",
        hidden: true
    },
    delete: {
        type: OptionType.COMPONENT,
        component: () => {
            const [size, setSize] = useState(0);
            const [deleteKeys, setDeleteKeys] = useState<string[]>([]);

            useEffect(() => {
                DataStore.entries().then(entries => {
                    let totalSize = 0;
                    const keys: string[] = [];

                    entries.forEach(([key, value]) => {
                        if (typeof key === "string" && key.startsWith("VoiceMessageTranscriber_") && lodash.isArrayBuffer(value)) {
                            keys.push(key);
                            totalSize += value.byteLength;
                        }
                    });

                    setSize(totalSize);
                    setDeleteKeys(keys);
                });
            }, []);

            return (
                <Button
                    variant="dangerPrimary"
                    onClick={() => {
                        DataStore.delMany(deleteKeys).then(() => {
                            setSize(0);
                            setDeleteKeys([]);
                        });
                    }}
                >
                    Delete downloaded speech models ({(size / 1024 / 1024).toFixed(2)} MB)
                </Button>
            );
        }
    }
});

interface LanguageSelectionModalProps {
    modalProps: RenderModalProps;
    onSelect(language: LanguageOption): void;
}

function LanguageSelectionModal({ modalProps, onSelect }: LanguageSelectionModalProps) {
    const options = buildTargetLanguageOptions(getLanguages());
    const initialValue = resolveTargetLanguage(settings.store.targetLanguage, options);
    const [language, setLanguage] = useState(initialValue);

    const select = () => {
        const selected = options.find(option => option.value === language);
        if (!selected) return;

        settings.store.targetLanguage = selected.value;
        modalProps.onClose();
        onSelect(selected);
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Translate voice message"
            actions={[{
                text: "Transcribe & Translate",
                variant: "primary",
                onClick: select
            }]}
        >
            <Flex flexDirection="column" gap={12} style={{ padding: 16 }}>
                <BaseText size="sm" weight="semibold">Target language</BaseText>
                <SearchableSelect
                    options={options}
                    value={language}
                    onChange={setLanguage}
                />
                <BaseText size="xs" color="text-muted">
                    Speech recognition runs on your device. Translation sends only the resulting transcript text to the provider configured by the Translate plugin.
                </BaseText>
            </Flex>
        </Modal>
    );
}

function chooseTargetLanguage(onSelect: (language: LanguageOption) => void): void {
    openModal(modalProps => <LanguageSelectionModal modalProps={modalProps} onSelect={onSelect} />);
}

function progressPercent(progress: TranscriptionProgress | null): number | null {
    if (!progress) return null;
    if (typeof progress.progress === "number") return Math.round(progress.progress);
    if (typeof progress.loaded === "number" && typeof progress.total === "number" && progress.total > 0)
        return Math.round(progress.loaded / progress.total * 100);
    return null;
}

interface VoiceMessageTranscriptionAccessoryProps {
    duration?: number;
    messageId: string;
    needsPlaybackFallback: boolean;
    src: string;
    waveform?: string;
}

function VoiceMessageTranscriptionAccessory({ duration, messageId, needsPlaybackFallback, src, waveform }: VoiceMessageTranscriptionAccessoryProps) {
    const initial = resultCache.get(messageId);
    const [status, setStatus] = useState<ProcessingStatus>(initial ? "complete" : "idle");
    const [transcript, setTranscript] = useState<TranscriptionResult | null>(initial?.transcript ?? null);
    const [translation, setTranslation] = useState<TranslationValue | null>(initial?.translation ?? null);
    const [targetLanguage, setTargetLanguage] = useState(initial?.targetLanguage);
    const [targetLanguageLabel, setTargetLanguageLabel] = useState(initial?.targetLanguageLabel);
    const [showTimestamps, setShowTimestamps] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<TranscriptionProgress | null>(null);
    const [copied, setCopied] = useState<CopyTarget>(null);
    const [playbackSrc, setPlaybackSrc] = useState(src);
    const [resolvedWaveform, setResolvedWaveform] = useState(waveform || DEFAULT_WAVEFORM);
    const workerRef = useRef<TranscriptionWorker | null>(null);
    const jobIdRef = useRef(0);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoStartedRef = useRef(false);

    const stopWorker = useCallback(() => {
        workerRef.current?.terminate();
        workerRef.current = null;
    }, []);

    const translateTranscript = useCallback(async (value: TranscriptionResult, language: LanguageOption, jobId: number) => {
        setStatus("translating");
        setError(null);
        setTargetLanguage(language.value);
        setTargetLanguageLabel(language.label);

        try {
            const translated = await translateText(value.text, "auto", language.value);
            if (jobIdRef.current !== jobId) return;

            setTranslation(translated);
            setStatus("complete");
            cacheResult(messageId, {
                transcript: value,
                translation: translated,
                targetLanguage: language.value,
                targetLanguageLabel: language.label
            });
        } catch (caught) {
            if (jobIdRef.current !== jobId) return;
            setError(`Translation failed: ${caught instanceof Error ? caught.message : String(caught)}`);
            setStatus("complete");
            cacheResult(messageId, { transcript: value });
        }
    }, [messageId]);

    const startTranscription = useCallback((language?: LanguageOption) => {
        const jobId = ++jobIdRef.current;
        stopWorker();
        setStatus("downloading_audio");
        setError(null);
        setProgress(null);
        setTranslation(null);

        void (async () => {
            try {
                const prepared = await prepareAudio(src);
                if (jobIdRef.current !== jobId) return;
                setStatus("processing_audio");
                const audio = new Float32Array(prepared.samples);

                workerRef.current = new TranscriptionWorker(
                    nextStatus => {
                        if (jobIdRef.current === jobId) setStatus(nextStatus as ProcessingStatus);
                    },
                    output => {
                        if (jobIdRef.current !== jobId) return;
                        const value = normalizeTranscriptionResult(output);
                        stopWorker();

                        if (!value.text) {
                            setError("No speech was detected in this voice message.");
                            setStatus("idle");
                            return;
                        }

                        setTranscript(value);
                        cacheResult(messageId, { transcript: value });

                        if (language) {
                            void translateTranscript(value, language, jobId);
                        } else {
                            setStatus("complete");
                        }
                    },
                    caught => {
                        if (jobIdRef.current !== jobId) return;
                        stopWorker();
                        setError(caught instanceof Error ? caught.message : String(caught));
                        setStatus("idle");
                    },
                    partial => {
                        if (jobIdRef.current !== jobId) return;
                        const value = normalizeTranscriptionResult(partial);
                        if (value.text) setTranscript(value);
                    },
                    nextProgress => {
                        if (jobIdRef.current === jobId) setProgress(nextProgress);
                    }
                );

                const { audioLanguage, quantized, selectedModel } = settings.store;
                workerRef.current.run(
                    audio,
                    selectedModel,
                    quantized,
                    audioLanguage === "auto" ? undefined : audioLanguage
                );
            } catch (caught) {
                if (jobIdRef.current !== jobId) return;
                stopWorker();
                setError(caught instanceof Error ? caught.message : String(caught));
                setStatus("idle");
            }
        })();
    }, [messageId, src, stopWorker, translateTranscript]);

    const startTranslation = useCallback((language: LanguageOption) => {
        if (!transcript) {
            startTranscription(language);
            return;
        }

        const jobId = ++jobIdRef.current;
        void translateTranscript(transcript, language, jobId);
    }, [startTranscription, transcript, translateTranscript]);

    const cancel = useCallback(() => {
        ++jobIdRef.current;
        stopWorker();
        setProgress(null);
        setStatus(transcript ? "complete" : "idle");
    }, [stopWorker, transcript]);

    const copy = useCallback((target: Exclude<CopyTarget, null>, text: string) => {
        copyToClipboard(text);
        setCopied(target);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
            copyTimerRef.current = null;
            setCopied(null);
        }, 2000);
    }, []);

    useEffect(() => () => {
        ++jobIdRef.current;
        stopWorker();
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }, [stopWorker]);

    useEffect(() => {
        if (!needsPlaybackFallback || waveform) return;

        let active = true;
        let objectUrl: string | undefined;
        void prepareAudio(src).then(prepared => {
            if (!active) return;
            objectUrl = URL.createObjectURL(prepared.blob);
            setPlaybackSrc(objectUrl);
            setResolvedWaveform(prepared.waveform);
        }).catch(() => { });

        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [needsPlaybackFallback, src, waveform]);

    useEffect(() => {
        if (!settings.store.autoTranscribe || transcript || autoStartedRef.current) return;
        autoStartedRef.current = true;
        startTranscription();
    }, [startTranscription, transcript]);

    const timestampedTranscript = transcript ? formatTimestampedTranscript(transcript) : "";
    const transcriptText = showTimestamps && timestampedTranscript ? timestampedTranscript : transcript?.text ?? "";
    const busy = status !== "idle" && status !== "complete";
    const percent = progressPercent(progress);

    if (!transcript && !busy) {
        return (
            <div className={cl("accessory")}>
                {needsPlaybackFallback && (
                    <div className={cl("playback-fallback")}>
                        <VoiceMessage key={playbackSrc} duration={duration} src={playbackSrc} waveform={resolvedWaveform} />
                    </div>
                )}
                <Flex gap={8} alignItems="center" flexWrap="wrap">
                    <Button size="xs" onClick={() => startTranscription()}>Transcribe</Button>
                    <Button size="xs" variant="secondary" onClick={() => chooseTargetLanguage(startTranslation)}>Translate…</Button>
                    <Span size="xs" color="text-muted">Voice message · on-device speech recognition</Span>
                </Flex>
                {error && <BaseText className={cl("error")} size="xs">{error}</BaseText>}
            </div>
        );
    }

    return (
        <div className={cl("accessory")}>
            {needsPlaybackFallback && (
                <div className={cl("playback-fallback")}>
                    <VoiceMessage key={playbackSrc} duration={duration} src={playbackSrc} waveform={resolvedWaveform} />
                </div>
            )}
            {busy && (
                <Flex gap={8} alignItems="center" className={cl("status")}>
                    <Span size="sm" color="text-muted">
                        {status === "downloading_audio" && "Downloading voice message…"}
                        {status === "processing_audio" && "Preparing audio…"}
                        {status === "loading" && `Loading speech model${percent == null ? "…" : `… ${percent}%`}`}
                        {status === "transcribing" && "Transcribing on device…"}
                        {status === "translating" && `Translating to ${targetLanguageLabel ?? targetLanguage ?? "selected language"}…`}
                    </Span>
                    <TextButton variant="secondary" onClick={cancel}>Cancel</TextButton>
                </Flex>
            )}

            {transcript && (
                <Flex flexDirection="column" gap={10}>
                    <section>
                        <Flex alignItems="center" justifyContent="space-between" gap={8}>
                            <Heading tag="h5">Transcript</Heading>
                            <TextButton variant="secondary" onClick={() => copy("transcript", transcriptText)}>
                                {copied === "transcript" ? "Copied" : "Copy"}
                            </TextButton>
                        </Flex>
                        <ScrollerAuto className={cl("result")}>
                            <BaseText>{transcriptText}</BaseText>
                        </ScrollerAuto>
                        {timestampedTranscript && (
                            <TextButton variant="secondary" onClick={() => setShowTimestamps(value => !value)}>
                                {showTimestamps ? "Hide timestamps" : "Show timestamps"}
                            </TextButton>
                        )}
                    </section>

                    {translation && (
                        <section className={cl("translation")}>
                            <Flex alignItems="center" justifyContent="space-between" gap={8}>
                                <Heading tag="h5">{targetLanguageLabel ?? targetLanguage ?? "Translation"}</Heading>
                                <TextButton variant="secondary" onClick={() => copy("translation", translation.text)}>
                                    {copied === "translation" ? "Copied" : "Copy"}
                                </TextButton>
                            </Flex>
                            <ScrollerAuto className={cl("result")}>
                                <BaseText>{translation.text}</BaseText>
                            </ScrollerAuto>
                            <Span size="xs" color="text-muted">Detected source: {translation.sourceLanguage}</Span>
                        </section>
                    )}

                    {error && <BaseText className={cl("error")} size="xs">{error}</BaseText>}

                    {!busy && (
                        <Flex gap={10} alignItems="center" flexWrap="wrap">
                            <Button size="xs" variant="secondary" onClick={() => chooseTargetLanguage(startTranslation)}>
                                {translation ? "Change translation…" : "Translate…"}
                            </Button>
                            <TextButton
                                variant="secondary"
                                onClick={() => {
                                    resultCache.delete(messageId);
                                    setTranscript(null);
                                    setTranslation(null);
                                    setError(null);
                                    setStatus("idle");
                                }}
                            >
                                Hide
                            </TextButton>
                        </Flex>
                    )}
                </Flex>
            )}
        </div>
    );
}

function VoiceMessageAccessory({ message }: { message: Message; }) {
    const media = getVoiceMessageMedia(message);
    if (!media) return null;

    return (
        <VoiceMessageTranscriptionAccessory
            messageId={message.id}
            duration={media.duration}
            needsPlaybackFallback={media.needsPlaybackFallback}
            src={media.url}
            waveform={media.waveform}
        />
    );
}

export default definePlugin({
    name: "VoiceMessageTranscriber",
    authors: [Devs.TheSun],
    description: "Transcribes voice messages on-device after downloading a pinned runtime from jsDelivr and speech models from Hugging Face.",
    tags: ["Chat", "Media", "Utility", "Voice"],
    dependencies: ["MessageAccessoriesAPI", "VoiceMessages"],
    settings,
    renderMessageAccessory: props => <VoiceMessageAccessory message={props.message} />,
    stop() {
        preparedAudioCache.clear();
        resultCache.clear();
    }
});
