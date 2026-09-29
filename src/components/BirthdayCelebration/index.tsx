/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Message } from "@vencord/discord-types";
import { Button, FluxDispatcher, ReactDOM, useEffect, UserStore, useState, useStateFromStores } from "@webpack/common";
import video from "file://birthday.mp4?base64";

const SENDER_ID = "1045011641940574208";
const BIRTHDAY_ID = "519508374581149707";
const videoUrl = `data:video/mp4;base64,${video}`;
const colors = ["#ff477e", "#ffd166", "#06d6a0", "#38bdf8", "#c084fc"];

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
        <div className="vc-birthday-confetti-overlay" key={messageId}>
            <div className="vc-birthday-confetti-particles" aria-hidden="true">
                {Array.from({ length: 160 }, (_, id) => (
                    <span key={id} style={{
                        left: `${id * 137.508 % 100}%`,
                        backgroundColor: colors[id % colors.length],
                        animationDelay: `${-(id % 40) / 10}s`,
                        animationDuration: `${3 + id % 17 / 10}s`
                    }} />
                ))}
            </div>
            <div className="vc-birthday-confetti-player">
                <video src={videoUrl} autoPlay controls playsInline onEnded={() => setMessageId(null)} />
                <Button onClick={() => setMessageId(null)}>Close birthday video</Button>
            </div>
        </div>,
        document.body
    );
}, { noop: true });

export default Celebration;
