/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { canvas } from "./components/Canvas";
import { EventEmitter } from "./utils/eventEmitter";

export const Mouse = {
    x: 0,
    y: 0,
    down: false,
    dx: 0,
    dy: 0,
    prevX: 0,
    prevY: 0,
    event: new EventEmitter<MouseEvent>()
};

export function initInput() {
    if (!canvas) return;

    const targetCanvas = canvas;

    const onMouseMove = (e: MouseEvent) => {
        Mouse.prevX = Mouse.x;
        Mouse.prevY = Mouse.y;

        const rect = targetCanvas.getBoundingClientRect();
        const scaleX = targetCanvas.width / rect.width;
        const scaleY = targetCanvas.height / rect.height;

        Mouse.x = (e.clientX - rect.left) * scaleX;
        Mouse.y = (e.clientY - rect.top) * scaleY;

        Mouse.dx = Mouse.x - Mouse.prevX;
        Mouse.dy = Mouse.y - Mouse.prevY;

        Mouse.event.emit("move", e);
    };

    const onMouseDown = () => {
        Mouse.down = true;
    };

    const onMouseUp = (e: MouseEvent) => {
        Mouse.down = false;

        Mouse.event.emit("up", e);
    };

    const onMouseLeave = (e: MouseEvent) => {
        Mouse.down = false;

        Mouse.event.emit("up", e);
    };

    targetCanvas.addEventListener("mousemove", onMouseMove);
    targetCanvas.addEventListener("mousedown", onMouseDown);
    targetCanvas.addEventListener("mouseup", onMouseUp);
    targetCanvas.addEventListener("mouseleave", onMouseLeave);

    return () => {
        Mouse.down = false;
        targetCanvas.removeEventListener("mousemove", onMouseMove);
        targetCanvas.removeEventListener("mousedown", onMouseDown);
        targetCanvas.removeEventListener("mouseup", onMouseUp);
        targetCanvas.removeEventListener("mouseleave", onMouseLeave);
    };
}
