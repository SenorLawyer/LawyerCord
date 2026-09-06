/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { ChannelStore, CloudUploader, Constants, FluxDispatcher, GuildStore, IconUtils, MessageActions, MessageStore, RestAPI, showToast, SnowflakeUtils, Toasts, UserStore } from "@webpack/common";

import { settings } from ".";
import { PhantomMessageData, ScheduledAttachment, ScheduledMessage, ScheduledReaction } from "./types";

const logger = new Logger("ScheduledMessages");
const STORAGE_KEY = "ScheduledMessages_queue";

let scheduledMessages: ScheduledMessage[] = [];
let queueLoaded = false;
let invalidStoredQueue = false;
let queueOperation: Promise<void> = Promise.resolve();
let checkTimeout: ReturnType<typeof setTimeout> | null = null;
let schedulerRunning = false;
let schedulerGeneration = 0;
let isProcessingMessages = false;
const sendingMessages = new Set<string>();

export const phantomMessageMap = new Map<string, PhantomMessageData>();

const recentReactionChanges = new Map<string, { action: string; timestamp: number; }>();
const REACTION_COOLDOWN_MS = 2000;

const pendingRecreations = new Map<string, ReturnType<typeof setTimeout>>();
const RECREATE_DEBOUNCE_MS = 300;
let phantomGeneration = 0;

function isStoredTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function isScheduledMessage(value: unknown): value is ScheduledMessage {
    if (!isObject(value)) return false;
    const entry = value as Partial<ScheduledMessage>;
    return typeof entry.id === "string" && entry.id.length > 0
        && typeof entry.channelId === "string" && entry.channelId.length > 0
        && typeof entry.content === "string"
        && isStoredTimestamp(entry.scheduledTime) && isStoredTimestamp(entry.createdAt)
        && (entry.userId === undefined || typeof entry.userId === "string" && entry.userId.length > 0)
        && (entry.attemptedAt === undefined || isStoredTimestamp(entry.attemptedAt))
        && (entry.attachments === undefined || Array.isArray(entry.attachments) && [...entry.attachments].every((attachment: unknown) => {
            if (!isObject(attachment)) return false;
            const item = attachment as Partial<ScheduledAttachment>;
            return typeof item.filename === "string" && typeof item.data === "string" && typeof item.type === "string";
        }))
        && (entry.reactions === undefined || Array.isArray(entry.reactions) && [...entry.reactions].every((reaction: unknown) => {
            if (!isObject(reaction)) return false;
            const item = reaction as Partial<ScheduledReaction>;
            return isObject(item.emoji) && (item.emoji.id === null || typeof item.emoji.id === "string")
                && typeof item.emoji.name === "string"
                && (item.emoji.animated === undefined || typeof item.emoji.animated === "boolean")
                && typeof item.count === "number" && Number.isSafeInteger(item.count) && item.count >= 0;
        }));
}

export function loadScheduledMessages(): Promise<void> {
    return runQueueOperation(readStoredQueue, true);
}

async function readStoredQueue(): Promise<void> {
    invalidStoredQueue = true;
    const saved = await DataStore.get<unknown>(STORAGE_KEY);
    if (saved !== undefined && (!Array.isArray(saved) || ![...saved].every(isScheduledMessage) || new Set(saved.map(entry => entry.id)).size !== saved.length)) {
        stopScheduler();
        cleanupAllPhantomMessages();
        scheduledMessages = [];
        throw new Error("Saved scheduled messages are invalid. The stored data has been preserved.");
    }
    queueLoaded = true;
    invalidStoredQueue = false;
    scheduledMessages = saved ?? [];
    scheduledMessages.sort((a, b) => a.scheduledTime - b.scheduledTime);
}

function runQueueOperation<T>(operation: () => Promise<T>, loading = false): Promise<T> {
    const result = queueOperation.then(async () => {
        if (!loading) {
            if (invalidStoredQueue) throw new Error("Saved scheduled messages must be recovered before changing the queue.");
            if (!queueLoaded) await readStoredQueue();
        }
        return operation();
    });
    queueOperation = result.then(() => undefined, () => undefined);
    return result;
}

async function saveScheduledMessages(messages: ScheduledMessage[]): Promise<void> {
    await DataStore.set(STORAGE_KEY, messages);
    scheduledMessages = messages;
}

