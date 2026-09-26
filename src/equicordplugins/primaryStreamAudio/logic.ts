/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface StreamDescriptor {
    channelId?: string | null;
    guildId?: string | null;
    ownerId?: string | null;
    streamType?: string | null;
}

export interface StreamParticipantLike {
    id?: string | null;
    stream?: StreamDescriptor | null;
    streamId?: string | null;
}

export interface SelectedChannelStoreLike {
    getVoiceChannelId?(): string | null | undefined;
}

export interface ChannelRTCStoreLike {
    getSelectedParticipant?(channelId: string): StreamParticipantLike | null | undefined;
    getSelectedParticipantId?(channelId: string): string | null | undefined;
    getStreamParticipants?(channelId: string): StreamParticipantLike[] | null | undefined;
}

export interface PrimaryStreamAudioStores {
    channelRTCStore?: ChannelRTCStoreLike | null;
    selectedChannelStore?: SelectedChannelStoreLike | null;
}

export interface StreamAudioData {
    audioElement?: HTMLAudioElement;
    id?: string | null;
    stream?: MediaStream;
    videoStreamId?: string | null;
    _mute?: boolean;
    _speakingFlags?: number;
    _volume?: number;
    gainNode?: GainNode;
}

export const UPDATE_INTERVAL_MS = 250;
export const MIN_VIDEO_AREA = 24_000;
export const SOUNDSHARE_SPEAKING_FLAG = 2;

export interface DomStreamAudioState {
    primaryAudio?: StreamAudioData | null;
    streamAudio?: ReadonlySet<StreamAudioData> | null;
}

function addIfString(values: Set<string>, value: unknown) {
    if (typeof value === "string" && value) values.add(value);
}

function addSplitKeyParts(values: Set<string>, key: string) {
    addIfString(values, key.split(":").at(-1));
}

export function getStreamKeyCandidates(stream: StreamDescriptor | null | undefined) {
    const values = new Set<string>();
    if (!stream) return values;

    const { channelId, guildId, ownerId, streamType } = stream;

    addIfString(values, ownerId);
    if (channelId && ownerId) {
        addIfString(values, `${channelId}:${ownerId}`);
        addIfString(values, `call:${channelId}:${ownerId}`);
    }
    if (guildId && channelId && ownerId) {
        addIfString(values, `${guildId}:${channelId}:${ownerId}`);
        addIfString(values, `guild:${guildId}:${channelId}:${ownerId}`);
    }
    if (streamType && channelId && ownerId) {
        addIfString(values, `${streamType}:${channelId}:${ownerId}`);
    }
    if (streamType && guildId && channelId && ownerId) {
        addIfString(values, `${streamType}:${guildId}:${channelId}:${ownerId}`);
    }

    return values;
}

export function getParticipantKeyCandidates(participant: StreamParticipantLike | null | undefined) {
    const values = getStreamKeyCandidates(participant?.stream);

    addIfString(values, participant?.id);
    addIfString(values, participant?.streamId);

    for (const value of [...values]) addSplitKeyParts(values, value);

    return values;
}

export function getParticipantIdentityKeys(participant: StreamParticipantLike | null | undefined) {
    const values = new Set<string>();

    addIfString(values, participant?.id);
    addIfString(values, participant?.streamId);

    for (const value of [...values]) addSplitKeyParts(values, value);

    return values;
}

export function getAudioKeyCandidates(data: StreamAudioData) {
    const values = new Set<string>();

    addIfString(values, data.videoStreamId);
    addIfString(values, data.id);
    addIfString(values, data.stream?.id);

    for (const value of [...values]) addSplitKeyParts(values, value);

    return values;
}

function getCurrentStreamParticipants(stores: PrimaryStreamAudioStores) {
    const channelId = stores.selectedChannelStore?.getVoiceChannelId?.();
    if (!channelId) return [];

    return stores.channelRTCStore?.getStreamParticipants?.(channelId) ?? [];
}

