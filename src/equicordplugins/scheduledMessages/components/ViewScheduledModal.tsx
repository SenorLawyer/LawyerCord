/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, closeModal, Modal, openModal, showToast, Toasts, UserStore, useState, useStateFromStores } from "@webpack/common";

import { clearAllScheduledMessages, getChannelDisplayInfo, getScheduledMessages, loadScheduledMessages, removeScheduledMessage, sendScheduledMessageNow } from "../utils";
import { CalendarIcon, TimerIcon } from "./Icons";
import { openScheduleTimeModal } from "./ScheduleTimeModal";

const cl = classNameFactory("vc-scheduled-msg-");

interface ViewScheduledModalProps {
    rootProps: RenderModalProps;
    close: () => void;
}

function ViewScheduledModalInner({ rootProps, close }: ViewScheduledModalProps) {
    const [savedMessages, setMessages] = useState(getScheduledMessages());
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const messages = savedMessages.filter(msg => userId && (!msg.userId || msg.userId === userId));

    const handleDelete = async (id: string) => {
        if (!userId || UserStore.getCurrentUser()?.id !== userId) return;
        const removed = await removeScheduledMessage(id).then(() => true, () => false);
        if (UserStore.getCurrentUser()?.id !== userId) return;
        if (removed) setMessages(getScheduledMessages());
        showToast(removed ? "Scheduled message removed" : "Could not remove the scheduled message. Try again.", removed ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
    };

    const handleClearAll = async () => {
        if (!userId || UserStore.getCurrentUser()?.id !== userId) return;
        const cleared = await clearAllScheduledMessages().then(() => true, () => false);
        if (UserStore.getCurrentUser()?.id !== userId) return;
        if (cleared) setMessages(getScheduledMessages());
        showToast(cleared ? "Scheduled messages cleared" : "Could not clear scheduled messages. Try again.", cleared ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
    };

    const handleRetry = async (id: string) => {
        if (!userId || UserStore.getCurrentUser()?.id !== userId) return;
        const result = await sendScheduledMessageNow(id);
        if (UserStore.getCurrentUser()?.id !== userId) return;
        if (result.success) setMessages(getScheduledMessages());
        showToast(result.success ? "Scheduled message sent" : result.error ?? "Could not send the scheduled message. Try again.", result.success ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
    };

    const handleReload = async () => {
        if (!userId || UserStore.getCurrentUser()?.id !== userId) return;
        const loaded = await loadScheduledMessages().then(() => true, () => false);
        if (UserStore.getCurrentUser()?.id !== userId) return;
        if (loaded) setMessages(getScheduledMessages());
        else showToast("Could not reload scheduled messages. The saved data has been kept.", Toasts.Type.FAILURE);
    };

    const actions = [
        {
            text: "Reload",
            variant: "secondary",
            onClick: handleReload
        },
        {
            text: "Close",
            variant: "secondary",
            onClick: close
        }
    ];

    if (messages.length > 0) {
        actions.unshift({
            text: "Clear All",
            variant: "dangerPrimary",
            onClick: handleClearAll
        });
    }

    return (
        <Modal
            {...rootProps}
            size="md"
            title="Scheduled Messages"
            actions={actions}
        >
            {!messages.length ? (
                <div className={cl("empty-state")}>
                    <CalendarIcon width={48} height={48} />
                    <span>No scheduled messages</span>
                </div>
            ) : (
                <div className={cl("message-list")}>
                    {messages.map(msg => {
                        const { name, avatar } = getChannelDisplayInfo(msg.channelId);
                        const channel = ChannelStore.getChannel(msg.channelId);
                        const isDM = !channel || channel.isPrivate();
                        const displayContent = msg.content.length > 200
                            ? msg.content.slice(0, 200) + "..."
                            : msg.content;

                        return (
                            <div key={msg.id} className={cl("message-item")}>
                                <div className={cl("message-info")}>
                                    <div className={cl("message-header")}>
                                        {avatar && <img src={avatar} className={cl("message-avatar")} alt="" />}
                                        <span className={cl("message-channel")}>
                                            {isDM ? name : `#${name}`}
                                        </span>
                                    </div>
                                    <div className={cl("message-time")}>
                                        <TimerIcon width={14} height={14} />
                                        <span>{!msg.userId ? "Paused. This older message has no saved account. Recreate it to choose an account and a new time. The original stays paused." : msg.attemptedAt === undefined ? new Date(msg.scheduledTime).toLocaleString() : "Send attempted. Check the channel before retrying."}</span>
                                    </div>
                                    <div className={cl("message-content")}>{displayContent}</div>
                                </div>
                                <div className={cl("message-actions")}>
                                    {msg.attemptedAt !== undefined && msg.userId === userId && (
                                        <Button
                                            size="small"
                                            variant="secondary"
                                            onClick={() => handleRetry(msg.id)}
                                        >
                                            Retry
                                        </Button>
                                    )}
                                    {!msg.userId && (
                                        <Button
                                            size="small"
                                            variant="secondary"
                                            onClick={() => {
                                                if (UserStore.getCurrentUser()?.id !== userId) return;
                                                openScheduleTimeModal(msg.channelId, msg.content, msg.attachments);
                                            }}
                                        >
                                            Recreate
                                        </Button>
                                    )}
                                    <Button
                                        size="small"
                                        variant="dangerPrimary"
                                        onClick={() => handleDelete(msg.id)}
                                    >
                                        Delete
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </Modal>
    );
}

export const ViewScheduledModal = ErrorBoundary.wrap(ViewScheduledModalInner, { noop: true });

export function openViewScheduledModal(): void {
    const key = openModal(props => (
        <ViewScheduledModal rootProps={props} close={() => closeModal(key)} />
    ));
}