export function getScheduledMessages(): ScheduledMessage[] {
    return [...scheduledMessages];
}

export function getChannelDisplayInfo(channelId: string): { name: string; avatar: string; } {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return { name: "Unknown", avatar: "" };

    if (channel.isDM()) {
        const user = channel.recipients?.[0] ? UserStore.getUser(channel.recipients[0]) : null;
        return user
            ? { name: user.globalName ?? user.username, avatar: IconUtils.getUserAvatarURL(user, true, 64) }
            : { name: "DM", avatar: "" };
    }

    if (channel.isGroupDM() || channel.isMultiUserDM()) {
        return { name: channel.name || "Group DM", avatar: IconUtils.getChannelIconURL(channel) ?? "" };
    }

    const guild = GuildStore.getGuild(channel.guild_id);
    return {
        name: channel.name || "Channel",
        avatar: guild ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: true, size: 512 }) ?? "" : ""
    };
}

function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number; }> {
    return new Promise(resolve => {
        const img = new Image();
        const timeout = setTimeout(() => finish(), 5000);
        function finish(dimensions = { width: 400, height: 300 }) {
            clearTimeout(timeout);
            img.onload = img.onerror = null;
            img.removeAttribute("src");
            resolve(dimensions);
        }
        img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => finish();
        img.src = dataUrl;
    });
}

function getVideoPreview(dataUrl: string): Promise<{ width: number; height: number; previewUrl: string; } | null> {
    return new Promise(resolve => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.muted = true;
        video.playsInline = true;

        const timeout = setTimeout(() => finish(), 5000);
        function finish(preview: { width: number; height: number; previewUrl: string; } | null = null) {
            clearTimeout(timeout);
            video.onloadeddata = video.onerror = null;
            video.removeAttribute("src");
            video.load();
            resolve(preview);
        }

        video.onerror = () => finish();
        video.onloadeddata = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext("2d");

                if (!ctx) { finish(); return; }

                ctx.drawImage(video, 0, 0);
                const size = Math.min(canvas.width, canvas.height) * 0.2;
                const cx = canvas.width / 2, cy = canvas.height / 2;

                ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
                ctx.beginPath();
                ctx.arc(cx, cy, size, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = "white";
                ctx.beginPath();
                ctx.moveTo(cx - size * 0.3, cy - size * 0.4);
                ctx.lineTo(cx - size * 0.3, cy + size * 0.4);
                ctx.lineTo(cx + size * 0.5, cy);
                ctx.closePath();
                ctx.fill();
                finish({ width: video.videoWidth, height: video.videoHeight, previewUrl: canvas.toDataURL("image/png") });
            } catch {
                finish();
            }
        };

        video.src = dataUrl;
    });
}

async function buildPhantomAttachments(attachments: ScheduledAttachment[], isCurrent: () => boolean) {
    const result: { id: string; filename: string; size: number; content_type: string; url?: string; proxy_url?: string; width?: number; height?: number; }[] = [];

    for (let idx = 0; idx < attachments.length; idx++) {
        if (!isCurrent()) break;
        const att = attachments[idx];
        const dataUrl = `data:${att.type};base64,${att.data}`;
        const attachment: typeof result[0] = {
            id: String(idx),
            filename: att.filename,
            size: Math.ceil(att.data.length * 0.75),
            content_type: att.type
        };

        if (att.type.startsWith("image/")) {
            const dims = await getImageDimensions(dataUrl);
            Object.assign(attachment, { url: dataUrl, proxy_url: dataUrl, ...dims });
        } else if (["video/mp4", "video/webm", "video/ogg"].includes(att.type)) {
            const preview = await getVideoPreview(dataUrl);
            if (preview) {
                Object.assign(attachment, {
                    content_type: "image/png",
                    url: preview.previewUrl,
                    proxy_url: preview.previewUrl,
                    width: preview.width,
                    height: preview.height,
                    filename: att.filename.replace(/\.[^.]+$/, "_preview.png")
                });
            }
        }

        result.push(attachment);
    }

    return result;
}