export function isLikelyStreamAudio(
    data: StreamAudioData,
    stores: PrimaryStreamAudioStores,
    domStreamAudio?: ReadonlySet<StreamAudioData> | null
) {
    if (typeof data._speakingFlags === "number") {
        return (data._speakingFlags & SOUNDSHARE_SPEAKING_FLAG) !== 0;
    }

    if (domStreamAudio?.has(data)) return true;

    const audioKeys = getAudioKeyCandidates(data);
    if (!audioKeys.size) return false;

    const participants = getCurrentStreamParticipants(stores);
    if (!participants.length) return false;

    if (data.videoStreamId) {
        return participants.some(participant => keySetsMatch(audioKeys, getParticipantKeyCandidates(participant)));
    }

    return participants.some(participant => keySetsMatch(audioKeys, getParticipantIdentityKeys(participant)));
}

function keySetsMatch(a: Set<string>, b: Set<string>) {
    for (const left of a) {
        if (b.has(left)) return true;

        for (const right of b) {
            if (left.endsWith(`:${right}`) || right.endsWith(`:${left}`)) return true;
        }
    }

    return false;
}

function findSelectedStreamParticipant(
    selected: StreamParticipantLike | null | undefined,
    selectedId: string | null | undefined,
    streamParticipants: StreamParticipantLike[]
) {
    if (selected?.stream) return selected;

    const selectedKeys = getParticipantKeyCandidates(selected);
    addIfString(selectedKeys, selectedId);
    if (!selectedKeys.size) return null;

    return streamParticipants.find(participant => {
        const participantKeys = getParticipantKeyCandidates(participant);
        return keySetsMatch(selectedKeys, participantKeys);
    }) ?? null;
}

export function getSelectedStreamKeys(stores: PrimaryStreamAudioStores) {
    const channelId = stores.selectedChannelStore?.getVoiceChannelId?.();
    if (!channelId) return null;

    const { channelRTCStore } = stores;
    const selected = channelRTCStore?.getSelectedParticipant?.(channelId);
    const selectedId = channelRTCStore?.getSelectedParticipantId?.(channelId);
    const streamParticipants = channelRTCStore?.getStreamParticipants?.(channelId) ?? [];
    const selectedStream = findSelectedStreamParticipant(selected, selectedId, streamParticipants);

    const keys = getParticipantKeyCandidates(selectedStream ?? selected);
    addIfString(keys, selectedId);

    return keys.size ? keys : null;
}

export function isSelectedStreamAudio(data: StreamAudioData, stores: PrimaryStreamAudioStores) {
    const selectedKeys = getSelectedStreamKeys(stores);
    if (!selectedKeys) return null;

    const audioKeys = getAudioKeyCandidates(data);
    if (!audioKeys.size) return null;

    return keySetsMatch(selectedKeys, audioKeys);
}

export function shouldMuteStreamAudio(
    data: StreamAudioData,
    trackedAudio: ReadonlySet<StreamAudioData>,
    stores: PrimaryStreamAudioStores,
    domState: DomStreamAudioState = {}
) {
    if (trackedAudio.size <= 1) return false;

    const streamAudio = isLikelyStreamAudio(data, stores, domState.streamAudio);
    const selectedMatch = isSelectedStreamAudio(data, stores);
    if (selectedMatch != null) return streamAudio && !selectedMatch;

    if (domState.primaryAudio && domState.streamAudio?.has(data)) {
        return data !== domState.primaryAudio;
    }

    return false;
}

export function getEffectiveVolume(
    data: StreamAudioData,
    trackedAudio: ReadonlySet<StreamAudioData>,
    stores: PrimaryStreamAudioStores,
    domState: DomStreamAudioState = {}
) {
    const muted = Boolean(data._mute) || shouldMuteStreamAudio(data, trackedAudio, stores, domState);
    if (muted) return 0;

    return Math.max(0, (data._volume ?? 100) / 100);
}
