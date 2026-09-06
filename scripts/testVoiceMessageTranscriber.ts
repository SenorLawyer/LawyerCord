import assert from "node:assert/strict";

import { detectAudioMimeType, isRecognizedAudioContainer } from "../src/equicordplugins/voiceMessageTranscriber.desktop/audioValidation";
import { buildTargetLanguageOptions, getVoiceMessageMedia, resolveTargetLanguage, VOICE_MESSAGE_FLAG } from "../src/equicordplugins/voiceMessageTranscriber.desktop/options";
import { formatTimestampedTranscript, normalizeTranscriptionResult } from "../src/equicordplugins/voiceMessageTranscriber.desktop/transcriptionData";
import { generateWaveform } from "../src/plugins/voiceMessages/waveform";

const attachment = {
    content_type: "audio/ogg",
    duration_secs: 3.5,
    filename: "voice-message.ogg",
    url: "https://cdn.discordapp.com/attachments/channel/message/voice-message.ogg",
    waveform: "AQID"
};

assert.deepEqual(
    getVoiceMessageMedia({ flags: VOICE_MESSAGE_FLAG, attachments: [attachment] }),
    { duration: attachment.duration_secs, needsPlaybackFallback: false, url: attachment.url, waveform: attachment.waveform },
    "received voice messages are eligible",
);
assert.equal(
    getVoiceMessageMedia({ flags: 0, attachments: [attachment] }),
    null,
    "ordinary audio attachments are not mistaken for voice messages",
);
assert.deepEqual(
    getVoiceMessageMedia({
        flags: VOICE_MESSAGE_FLAG,
        attachments: [{ ...attachment, content_type: "video/mp4", waveform: undefined }]
    }),
    { duration: attachment.duration_secs, needsPlaybackFallback: true, url: attachment.url, waveform: undefined },
    "malformed voice-message metadata receives a playback fallback",
);

const options = buildTargetLanguageOptions({ auto: "Detect language", en: "English", fr: "French" });
assert.deepEqual(options, [{ value: "en", label: "English" }, { value: "fr", label: "French" }]);
assert.equal(resolveTargetLanguage("fr", options), "fr", "the configured target is retained");
assert.equal(resolveTargetLanguage("unsupported", options), "en", "English is the safe provider fallback");

const transcript = normalizeTranscriptionResult({
    text: " Hello there. ",
    chunks: [
        { timestamp: [0, 1.8], text: " Hello" },
        { timestamp: [1.8, null], text: " there." },
        { timestamp: ["bad", 2], text: "ignored" }
    ]
});
assert.equal(transcript.text, "Hello there.");
assert.equal(transcript.chunks.length, 2, "malformed timestamp chunks are discarded");
assert.equal(formatTimestampedTranscript(transcript), "[00:00 - 00:01] Hello\n[00:01 - end] there.");

assert.equal(isRecognizedAudioContainer(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0])), true, "OGG voice messages are accepted without relying on Content-Type");
assert.equal(detectAudioMimeType(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0])), "audio/mp4", "mislabelled MP4 audio receives a playable MIME type");
assert.equal(isRecognizedAudioContainer(new TextEncoder().encode("<html>nope</html>")), false, "non-audio CDN responses are rejected");

const samples = Float32Array.from({ length: 16_000 }, (_, index) => Math.sin(2 * Math.PI * 440 * index / 16_000) * (index / 16_000));
const waveform = Uint8Array.from(globalThis.atob(generateWaveform(samples, 16_000)), character => character.charCodeAt(0));
assert.equal(waveform.length, 32, "short audio uses Discord's minimum waveform resolution");
assert.ok(waveform.some(value => value > 0), "generated waveforms contain audible amplitude");
assert.ok(new Set(waveform).size > 1, "generated waveforms preserve changing amplitude instead of rendering flat");

console.log("voice-message transcription checks passed");