export async function createPhantomMessage(msg: ScheduledMessage): Promise<void> {
    if (!settings.store.showPhantomMessages) return;

    const currentUser = UserStore.getCurrentUser();
    if (!currentUser || msg.userId !== currentUser.id) return;

    const messageId = `scheduled-${msg.id}`;

    const phantom = { scheduledTime: msg.scheduledTime, messageId: msg.id, channelId: msg.channelId };
    phantomMessageMap.set(messageId, phantom);
    const isCurrent = () => phantomMessageMap.get(messageId) === phantom && UserStore.getCurrentUser()?.id === currentUser.id;

    const attachments = msg.attachments?.length ? await buildPhantomAttachments(msg.attachments, isCurrent) : [];
    if (!isCurrent()) return;

    const initialReactions = (msg.reactions ?? []).map(r => ({
        emoji: r.emoji,
        count: r.count,
        count_details: { burst: 0, normal: r.count },
        me: true,
        me_burst: false,
        burst_count: 0,
        burst_colors: [],
        burst_me: false
    }));

    const messagesLoaded = MessageStore.hasPresent(msg.channelId)
        ? Promise.resolve()
        : MessageActions.fetchMessages({ channelId: msg.channelId });

    return messagesLoaded.then(() => {
        if (!isCurrent()) return;
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: msg.channelId,
            message: {
                id: messageId,
                channel_id: msg.channelId,
                author: {
                    id: currentUser.id,
                    username: currentUser.username,
                    discriminator: currentUser.discriminator || "0",
                    avatar: currentUser.avatar,
                    global_name: currentUser.globalName ?? null,
                    bot: false
                },
                content: msg.content,
                timestamp: new Date().toISOString(),
                edited_timestamp: null,
                tts: false,
                mention_everyone: false,
                mentions: [],
                mention_roles: [],
                attachments,
                embeds: [],
                pinned: false,
                type: 0,
                flags: 0,
                components: [],
                reactions: initialReactions,
                nonce: messageId,
                scheduledMessageData: { scheduledTime: msg.scheduledTime, messageId: msg.id }
            },
            optimistic: true,
            sendMessageOptions: {},
            isPushNotification: false
        });

        applyPhantomClassToMessage(msg.channelId, messageId);
    }).catch(() => {
        if (isCurrent()) logger.warn("Could not create scheduled message preview.");
    });
}

function applyPhantomClassToMessage(channelId: string, messageId: string): void {
    const generation = phantomGeneration;
    const tryApply = (retries = 0) => {
        if (generation !== phantomGeneration) return false;

        const el = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        if (el) {
            el.classList.add("vc-scheduled-msg-phantom");
            return true;
        }
        if (retries < 20) {
            setTimeout(() => tryApply(retries + 1), 100 + retries * 50);
        }
        return false;
    };

    setTimeout(() => tryApply(), 50);
}

function removePhantomMessage(msg: ScheduledMessage): void {
    const messageId = `scheduled-${msg.id}`;
    phantomMessageMap.delete(messageId);
    FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: msg.channelId, id: messageId, mlDeleted: true });
}

function updatePhantomReactions(messageId: string, channelId: string): void {
    const existingTimeout = pendingRecreations.get(messageId);
    if (existingTimeout) {
        clearTimeout(existingTimeout);
    }

    const generation = phantomGeneration;
    const timeout = setTimeout(() => {
        pendingRecreations.delete(messageId);
        if (generation !== phantomGeneration) return;

        doRecreatePhantomMessage(messageId, channelId);
    }, RECREATE_DEBOUNCE_MS);

    pendingRecreations.set(messageId, timeout);
}

function doRecreatePhantomMessage(messageId: string, channelId: string): void {
    const generation = phantomGeneration;
    const phantomData = phantomMessageMap.get(messageId);
    if (!phantomData) {
        logger.warn("doRecreatePhantomMessage: No phantom data found");
        return;
    }

    const msg = scheduledMessages.find(m => m.id === phantomData.messageId);
    if (!msg) {
        logger.warn("doRecreatePhantomMessage: No scheduled message found");
        return;
    }

    FluxDispatcher.dispatch({
        type: "MESSAGE_DELETE",
        channelId,
        id: messageId,
        mlDeleted: true
    });

    setTimeout(() => {
        if (generation !== phantomGeneration) return;

        if (phantomMessageMap.get(messageId) !== phantomData) return;
        const current = scheduledMessages.find(entry => entry.id === phantomData.messageId);
        if (current) createPhantomMessage(current);
    }, 50);
}

