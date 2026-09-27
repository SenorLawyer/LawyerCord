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
import { showToast, Toasts, Tooltip } from "@webpack/common";

const logger = new Logger("PictureInPicture");
let pendingVideo: HTMLVideoElement | undefined;

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
                match: /(\[\i>0&&\i\.length>0.{0,150}?children:)(\i.slice\(\i\))(?<=mimeType:(\i),downloadURL:(\i).+?showDownload:(\i).+?isVisualMediaType:(\i).+?)/,
                replace: (_, rest, origChildren, mimeType, downloadURL, showDownload, isVisualMediaType) =>
                    `${rest}[${showDownload}&&${isVisualMediaType}&&$self.shouldShowButton(${mimeType},${downloadURL})&&$self.PictureInPictureButton(),...${origChildren}]`
            }
        }
    ],

    shouldShowButton(mimeType: string[] = [], downloadURL?: string) {
        const normalizedMimeType = mimeType.join("/");
        if (normalizedMimeType.startsWith("video/")) return true;
        if (!downloadURL) return false;
        return /\.(mp4|webm|mov|m4v|ogv|avi)(?:$|[?#])/i.test(downloadURL);
    },

    PictureInPictureButton: ErrorBoundary.wrap(() => {
        return (
            <Tooltip text="Toggle Picture in Picture">
                {tooltipProps => (
                    <div
                        {...tooltipProps}
                        className="vc-pip-button"
                        role="button"
                        style={{
                            cursor: "pointer",
                            paddingTop: "4px",
                            paddingLeft: "4px",
                            paddingRight: "4px",
                        }}
                        onClick={e => {
                            const video = e.currentTarget.parentNode!.parentNode!.querySelector("video")!;
                            if (pendingVideo) {
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
                            videoClone.onleavepictureinpicture = () => videoClone.remove();

                            async function failPiP() {
                                if (pendingVideo === videoClone) pendingVideo = undefined;
                                if (!videoClone.isConnected) return;
                                videoClone.onloadedmetadata = null;
                                videoClone.onerror = null;
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
                                videoClone.onloadedmetadata = null;
                                videoClone.onerror = null;
                                try {
                                    videoClone.currentTime = video.currentTime;
                                    await videoClone.requestPictureInPicture();
                                    await videoClone.play();
                                    video.pause();
                                } catch {
                                    await failPiP();
                                }
                            }

                            videoClone.onerror = failPiP;
                            if (videoClone.readyState === 4 /* HAVE_ENOUGH_DATA */)
                                launchPiP();
                            else
                                videoClone.onloadedmetadata = launchPiP;
                        }}
                    >
                        <svg width="24px" height="24px" viewBox="0 0 24 24">
                            <path
                                fill="currentColor"
                                d="M21 3a1 1 0 0 1 1 1v7h-2V5H4v14h6v2H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h18zm0 10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h8zm-1 2h-6v4h6v-4z"
                            />
                        </svg>
                    </div>
                )}
            </Tooltip>
        );
    }, { noop: true })
});
