/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings as PluginSettings } from "@equicordplugins/toastNotifications/index";
import { Channel, Message } from "@vencord/discord-types";
import { createRoot } from "@webpack/common";
import type { JSX } from "react";
import type { Root } from "react-dom/client";

import NotificationComponent from "./NotificationComponent";

interface QueuedNotification {
    key: string;
    element: JSX.Element;
    resolve(): void;
}

let NotificationQueue: QueuedNotification[] = [];
let notificationID = 0;
let RootContainer: Root | undefined;
let ToastContainer: HTMLDivElement | undefined;

function renderQueue(root: Root) {
    root.render(<>{NotificationQueue.map(n => n.element)}</>);
}

function getNotificationContainer() {
    // If the root container doesn't exist, create it.
    if (!RootContainer) {
        ToastContainer = document.createElement("div");
        ToastContainer.id = "vc-toast-notifications-container";
        document.body.append(ToastContainer);
        RootContainer = createRoot(ToastContainer);
    }

    // Keep the container's position class in sync with the user's setting.
    if (ToastContainer) {
        ToastContainer.className = `vc-toast-notifications-position-${PluginSettings.store.position ?? "bottom-left"}`;
    }

    return RootContainer;
}

export function setContainerPosition(position: string) {
    if (ToastContainer) ToastContainer.className = `vc-toast-notifications-position-${position ?? "bottom-left"}`;
}

interface BaseNotification {
    permanent?: boolean;
    dismissOnClick?: boolean;
    onClick?(): void;
}

export interface MessageNotification extends BaseNotification {
    message: Message;
    mockedMessage: Message;
    channel: Channel;
}

export interface SystemNotification extends BaseNotification {
    title: string;
    body: string;
    icon?: string;
}

export type NotificationData = MessageNotification | SystemNotification;

export async function showNotification(notification: NotificationData) {
    const root = getNotificationContainer();
    const notificationKey = (notificationID++).toString();

    return new Promise<void>(resolve => {
        const ToastNotification = (
            <NotificationComponent
                key={notificationKey}
                {...notification}
                onClose={() => {
                    const oldLength = NotificationQueue.length;
                    NotificationQueue = NotificationQueue.filter(n => n.key !== notificationKey);
                    if (NotificationQueue.length === oldLength) return;

                    renderQueue(root);
                    resolve();
                }}
            />
        );

        // Push this notification into the stack.
        NotificationQueue.push({
            key: notificationKey,
            element: ToastNotification,
            resolve
        });

        // If the queue exceeds the maximum number of notifications, remove the oldest ones.
        const excess = Math.max(0, NotificationQueue.length - (PluginSettings.store.maxNotifications ?? 3));
        for (const removed of NotificationQueue.splice(0, excess)) removed.resolve();

        renderQueue(root);
    });
}

/**
 * Tears down the notification root and removes the container from the DOM.
 * Called when the plugin is disabled.
 */
export function teardownNotifications() {
    for (const notification of NotificationQueue) notification.resolve();
    NotificationQueue = [];
    RootContainer?.unmount();
    RootContainer = undefined;
    ToastContainer?.remove();
    ToastContainer = undefined;
}