async function uploadAttachment(channelId: string, att: ScheduledAttachment): Promise<{ id: string; filename: string; uploaded_filename: string; }> {
    return new Promise((resolve, reject) => {
        const bytes = Uint8Array.from(atob(att.data), c => c.charCodeAt(0));
        const file = new File([bytes], att.filename, { type: att.type });
        const upload = new CloudUploader({ file, platform: CloudUploadPlatform.WEB }, channelId);

        upload.on("complete", () => resolve({ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }));
        upload.on("error", () => reject(new Error("Could not upload scheduled attachment.")));
        upload.upload();
    });
}

async function postMessage(channelId: string, content: string, attachments?: { id: string; filename: string; uploaded_filename: string; }[]): Promise<string> {
    const response = await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: {
            content,
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            ...(attachments?.length ? { channel_id: channelId, sticker_ids: [], type: 0, attachments } : {})
        }
    });
    return response.body.id;
}

async function addReactionsToMessage(channelId: string, messageId: string, reactions: ScheduledReaction[]): Promise<void> {
    const generation = schedulerGeneration;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    for (const reaction of reactions) {
        const emojiStr = reaction.emoji.id
            ? `${reaction.emoji.name}:${reaction.emoji.id}`
            : encodeURIComponent(reaction.emoji.name);

        for (let attempt = 0; attempt < 5; attempt++) {
            if (generation !== schedulerGeneration || UserStore.getCurrentUser()?.id !== userId) return;
            try {
                await RestAPI.put({ url: `/channels/${channelId}/messages/${messageId}/reactions/${emojiStr}/@me` });
                break;
            } catch (e) {
                const err = e as { status?: number; body?: { retry_after?: number; }; };
                if (err.status === 429 || err.body?.retry_after) {
                    await new Promise(r => setTimeout(r, (err.body?.retry_after ?? 1) * 1000 + 100));
                } else if (err.status === 404) {
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                } else {
                    break;
                }
            }
        }
        await new Promise(r => setTimeout(r, 350));
    }
}

async function sendScheduledMessage(msg: ScheduledMessage): Promise<boolean> {
    const generation = schedulerGeneration;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return false;
    const isCurrent = () => generation === schedulerGeneration && UserStore.getCurrentUser()?.id === userId;
    try {
        if (!ChannelStore.getChannel(msg.channelId)) return false;

        const reactions = msg.reactions ?? [];
        removePhantomMessage(msg);

        let messageId: string;
        if (msg.attachments?.length) {
            const uploaded = await Promise.all(msg.attachments.map((att, i) =>
                uploadAttachment(msg.channelId, att).then(result => ({ ...result, id: String(i) }))
            ));

            if (!isCurrent()) return false;
            messageId = await postMessage(msg.channelId, msg.content, uploaded);
        } else {
            messageId = await postMessage(msg.channelId, msg.content);
        }

        if (!isCurrent()) return true;
        if (reactions.length) await addReactionsToMessage(msg.channelId, messageId, reactions);

        if (isCurrent() && settings.store.showNotifications) {
            showToast(`Scheduled message sent to ${getChannelDisplayInfo(msg.channelId).name}`, Toasts.Type.SUCCESS);
        }
        return true;
    } catch {
        if (isCurrent() && settings.store.showNotifications) showToast("Failed to send scheduled message", Toasts.Type.FAILURE);
        return false;
    }
}

export async function addScheduledMessage(
    channelId: string,
    content: string,
    scheduledTime: number,
    attachments?: ScheduledAttachment[]
): Promise<{ success: boolean; error?: string; }> {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return { success: false, error: "Sign in before scheduling a message." };
    if (Number.isNaN(new Date(scheduledTime).getTime()) || scheduledTime <= Date.now()) {
        return { success: false, error: "Please select a valid future date and time." };
    }
    const generation = schedulerGeneration;
    return runQueueOperation(async () => {
        const minuteStart = Math.floor(scheduledTime / 60000) * 60000;
        const count = scheduledMessages.filter(m =>
            m.userId === userId && m.channelId === channelId && m.scheduledTime >= minuteStart && m.scheduledTime < minuteStart + 60000
        ).length;
        if (count >= settings.store.maxMessagesPerMinute) {
            return { success: false, error: `Maximum of ${settings.store.maxMessagesPerMinute} messages per channel per minute reached` };
        }
        const newMessage: ScheduledMessage = {
            userId,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            channelId,
            content,
            scheduledTime,
            createdAt: Date.now(),
            attachments
        };
        await saveScheduledMessages([...scheduledMessages, newMessage].sort((a, b) => a.scheduledTime - b.scheduledTime));
        if (generation === schedulerGeneration && UserStore.getCurrentUser()?.id === userId) createPhantomMessage(newMessage);
        scheduleNextCheck();
        return { success: true };
    });
}

