/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { Message } from "@vencord/discord-types";
import { Button, FluxDispatcher, MediaEngineStore, ReactDOM, useEffect, UserStore, useState, useStateFromStores } from "@webpack/common";
import video from "file://birthday.mp4?base64";

import Effects from "./Effects";

const SENDER_ID = "1045011641940574208";
const BIRTHDAY_ID = "519508374581149707";
const videoUrl = IS_WEB ? `data:video/mp4;base64,${video}` : "lawyercord://presentation.mp4";
const logger = new Logger("ClientPresentation");

async function playVideo(video: HTMLVideoElement) {
    video.muted = false;
    video.volume = 1;
    try {
        if ("setSinkId" in video) {
            const outputId = MediaEngineStore.getOutputDeviceId();
            const name = MediaEngineStore.getOutputDevices()[outputId]?.name.replace(/^Default \((.*)\)$/, "$1");
            const devices = await navigator.mediaDevices.enumerateDevices();
            const output = devices.find(device => device.kind === "audiooutput" && name && (
                device.label === name || device.label.startsWith(`${name} (`)
            )) ?? devices.find(device => device.kind === "audiooutput" && device.deviceId === outputId);
            if (!video.isConnected) return;
            if (output) await video.setSinkId(output.deviceId);
        }
    } catch (error) {
        logger.warn("Could not select the Discord audio output.", error);
    }
    if (!video.isConnected) return;
    video.play().catch(error => logger.warn("Could not start clip playback.", error));
    return video.sinkId || "default";
}

function CelebrationPlayer({ onClose }: { onClose(): void; }) {
    const [sinkId, setSinkId] = useState<string | null>(null);

    useEffect(() => {
        const timeout = setTimeout(onClose, 30_000);
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") onClose();
        }
        document.addEventListener("keydown", onKeyDown);
        return () => {
            clearTimeout(timeout);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [onClose]);

    return (
        <div className="vc-birthday-confetti-overlay">
            {sinkId !== null && <Effects sinkId={sinkId} />}
            {[0, 1, 2].map(id => <video key={id} className="vc-birthday-flying-video" data-flight={id}
                src={videoUrl} autoPlay muted loop playsInline aria-hidden="true" />)}
            <div className="vc-birthday-confetti-player">
                <video src={videoUrl} playsInline disablePictureInPicture disableRemotePlayback
                    onContextMenu={event => event.preventDefault()} onEnded={onClose} onLoadedMetadata={async event => {
                    const output = await playVideo(event.currentTarget);
                    if (output !== undefined) setSinkId(output);
                }} />
                <Button onClick={onClose}>Close birthday video</Button>
            </div>
        </div>
    );
}

const Celebration = ErrorBoundary.wrap(() => {
    const [messageId, setMessageId] = useState<string | null>(null);
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);

    useEffect(() => {
        if (userId !== SENDER_ID && userId !== BIRTHDAY_ID) return;
        function onMessage({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
            if (!optimistic && message.author.id === SENDER_ID && /birthday/i.test(message.content)) setMessageId(message.id);
        }
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
        return () => FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
    }, [userId]);

    useEffect(() => { setMessageId(null); }, [userId]);

    if (!messageId || (userId !== SENDER_ID && userId !== BIRTHDAY_ID)) return null;

    return ReactDOM.createPortal(
        <CelebrationPlayer key={messageId} onClose={() => setMessageId(null)} />,
        document.body
    );
}, { noop: true });

export default Celebration;
