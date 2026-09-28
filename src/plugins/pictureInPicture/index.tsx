/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Button, showToast, Toasts, Tooltip } from "@webpack/common";

interface MediaActionProps {
    mimeType?: string[];
    downloadURL?: string;
    showDownload: boolean;
    isVisualMediaType: boolean;
}

const logger = new Logger("PictureInPicture");
let pendingVideo: HTMLVideoElement | undefined;
let pendingTimeout: ReturnType<typeof setTimeout> | undefined;

const settings = definePluginSettings({
    loop: {
        description: "Whether to make the PiP video loop or not",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: false
    }
});

export default definePlugin({
    name: "PictureInPicture",
    description: "Adds picture in picture to videos (next to the Download button)",
    tags: ["Media", "Utility"],
    authors: [Devs.Lumap],
    settings,
    patches: [
        {
            find: '["VIDEO","CLIP","AUDIO"]',
            replacement: {
                match: /(\[\i>0&&\i\.length>0.{0,150}?children:)(\i\.slice\(\i\))/,
                replace: "$1[$self.shouldShowButton(arguments[0])&&$self.PictureInPictureButton(),...$2]"
            }
        }
    ],

    shouldShowButton({ mimeType = [], downloadURL, showDownload, isVisualMediaType }: MediaActionProps) {
        if (!showDownload || !isVisualMediaType) return false;
        const normalizedMimeType = mimeType.join("/");
        if (normalizedMimeType.startsWith("video/")) return true;
        if (!downloadURL) return false;
        return /\.(mp4|webm|mov|m4v|ogv|avi)(?:$|[?#])/i.test(downloadURL);
    },

    PictureInPictureButton: ErrorBoundary.wrap(() => {
        return (
            <Tooltip text="Open Picture in Picture">
                {tooltipProps => (
                    <Button
                        {...tooltipProps}
                        className="vc-pip-button"
                        type="button"
                        aria-label="Open Picture in Picture"
                        color={Button.Colors.CUSTOM}
                        size={Button.Sizes.NONE}
                        onClick={e => {
                            const video = e.currentTarget.parentNode!.parentNode!.querySelector("video")!;
                            if (pendingVideo) {
                                clearTimeout(pendingTimeout);
                                pendingVideo.onloadedmetadata = null;
                                pendingVideo.onerror = null;
                                pendingVideo.removeAttribute("src");
                                pendingVideo.load();
                                pendingVideo.remove();
                            }
                            const videoClone = document.body.appendChild(video.cloneNode(true)) as HTMLVideoElement;

                            pendingVideo = videoClone;
                            videoClone.loop = settings.store.loop;
                            videoClone.muted = video.muted;
                            videoClone.volume = video.volume;
                            videoClone.playbackRate = video.playbackRate;
                            videoClone.style.display = "none";
                            videoClone.onleavepictureinpicture = () => {
                                videoClone.pause();
                                videoClone.remove();
                            };

                            async function failPiP() {
                                if (!videoClone.isConnected) return;
                                videoClone.onloadedmetadata = null;
                                videoClone.onerror = null;
                                if (pendingVideo === videoClone) {
                                    pendingVideo = undefined;
                                    clearTimeout(pendingTimeout);
                                    videoClone.removeAttribute("src");
                                    videoClone.load();
                                }
                                videoClone.pause();
                                videoClone.remove();
                                if (document.pictureInPictureElement === videoClone) {
                                    await document.exitPictureInPicture().catch((error: unknown) => logger.warn("Could not close Picture in Picture.", error));
                                }
                                showToast("Could not open Picture in Picture.", Toasts.Type.FAILURE);
                            }

                            async function launchPiP() {
                                if (pendingVideo !== videoClone) return;
                                pendingVideo = undefined;
                                clearTimeout(pendingTimeout);
                                videoClone.onloadedmetadata = null;
                                videoClone.onerror = null;
                                try {
                                    videoClone.currentTime = video.currentTime;
                                    await videoClone.requestPictureInPicture();
                                    if (!videoClone.isConnected) return;
                                    await videoClone.play();
                                    if (!videoClone.isConnected) {
                                        videoClone.pause();
                                        return;
                                    }
                                    video.pause();
                                } catch {
                                    await failPiP();
                                }
                            }

                            videoClone.onerror = failPiP;
                            if (videoClone.readyState === 4 /* HAVE_ENOUGH_DATA */)
                                launchPiP();
                            else {
                                videoClone.onloadedmetadata = launchPiP;
                                pendingTimeout = setTimeout(failPiP, 30_000);
                            }
                        }}
                    >
                        <svg width="24px" height="24px" viewBox="0 0 24 24">
                            <path
                                fill="currentColor"
                                d="M21 3a1 1 0 0 1 1 1v7h-2V5H4v14h6v2H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h18zm0 10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h8zm-1 2h-6v4h6v-4z"
                            />
                        </svg>
                    </Button>
                )}
            </Tooltip>
        );
    }, { noop: true })
});