export async function sendScheduledMessageNow(id: string): Promise<{ success: boolean; error?: string; }> {
    let message = scheduledMessages.find(entry => entry.id === id);
    if (!message) {
        return { success: false, error: "Scheduled message not found" };
    }

    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return { success: false, error: "Sign in before sending a scheduled message." };
    if (!message.userId) return { success: false, error: "This older message has no saved account. Recreate it before sending." };
    if (message.userId !== userId) return { success: false, error: "Switch to the account that scheduled this message." };
    if (sendingMessages.has(id)) return { success: false, error: "Message is being sent." };
    sendingMessages.add(id);
    const generation = schedulerGeneration;
    try {
        await runQueueOperation(() => saveScheduledMessages(scheduledMessages.map(entry => entry.id === id ? { ...entry, attemptedAt: Date.now() } : entry)));
        message = scheduledMessages.find(entry => entry.id === id);
        if (generation !== schedulerGeneration) return { success: false, error: "Scheduled sending was stopped. The message remains saved." };
        if (UserStore.getCurrentUser()?.id !== userId) return { success: false, error: "Account changed. The scheduled message remains saved." };
        if (!message) return { success: false, error: "Scheduled message was removed." };
        const sent = await sendScheduledMessage(message);
        if (!sent) return { success: false, error: "Failed to send scheduled message. It remains saved." };
        await removeScheduledMessage(id);
        return { success: true };
    } catch {
        return { success: false, error: "Could not update the scheduled message. Check the channel before retrying." };
    } finally {
        sendingMessages.delete(id);
        scheduleNextCheck();
    }
}

export async function removeScheduledMessage(id: string): Promise<void> {
    await runQueueOperation(async () => {
        const msg = scheduledMessages.find(m => m.id === id);
        await saveScheduledMessages(scheduledMessages.filter(m => m.id !== id));
        if (msg) removePhantomMessage(msg);
    });
    scheduleNextCheck();
}

export async function clearAllScheduledMessages(): Promise<void> {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    await runQueueOperation(async () => {
        const removed = scheduledMessages.filter(msg => !msg.userId || msg.userId === userId);
        await saveScheduledMessages(scheduledMessages.filter(msg => !removed.includes(msg)));
        for (const msg of removed) removePhantomMessage(msg);
    });
    scheduleNextCheck();
}

async function checkAndSendMessages(): Promise<void> {
    if (isProcessingMessages) return;
    isProcessingMessages = true;
    const generation = schedulerGeneration;

    try {
        const now = Date.now();
        const dueMessages = scheduledMessages.filter(m => m.attemptedAt === undefined && m.scheduledTime <= now);

        for (const msg of dueMessages) {
            if (generation !== schedulerGeneration) return;
            if (msg.attemptedAt === undefined) await sendScheduledMessageNow(msg.id);
        }
    } finally {
        isProcessingMessages = false;
        scheduleNextCheck();
    }
}

export function startScheduler(): void {
    if (schedulerRunning) return;
    schedulerRunning = true;
    void checkAndSendMessages();
}

export function stopScheduler(): void {
    schedulerGeneration++;
    schedulerRunning = false;
    if (checkTimeout) {
        clearTimeout(checkTimeout);
        checkTimeout = null;
    }
}

export function scheduleNextCheck(): void {
    if (!schedulerRunning || isProcessingMessages) return;

    if (checkTimeout) {
        clearTimeout(checkTimeout);
        checkTimeout = null;
    }

    const nextMessage = scheduledMessages.find(message => message.attemptedAt === undefined);
    if (!nextMessage) return;

    const maxDelay = Math.max(1000, settings.store.checkIntervalSeconds * 1000);
    const remaining = nextMessage.scheduledTime - Date.now();
    const delay = remaining <= 0 ? maxDelay : Math.min(maxDelay, remaining);

    checkTimeout = setTimeout(() => {
        checkTimeout = null;
        void checkAndSendMessages();
    }, delay);
}

