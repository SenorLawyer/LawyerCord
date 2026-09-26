import assert from "node:assert/strict";

import {
    getEffectiveVolume,
    isLikelyStreamAudio,
    shouldMuteStreamAudio,
    type PrimaryStreamAudioStores,
    type StreamAudioData,
    type StreamParticipantLike,
} from "../src/equicordplugins/primaryStreamAudio/logic";

const channelId = "voice-channel";

function streamParticipant(ownerId: string, streamId: string): StreamParticipantLike {
    return {
        id: streamId,
        streamId,
        stream: {
            channelId,
            guildId: "guild",
            ownerId,
            streamType: "guild",
        },
    };
}

function storesFor(selected: StreamParticipantLike | null, participants: StreamParticipantLike[]): PrimaryStreamAudioStores {
    return {
        selectedChannelStore: {
            getVoiceChannelId: () => channelId,
        },
        channelRTCStore: {
            getSelectedParticipant: () => selected,
            getSelectedParticipantId: () => selected?.id ?? null,
            getStreamParticipants: () => participants,
        },
    };
}

function audio(data: StreamAudioData): StreamAudioData {
    return {
        _volume: 100,
        ...data,
    };
}

const streamA = streamParticipant("user-a", "stream-a");
const streamB = streamParticipant("user-b", "stream-b");
const participants = [streamA, streamB];

{
    const stores = storesFor(streamA, participants);
    const selectedAudio = audio({ id: "user-a", videoStreamId: "opaque-video-a", _speakingFlags: 2 });
    const otherAudio = audio({ id: "user-b", videoStreamId: "opaque-video-b", _speakingFlags: 2 });
    const tracked = new Set([selectedAudio, otherAudio]);

    assert.equal(getEffectiveVolume(selectedAudio, tracked, stores), 1, "selected stream audio remains audible");
    assert.equal(getEffectiveVolume(otherAudio, tracked, stores), 0, "non-selected stream audio is muted");
}

{
    const stores = storesFor(streamB, participants);
    const selectedAudio = audio({ id: "user-b", _speakingFlags: 2 });
    const otherAudio = audio({ id: "user-a", _speakingFlags: 2 });
    const tracked = new Set([selectedAudio, otherAudio]);

    assert.equal(getEffectiveVolume(selectedAudio, tracked, stores), 1, "changing primary stream unmutes the new selection");
    assert.equal(getEffectiveVolume(otherAudio, tracked, stores), 0, "changing primary stream mutes the previous selection");
}

{
    const stores = storesFor(streamA, participants);
    const selectedStreamAudio = audio({ id: "user-a", _speakingFlags: 2 });
    const normalVoiceAudio = audio({ id: "user-b", _speakingFlags: 1 });
    const tracked = new Set([selectedStreamAudio, normalVoiceAudio]);

    assert.equal(isLikelyStreamAudio(normalVoiceAudio, stores), false, "plain voice audio is not treated as stream audio");
    assert.equal(getEffectiveVolume(normalVoiceAudio, tracked, stores), 1, "plain voice audio is not muted");
}

{
    const stores = storesFor(streamA, participants);
    const selectedMutedAudio = audio({ id: "user-a", _speakingFlags: 2, _mute: true });
    const selectedLoweredAudio = audio({ id: "user-a", _speakingFlags: 2, _volume: 72 });

    assert.equal(getEffectiveVolume(selectedMutedAudio, new Set([selectedMutedAudio]), stores), 0, "Discord local mute is respected");
    assert.equal(getEffectiveVolume(selectedLoweredAudio, new Set([selectedLoweredAudio]), stores), 0.72, "Discord local volume is respected");
}

{
    const stores = storesFor(null, participants);
    const primaryAudio = audio({ id: "voice-like-a" });
    const otherStreamAudio = audio({ id: "voice-like-b" });
    const unrelatedVoiceAudio = audio({ id: "voice-like-c" });
    const streamAudio = new Set([primaryAudio, otherStreamAudio]);
    const tracked = new Set([primaryAudio, otherStreamAudio, unrelatedVoiceAudio]);

    assert.equal(shouldMuteStreamAudio(primaryAudio, tracked, stores, { primaryAudio, streamAudio }), false, "DOM primary stays audible");
    assert.equal(shouldMuteStreamAudio(otherStreamAudio, tracked, stores, { primaryAudio, streamAudio }), true, "DOM non-primary stream candidate is muted");
    assert.equal(shouldMuteStreamAudio(unrelatedVoiceAudio, tracked, stores, { primaryAudio, streamAudio }), false, "DOM fallback does not mute non-candidate voice");
}

{
    const selected = streamParticipant("user-a", "guild:guild:voice-channel:user-a");
    const other = streamParticipant("user-b", "guild:guild:voice-channel:user-b");
    const stores = storesFor(selected, [selected, other]);
    const selectedAudio = audio({ videoStreamId: selected.streamId, _speakingFlags: 2 });
    const otherAudio = audio({ videoStreamId: other.streamId, _speakingFlags: 2 });
    const tracked = new Set([selectedAudio, otherAudio]);
    assert.equal(getEffectiveVolume(selectedAudio, tracked, stores), 1, "selected compound stream key stays audible");
    assert.equal(getEffectiveVolume(otherAudio, tracked, stores), 0, "shared channel and guild do not match different stream owners");
}

console.log("primaryStreamAudio synthetic checks passed");
