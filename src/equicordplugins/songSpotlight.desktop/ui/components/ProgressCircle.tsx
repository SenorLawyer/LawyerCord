/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RenderInfoEntry } from "@song-spotlight/api/handlers";
import { useEffect, useState } from "@webpack/common";
import { JSX, RefObject } from "react";

interface ProgressCircleProps extends SvgProps {
    border: number;
    audioRef: RefObject<HTMLAudioElement | undefined>;
    playing: RenderInfoEntry | undefined;
}
type SvgProps = JSX.IntrinsicElements["svg"];

const SIZE = 50;
const EVENTS = ["timeupdate", "durationchange", "seeked", "play", "pause", "ended"] as const;

export default function ProgressCircle({ border, audioRef, playing, ...props }: ProgressCircleProps) {
    const radius = SIZE - border * 2;
    const stroke = border * 2;
    const circumference = Math.PI * 2 * radius;
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        const audio = audioRef.current, preview = playing?.audio;
        if (!audio || !preview) {
            setProgress(0);
            return;
        }
        const update = () => {
            if (Number.isFinite(audio.duration) && !audio.paused) {
                let start = 0, slice = audio.duration;
                if (preview.previewStart !== undefined && preview.previewSlice) {
                    start = preview.previewStart / 1000;
                    slice = preview.previewSlice / 1000;
                }
                setProgress(slice > 0 ? Math.min(Math.max((audio.currentTime - start) / slice, 0), 1) : 0);
            } else {
                setProgress(0);
            }

        };
        update();
        for (const event of EVENTS) audio.addEventListener(event, update);
        return () => {
            for (const event of EVENTS) audio.removeEventListener(event, update);
        };
    }, [audioRef, playing]);

    return (
        <svg
            {...props}
            viewBox={`0 0 ${SIZE * 2} ${SIZE * 2}`}
        >
            <circle
                cx={SIZE}
                cy={SIZE}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke}
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - progress)}
                strokeLinecap="round"
                transform={`rotate(-90 ${SIZE} ${SIZE})`}
            />
        </svg>
    );
}