export async function recreatePhantomMessages(): Promise<void> {
    const generation = phantomGeneration;
    const userId = UserStore.getCurrentUser()?.id;
    for (const msg of scheduledMessages) {
        if (generation !== phantomGeneration || UserStore.getCurrentUser()?.id !== userId) return;
        if (scheduledMessages.includes(msg)) await createPhantomMessage(msg);
    }
}

export function cleanupAllPhantomMessages(): void {
    phantomGeneration++;

    for (const timeout of pendingRecreations.values()) {
        clearTimeout(timeout);
    }
    pendingRecreations.clear();

    for (const msg of scheduledMessages) removePhantomMessage(msg);

    phantomMessageMap.clear();
    recentReactionChanges.clear();
}

function pruneRecentReactionChanges(now = Date.now()): void {
    for (const [key, recent] of recentReactionChanges) {
        if (now - recent.timestamp > REACTION_COOLDOWN_MS) {
            recentReactionChanges.delete(key);
        }
    }
}

function modifyReaction(messageId: string, channelId: string, emoji: { id: string | null; name: string; animated?: boolean; }, delta: number): void {
    const phantomData = phantomMessageMap.get(messageId);
    if (!phantomData) {
        logger.warn("modifyReaction: No phantom data found for messageId =", messageId);
        return;
    }

    void runQueueOperation(async () => {
        if (phantomMessageMap.get(messageId) !== phantomData) return;
        const msg = scheduledMessages.find(m => m.id === phantomData.messageId);
        if (!msg) return;
        const reactions = (msg.reactions ?? []).map(reaction => ({ ...reaction }));
        const idx = reactions.findIndex(r => r.emoji.name === emoji.name && r.emoji.id === emoji.id);
        if (delta > 0) {
            if (idx >= 0) reactions[idx].count += delta;
            else reactions.push({ emoji: { id: emoji.id ?? null, name: emoji.name, animated: emoji.animated }, count: 1 });
        } else if (idx >= 0) {
            reactions[idx].count += delta;
            if (reactions[idx].count <= 0) reactions.splice(idx, 1);
        }
        await saveScheduledMessages(scheduledMessages.map(entry => entry === msg ? { ...entry, reactions } : entry));
        if (phantomMessageMap.get(messageId) !== phantomData) return;
        updatePhantomReactions(messageId, channelId);
    }).catch(() => logger.warn("Could not save scheduled message reactions."));
}

function getReactionKey(messageId: string, emoji: { id: string | null; name: string; }): string {
    return `${messageId}:${emoji.name}:${emoji.id ?? ""}`;
}

export function handleReactionAdd(messageId: string, channelId: string, emoji: { id: string | null; name: string; animated?: boolean; }): void {
    const key = getReactionKey(messageId, emoji);
    const now = Date.now();
    pruneRecentReactionChanges(now);

    const recent = recentReactionChanges.get(key);

    if (recent && recent.action === "add" && now - recent.timestamp < REACTION_COOLDOWN_MS) {
        return;
    }

    if (recent && recent.action === "remove" && now - recent.timestamp < REACTION_COOLDOWN_MS) {
        resyncPhantomReactions(messageId, channelId);
        return;
    }

    recentReactionChanges.set(key, { action: "add", timestamp: now });
    modifyReaction(messageId, channelId, emoji, 1);
}

export function handleReactionRemove(messageId: string, channelId: string, emoji: { id: string | null; name: string; }): void {
    const key = getReactionKey(messageId, emoji);
    const now = Date.now();
    pruneRecentReactionChanges(now);

    const recent = recentReactionChanges.get(key);

    if (recent && recent.action === "remove" && now - recent.timestamp < REACTION_COOLDOWN_MS) {
        return;
    }

    if (recent && recent.action === "add" && now - recent.timestamp < REACTION_COOLDOWN_MS) {
        resyncPhantomReactions(messageId, channelId);
        return;
    }

    recentReactionChanges.set(key, { action: "remove", timestamp: now });
    modifyReaction(messageId, channelId, emoji, -1);
}

export function isPhantomMessage(messageId: string): boolean {
    return phantomMessageMap.has(messageId);
}

export function resyncPhantomReactions(messageId: string, channelId: string): void {
    const phantomData = phantomMessageMap.get(messageId);
    if (!phantomData) {
        logger.warn("resyncPhantomReactions: No phantom data for messageId =", messageId);
        return;
    }

    updatePhantomReactions(messageId, channelId);
}
