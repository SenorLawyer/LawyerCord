/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Logger } from "@utils/Logger";
import { Button, MediaEngineStore, useEffect, useRef, useState } from "@webpack/common";

import { settings, type VoiceRecorder } from "..";

const logger = new Logger("VoiceMessages");

export const VoiceRecorderWeb: VoiceRecorder = ({ setAudioBlob, onRecordingChange }) => {
    const [recording, setRecording] = useState(false);
    const [paused, setPaused] = useState(false);
    const [recorder, setRecorder] = useState<MediaRecorder>();
    const active = useRef<{ dispose(): void; } | undefined>(undefined);

    useEffect(() => () => {
        const session = active.current;
        active.current = undefined;
        session?.dispose();
    }, []);

    const changeRecording = (recording: boolean) => {
        setRecording(recording);
        onRecordingChange?.(recording);
    };

    function toggleRecording() {
        const nowRecording = !recording;

        if (nowRecording) {
            if (active.current) return;
            const session = { dispose: () => {} };
            active.current = session;

            const finish = () => {
                active.current = undefined;
                session.dispose();
                setRecorder(undefined);
                setPaused(false);
                changeRecording(false);
            };
            const fail = (error: unknown) => {
                if (active.current !== session) return;
                finish();
                logger.error("Could not record audio.", error);
            };

            navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: settings.store.echoCancellation,
                    noiseSuppression: settings.store.noiseSuppression,
                    deviceId: MediaEngineStore.getInputDeviceId()
                }
            }).then(mediaStream => {
                session.dispose = () => mediaStream.getTracks().forEach(track => track.stop());
                if (active.current !== session) {
                    session.dispose();
                    return;
                }
                const chunks: Blob[] = [];

                const recorder = new MediaRecorder(mediaStream);
                setRecorder(recorder);

                const handleDataAvailable = (e: BlobEvent) => {
                    chunks.push(e.data);
                };

                const handleStop = () => {
                    if (active.current !== session) return;
                    const blob = new Blob(chunks, { type: recorder.mimeType });
                    finish();
                    setAudioBlob(blob);
                };
                const handleError = () => fail(new Error("The audio recorder reported an error."));

                session.dispose = () => {
                    recorder.removeEventListener("dataavailable", handleDataAvailable);
                    recorder.removeEventListener("stop", handleStop);
                    recorder.removeEventListener("error", handleError);
                    if (recorder.state !== "inactive") recorder.stop();
                    mediaStream.getTracks().forEach(track => track.stop());
                };
                recorder.addEventListener("dataavailable", handleDataAvailable);
                recorder.addEventListener("stop", handleStop, { once: true });
                recorder.addEventListener("error", handleError);
                recorder.start();

                changeRecording(true);
            }).catch(fail);
        } else if (recorder && recorder.state !== "inactive") {
            recorder.stop();
        }
    }

    return (
        <>
            <Button onClick={toggleRecording}>
                {recording ? "Stop" : "Start"} recording
            </Button>

            <Button
                disabled={!recording}
                onClick={() => {
                    if (!recorder || recorder.state === "inactive") return;
                    const nowPaused = recorder.state === "recording";
                    if (nowPaused) recorder.pause();
                    else recorder.resume();
                    setPaused(nowPaused);
                }}
            >
                {paused ? "Resume" : "Pause"} recording
            </Button>
        </>
    );
};
