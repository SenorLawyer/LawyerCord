/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { closeModal, Modal, openModal, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { getChannelDisplayInfo, getMissedMessages, removeScheduledMessage, sendScheduledMessageNow } from "../utils";
import { TimerIcon } from "./Icons";
import { openScheduleTimeModal } from "./ScheduleTimeModal";

const cl = classNameFactory("vc-scheduled-msg-");

function MissedMessagesModalInner({ rootProps, close }: { rootProps: RenderModalProps; close: () => void; }) {
    const [messages, setMessages] = useState(getMissedMessages);

    useEffect(() => {
        if (!messages.length) close();
    }, [messages.length]);

    const handleSend = async (id: string) => {
        const result = await sendScheduledMessageNow(id);
        showToast(result.success ? "Scheduled message sent" : result.error ?? "Could not send the scheduled message. Try again.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
        setMessages(getMissedMessages());
    };

    const handleDelete = async (id: string) => {
        const removed = await removeScheduledMessage(id).then(() => true, () => false);
        if (!removed) showToast("Could not remove the scheduled message. Try again.", Toasts.Type.FAILURE);
        setMessages(getMissedMessages());
    };

    return (
        <Modal
            {...rootProps}
            size="md"
            title="Missed Scheduled Messages"
            actions={[{ text: "Decide Later", variant: "secondary", onClick: close }]}
        >
            <div className={cl("message-list")}>
                {messages.map(msg => {
                    const { name } = getChannelDisplayInfo(msg.channelId);
                    return (
                        <div key={msg.id} className={cl("message-item")}>
                            <div className={cl("message-info")}>
                                <div className={cl("message-header")}>
                                    <span className={cl("message-channel")}>{name}</span>
                                </div>
                                <div className={cl("message-time")}>
                                    <TimerIcon width={14} height={14} />
                                    <span>Was due {new Date(msg.scheduledTime).toLocaleString()}</span>
                                </div>
                                <div className={cl("message-content")}>
                                    {msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content}
                                </div>
                            </div>
                            <div className={cl("message-actions")}>
                                <Button size="small" variant="primary" onClick={() => handleSend(msg.id)}>
                                    Send now
                                </Button>
                                <Button size="small" variant="secondary" onClick={() => openScheduleTimeModal(msg.channelId, msg.content, msg.attachments, undefined, msg.id)}>
                                    Reschedule
                                </Button>
                                <Button size="small" variant="dangerPrimary" onClick={() => handleDelete(msg.id)}>
                                    Delete
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Modal>
    );
}

const MissedMessagesModal = ErrorBoundary.wrap(MissedMessagesModalInner, { noop: true });

export function openMissedMessagesModal(): void {
    const key = openModal(props => <MissedMessagesModal rootProps={props} close={() => closeModal(key)} />);
}
