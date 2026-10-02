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

import ErrorBoundary from "@components/ErrorBoundary";
import { settings } from "@plugins/imageZoom";
import { ELEMENT_ID } from "@plugins/imageZoom/constants";
import { waitFor } from "@plugins/imageZoom/utils/waitFor";
import { classNameFactory } from "@utils/css";
import { FluxDispatcher, useCallback, useLayoutEffect, useMemo, useRef, useState } from "@webpack/common";

interface Vec2 {
    x: number,
    y: number;
}

export interface MagnifierProps {
    zoom: number;
    size: number,
    instance: any;
}

const cl = classNameFactory("vc-imgzoom-");

export const Magnifier = ErrorBoundary.wrap<MagnifierProps>(({ instance, size: initialSize, zoom: initalZoom }) => {
    const [ready, setReady] = useState(false);

    const [position, setPosition] = useState<{ lens: Vec2; image: Vec2; box: DOMRect; } | null>(null);

    const isShiftDown = useRef(false);

    const zoom = useRef(initalZoom);
    const size = useRef(initialSize);

    const element = useRef<HTMLDivElement | null>(null);
    const currentVideoElementRef = useRef<HTMLVideoElement | null>(null);
    const originalVideoElementRef = useRef<HTMLVideoElement | null>(null);

    const setVideoElement = useCallback((video: HTMLVideoElement | null) => {
        currentVideoElementRef.current?.pause();
        currentVideoElementRef.current = video;
    }, []);
    const syncVideos = () => {
        if (currentVideoElementRef.current && originalVideoElementRef.current)
            currentVideoElementRef.current.currentTime = originalVideoElementRef.current.currentTime;
    };

    // since we accessing document im gonna use useLayoutEffect
    useLayoutEffect(() => {
        setPosition(null);
        setReady(false);
        isShiftDown.current = false;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Shift") {
                isShiftDown.current = true;
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Shift") {
                isShiftDown.current = false;
            }
        };
        let frame: number | undefined;
        let pointer: MouseEvent;
        const updatePosition = () => {
            frame = undefined;
            if (!element.current) return;
            if (!instance.state.mouseOver || !instance.state.mouseDown) {
                setPosition(null);
                return;
            }
            const offset = size.current / 2;
            const box = element.current.getBoundingClientRect();
            setPosition({
                lens: { x: pointer.x - offset, y: pointer.y - offset },
                image: {
                    x: -((pointer.pageX - box.left) * zoom.current - offset),
                    y: -((pointer.pageY - box.top) * zoom.current - offset)
                },
                box
            });
        };
        const updateMousePosition = (e: MouseEvent) => {
            pointer = e;
            if (frame === undefined) frame = requestAnimationFrame(updatePosition);
        };

        const onMouseDown = (e: MouseEvent) => {
            if (instance.state.mouseOver && e.button === 0 /* left click */) {
                zoom.current = settings.store.zoom;
                size.current = settings.store.size;

                // close context menu if open
                if (document.getElementById("image-context")) {
                    FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" });
                }

                updateMousePosition(e);
            }
        };

        const onMouseUp = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = undefined;
            setPosition(null);
        };

        const onWheel = (e: WheelEvent) => {
            if (instance.state.mouseOver && instance.state.mouseDown && !isShiftDown.current) {
                const val = zoom.current + ((e.deltaY / 100) * (settings.store.invertScroll ? -1 : 1)) * settings.store.zoomSpeed;
                zoom.current = val <= 1 ? 1 : val;
                if (settings.store.saveZoomValues) settings.store.zoom = zoom.current;
                updateMousePosition(e);
            }
            if (instance.state.mouseOver && instance.state.mouseDown && isShiftDown.current) {
                const val = size.current + (e.deltaY * (settings.store.invertScroll ? -1 : 1)) * settings.store.zoomSpeed;
                size.current = val <= 50 ? 50 : val;
                if (settings.store.saveZoomValues) settings.store.size = size.current;
                updateMousePosition(e);
            }
        };

        const cancelWaitForReady = waitFor(() => instance.state.readyState === "READY", () => {
            const elem = document.getElementById(ELEMENT_ID) as HTMLDivElement | null;
            if (!elem) return;

            element.current = elem;
            elem.querySelector("img,video")?.setAttribute("draggable", "false");
            if (instance.props.animated) {
                originalVideoElementRef.current = elem.querySelector("video");
                originalVideoElementRef.current?.addEventListener("timeupdate", syncVideos);
            }

            setReady(true);
        });

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);
        document.addEventListener("mousemove", updateMousePosition);
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("wheel", onWheel);

        return () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("keyup", onKeyUp);
            document.removeEventListener("mousemove", updateMousePosition);
            document.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mouseup", onMouseUp);
            document.removeEventListener("wheel", onWheel);
            cancelWaitForReady();
            originalVideoElementRef.current?.removeEventListener("timeupdate", syncVideos);
            originalVideoElementRef.current = null;
            element.current = null;
        };
    }, [instance]);

    const imageSrc = useMemo(() => {
        try {
            const imageUrl = new URL(instance.props.src);
            if (imageUrl.pathname.startsWith("/attachments/"))
                imageUrl.hostname = "cdn.discordapp.com";

            imageUrl.searchParams.set("animated", "true");
            return imageUrl.toString();
        } catch {
            return instance.props.src;
        }
    }, [instance.props.src]);

    if (!ready || !position) return null;

    const { lens: lensPosition, image: imagePosition, box } = position;

    return (
        <div
            className={cl("lens", { "nearest-neighbor": settings.store.nearestNeighbour, square: settings.store.square })}
            style={{
                opacity: 1,
                width: size.current + "px",
                height: size.current + "px",
                transform: `translate(${lensPosition.x}px, ${lensPosition.y}px)`,
            }}
        >
            {instance.props.animated ?
                (
                    <video
                        ref={setVideoElement}
                        onLoadedMetadata={syncVideos}
                        style={{
                            position: "absolute",
                            left: `${imagePosition.x}px`,
                            top: `${imagePosition.y}px`
                        }}
                        width={`${box.width * zoom.current}px`}
                        height={`${box.height * zoom.current}px`}
                        poster={instance.props.src}
                        src={originalVideoElementRef.current?.src ?? instance.props.src}
                        autoPlay
                        loop
                        muted
                    />
                ) : (
                    <img
                        className={cl("image")}
                        style={{
                            position: "absolute",
                            transform: `translate(${imagePosition.x}px, ${imagePosition.y}px)`
                        }}
                        width={`${box.width * zoom.current}px`}
                        height={`${box.height * zoom.current}px`}
                        src={imageSrc}
                        alt=""
                    />
                )}
        </div>
    );
}, { noop: true });
