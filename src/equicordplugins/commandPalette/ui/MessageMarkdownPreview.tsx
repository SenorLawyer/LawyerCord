/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { generateId } from "@api/Commands";
import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { LazyComponent } from "@utils/react";
import type { Message } from "@vencord/discord-types";
import { find, findByCodeLazy } from "@webpack";
import { moment, SelectedChannelStore, useEffect, useMemo, UserStore, useState } from "@webpack/common";

const cl = classNameFactory("vc-cmdpal-");

const createBotMessage = findByCodeLazy('username:"Clyde"');
const populateMessagePrototype = findByCodeLazy("isProbablyAValidSnowflake", "messageReference:");

const MessagePreview = LazyComponent<{
    className: string;
    author: { nick?: string; username: string; id: string; };
    message: Message;
    compact: boolean;
    isGroupStart: boolean;
    hideSimpleEmbedContent: boolean;
}>(() => find(m => m?.type?.toString().includes("previewLinkTarget:") && !m?.type?.toString().includes("HAS_THREAD")));

export function MessageMarkdownPreview({ content, channelId, files }: {
    content: string;
    channelId?: string | null;
    files?: File[];
}) {
    const [attachments, setAttachments] = useState<{ file: File; url: string; }[]>([]);

    useEffect(() => {
        const next = files?.map(file => ({ file, url: URL.createObjectURL(file) })) ?? [];
        setAttachments(next);

        return () => {
            for (const attachment of next) URL.revokeObjectURL(attachment.url);
        };
    }, [files]);

    const message = useMemo((): Message | null => {
        if (!content.trim()) return null;

        const resolvedChannelId = channelId ?? SelectedChannelStore.getChannelId() ?? "1337";
        const draft = createBotMessage({ content, channelId: resolvedChannelId, embeds: [] });
        if (!draft) return null;

        draft.id = generateId();
        draft.author = UserStore.getCurrentUser();
        draft.timestamp = moment();

        return populateMessagePrototype(draft) ?? draft;
    }, [channelId, content]);

    if (!message && attachments.length === 0) return null;

    const user = UserStore.getCurrentUser();
    const author = { ...user, nick: user.globalName || user.username };

    return (
        <div className={cl("markdown-preview")}>
            <div className={cl("markdown-preview-label")}>Preview</div>
            <div className={cl("markdown-preview-body")}>
                {content.trim() && message && (
                    <ErrorBoundary noop>
                        <MessagePreview
                            className={cl("message-preview")}
                            author={author}
                            message={message}
                            compact={false}
                            isGroupStart
                            hideSimpleEmbedContent={false}
                        />
                    </ErrorBoundary>
                )}
                {attachments.length > 0 && (
                    <div className={cl("preview-attachments")}>
                        {attachments.map(({ file, url }) => {
                            if (file.type.startsWith("image/")) {
                                return (
                                    <img
                                        key={url}
                                        className={cl("preview-image")}
                                        src={url}
                                        alt={file.name}
                                    />
                                );
                            }
                            if (file.type.startsWith("video/")) {
                                return (
                                    <video
                                        key={url}
                                        className={cl("preview-video")}
                                        src={url}
                                        controls
                                        preload="metadata"
                                    />
                                );
                            }
                            return (
                                <div key={url} className={cl("preview-file")}>
                                    {file.name}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
