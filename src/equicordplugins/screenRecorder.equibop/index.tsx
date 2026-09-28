/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ScreenshareIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { DraftType, Menu, UploadHandler } from "@webpack/common";

interface Recording {
    stream?: MediaStream;
    recorder?: MediaRecorder;
}

let recording: Recording | undefined;
const logger = new Logger("ScreenRecorder");

function releaseTracks(session: Recording) {
    for (const track of session.stream?.getTracks() ?? []) {
        track.onended = null;
        track.stop();
    }
}

function stopRecording() {
    const recorder = recording?.recorder;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    if (recording) releaseTracks(recording);
}

async function startRecording(channel: Channel) {
    if (recording) return;
    const session: Recording = {};
    recording = session;
    try {
        session.stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: { ideal: 60 } } });
        if (recording !== session) {
            releaseTracks(session);
            return;
        }
        const recorder = session.recorder = new MediaRecorder(session.stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
            releaseTracks(session);
            if (recording !== session) return;
            recording = undefined;
            if (chunks.length) {
                const file = new File(chunks, "recording.webm", { type: recorder.mimeType });
                UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
            }
        };
        for (const track of session.stream.getVideoTracks()) track.onended = stopRecording;
        recorder.start();
    } catch (error) {
        releaseTracks(session);
        if (recording === session) recording = undefined;
        logger.error("Could not start screen recording", error);
    }
}

const recordingMenu: NavContextMenuPatchCallback = (children, { channel }: { channel: Channel; }) => {
    children.push(<Menu.MenuItem
        id="screen-recording"
        label={recording ? "Stop Recording" : "Start Recording"}
        icon={ScreenshareIcon}
        disabled={recording !== undefined && recording.recorder === undefined}
        action={() => recording ? stopRecording() : startRecording(channel)}
    />);
};

export default definePlugin({
    name: "ScreenRecorder",
    description: "Adds an option to record your screen and upload the recording to the channel.",
    tags: ["Chat"],
    authors: [Devs.AutumnVN],
    contextMenus: {
        "channel-attach": recordingMenu
    },
    stop() {
        const session = recording;
        recording = undefined;
        if (!session) return;
        if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
        releaseTracks(session);
    }
});
