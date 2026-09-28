/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import {
    addMessagePreEditListener,
    addMessagePreSendListener,
    MessageEditListener,
    MessageSendListener,
    removeMessagePreEditListener,
    removeMessagePreSendListener,
} from "@api/MessageEvents";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { PluginNative } from "@utils/types";
import type { Channel, CloudUpload, Message, RenderModalProps } from "@vencord/discord-types";
import {
    ChannelStore,
    Checkbox,
    CloudUploader,
    Constants,
    MessageStore,
    Modal,
    openModal,
    Parser,
    RestAPI,
    showToast,
    StickersStore,
    Toasts,
    useCallback,
    useEffect,
    UserStore,
    useState,
} from "@webpack/common";

import {
    clearEncryptedAttachmentCache,
    encryptedAttachmentStatus,
    patchEncryptedMessageAttachments,
    subscribeEncryptedAttachmentStatus,
} from "./attachmentCache";
import {
    MAX_STICKER_COUNT,
    type SecureStickerItem,
    serializeSecurePlaintext,
} from "./attachments";
import { prepareEncryptedAttachments } from "./attachmentUploads";
import { availableSelectedRecipientIds } from "./conversationSelection";
import {
    clearEncryptedEmbedCache,
    patchEncryptedMessageEmbeds,
    patchEncryptedMessageStickers,
    prefetchEncryptedMessageEmbeds,
} from "./embedCache";
import { KeyReviewGate } from "./keyReviewGate";
import { discordEditedTimestamp } from "./messageMetadata";
import type {
    AnnouncementReviewResult,
    ChannelProtectionResult,
    ConversationResult,
    ConversationSnapshot,
    DecryptIncomingResult,
    IdentityResult,
    IdentitySummary,
    NativeFailure,
} from "./native";
import { isEncryptedMessage, isKeyAnnouncement } from "./protocol";
import {
    authorizeAttachmentUploadReservations,
    authorizeWirePayload,
    clearWirePayloadAuthorizations,
    consumeAttachmentUploadReservations,
    consumeWirePayloadAuthorization,
} from "./wireAuthorizations";

const Native = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("./native")>;
const SECURE_LISTENER_PRIORITY = 1_000_000;

type ScreenCaptureProtectionStatus = "disabled" | "failed" | "pending" | "ready" | "screenshot";

interface ReplyPreviewProps {
    referencedMessage?: {
        message?: Message;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface ReplyPreviewState {
    key: string;
    result: DecryptIncomingResult | null;
}

let screenCaptureProtectionStatus: ScreenCaptureProtectionStatus = "disabled";
let screenCaptureProtectionGeneration = 0;
let secureMessageListenersInstalled = false;
const screenCaptureProtectionListeners = new Set<(status: ScreenCaptureProtectionStatus) => void>();
const pendingEncryptedRenderOwners = new Set<{ forceUpdate(): void; }>();

function setScreenCaptureProtectionStatus(status: ScreenCaptureProtectionStatus): void {
    screenCaptureProtectionStatus = status;
    for (const listener of screenCaptureProtectionListeners) {
        try {
            listener(status);
        } catch {
            // A stale React subscriber must not prevent the protection state transition.
        }
    }
    if (status === "ready") {
        for (const owner of pendingEncryptedRenderOwners) {
            try {
                owner.forceUpdate();
            } catch {
                // Discord may have already disposed a message renderer while IPC was pending.
            }
        }
    }
    if (status !== "pending") pendingEncryptedRenderOwners.clear();
}

function useScreenCaptureProtectionStatus(): ScreenCaptureProtectionStatus {
    const [status, setStatus] = useState(screenCaptureProtectionStatus);
    useEffect(() => {
        screenCaptureProtectionListeners.add(setStatus);
        return () => { screenCaptureProtectionListeners.delete(setStatus); };
    }, []);
    return status;
}

async function applyScreenCaptureProtection(enabled: boolean): Promise<boolean> {
    try {
        const result = await Native.setScreenCaptureProtection(enabled);
        if (result.status === "applied") return true;
    } catch {
        // The same visible failure is used for rejected IPC and structured native failures.
    }
    if (enabled)
        showToast("Secure Messaging could not apply screen capture protection.", Toasts.Type.FAILURE);
    else
        showToast("Secure Messaging could not release screen capture protection.", Toasts.Type.FAILURE);
    return false;
}

async function setScreenshotMode(enabled: boolean): Promise<boolean> {
    if (enabled ? screenCaptureProtectionStatus !== "ready" :
        screenCaptureProtectionStatus !== "screenshot" && screenCaptureProtectionStatus !== "failed") return false;
    const generation = ++screenCaptureProtectionGeneration;
    setScreenCaptureProtectionStatus(enabled ? "screenshot" : "pending");
    clearEncryptedAttachmentCache();
    clearEncryptedEmbedCache();
    MessageStore.emitChange();
    const applied = await applyScreenCaptureProtection(!enabled);
    if (generation !== screenCaptureProtectionGeneration) return false;
    setScreenCaptureProtectionStatus(applied ? enabled ? "screenshot" : "ready" : enabled ? "ready" : "failed");
    MessageStore.emitChange();
    return applied;
}

function replyPreviewKey(localUserId: string, message: Message): string {
    return [
        localUserId,
        message.channel_id,
        message.id,
        message.author?.id ?? "",
        discordEditedTimestamp(message) ?? "",
        message.content,
    ].join("\0");
}

function replyPreviewText(result: DecryptIncomingResult | null): string {
    if (!result) return "Authenticating encrypted reply…";
    if (result.status !== "decrypted") return "Encrypted message blocked";
    if (result.plaintext) return result.plaintext;
    const attachmentCount = result.attachmentBundle?.count ?? 0;
    if (attachmentCount === 1) return "Encrypted attachment";
    if (attachmentCount > 1) return `${attachmentCount} encrypted attachments`;
    const stickers = result.stickers ?? [];
    if (stickers.length === 1) return `Sticker: ${stickers[0].name}`;
    if (stickers.length > 1) return `${stickers.length} stickers`;
    return "Encrypted message";
}

function replyPreviewMessage(message: Message, content: string): Message {
    return message
        .set("content", content)
        .set("attachments", [])
        .set("embeds", [])
        .set("customRenderedContent", null);
}

function useSecureReplyPreview<T extends ReplyPreviewProps>(props: T): T {
    const message = props?.referencedMessage?.message;
    const localUserId = UserStore.getCurrentUser()?.id;
    const captureProtection = useScreenCaptureProtectionStatus();
    const key = message && localUserId && message.author?.id && isEncryptedMessage(message.content)
        ? replyPreviewKey(localUserId, message)
        : null;
    const [state, setState] = useState<ReplyPreviewState | null>(null);

    useEffect(() => {
        let active = true;
        setState(null);
        if (captureProtection !== "ready" || !key || !localUserId || !message?.author?.id)
            return () => { active = false; };
        void Native.decryptIncoming(localUserId, {
            channelId: message.channel_id,
            content: message.content,
            discordAuthorId: message.author.id,
            discordEditedTimestamp: discordEditedTimestamp(message),
            discordMessageId: message.id,
        }).then(result => {
            if (active) setState({ key, result });
        }).catch(() => {
            if (active) setState({ key, result: { status: "failed", error: "cryptographic_operation_failed" } });
        });
        return () => { active = false; };
    }, [captureProtection, key, localUserId]);

    if (!message || !isEncryptedMessage(message.content)) return props;

    let content: string;
    if (captureProtection !== "ready") {
        content = captureProtection === "screenshot"
            ? "Encrypted reply hidden while screenshots are allowed"
            : "Encrypted reply protected";
    } else if (!key) content = "Encrypted message blocked";
    else content = replyPreviewText(state?.key === key ? state.result : null);

    return {
        ...props,
        referencedMessage: {
            ...props.referencedMessage,
            message: replyPreviewMessage(message, content),
        },
    };
}

const permittedAnnouncements = new Map<string, number>();
let keyReviewGate = new KeyReviewGate();
type RestMethod = (request: Record<string, any>, ...args: any[]) => Promise<any>;
let networkGuardEnabled = false;
let originalRestPost: RestMethod | null = null;
let originalRestPatch: RestMethod | null = null;
let guardedRestPost: RestMethod | null = null;
let guardedRestPatch: RestMethod | null = null;
let originalAttachmentUpload: CloudUpload["upload"] | null = null;
let guardedAttachmentUpload: CloudUpload["upload"] | null = null;
let approvedAttachmentUploads = new WeakSet<CloudUpload>();

function announcementKey(channelId: string, content: string): string {
    return `${channelId}\0${content}`;
}

function permitAnnouncement(channelId: string, content: string): void {
    const key = announcementKey(channelId, content);
    permittedAnnouncements.set(key, (permittedAnnouncements.get(key) ?? 0) + 1);
}

function revokeAnnouncement(channelId: string, content: string): void {
    const key = announcementKey(channelId, content);
    const remaining = (permittedAnnouncements.get(key) ?? 0) - 1;
    if (remaining > 0) permittedAnnouncements.set(key, remaining);
    else permittedAnnouncements.delete(key);
}

function takePermittedAnnouncement(channelId: string, content: string): boolean {
    const key = announcementKey(channelId, content);
    if (!permittedAnnouncements.has(key)) return false;
    revokeAnnouncement(channelId, content);
    return true;
}

function hasSelectedKeyReviewBlock(localUserId: string, conversation: ConversationResult): boolean {
    if (!conversationHasDetails(conversation)) return false;
    return conversation.selectedRecipientIds.some(userId => keyReviewGate.isBlocked(localUserId, userId));
}

function reviewKeyAnnouncementInBackground(message: Message | undefined): void {
    const localUserId = UserStore.getCurrentUser()?.id;
    const peerUserId = message?.author?.id;
    if (!localUserId || !peerUserId || peerUserId === localUserId || !isKeyAnnouncement(message.content)) return;
    const messageGuildId = (message as Message & { guild_id?: string; }).guild_id;
    if (messageGuildId || ChannelStore.getChannel(message.channel_id)?.guild_id) return;
    const editedTimestamp = discordEditedTimestamp(message);
    const attemptId = `${message.channel_id}\0${message.id}\0${editedTimestamp ?? ""}\0${message.content}`;

    const gate = keyReviewGate;
    gate.begin(localUserId, peerUserId);
    void Native.reviewAnnouncement(
        localUserId,
        peerUserId,
        message.content,
        message.id,
        editedTimestamp,
    )
        .then(result => {
            if (isNativeFailure(result)) gate.fail(localUserId, peerUserId, attemptId);
            else gate.succeed(localUserId, peerUserId, attemptId);
        })
        .catch(() => gate.fail(localUserId, peerUserId, attemptId))
        .finally(() => gate.finish(localUserId, peerUserId));
}

function messageFromDispatch(event: Record<string, any>): Message | undefined {
    const dispatched = event.message as Message | undefined;
    if (dispatched?.content && dispatched.author?.id) return dispatched;
    const channelId = dispatched?.channel_id ?? event.channelId;
    const messageId = dispatched?.id ?? event.id;
    return typeof channelId === "string" && typeof messageId === "string"
        ? MessageStore.getMessage(channelId, messageId)
        : undefined;
}

function handleKeyAnnouncementDispatch(event: Record<string, any>): void {
    reviewKeyAnnouncementInBackground(messageFromDispatch(event));
}

function handleLoadedKeyAnnouncements(event: Record<string, any>): void {
    if (!Array.isArray(event.messages)) return;
    for (const message of event.messages) reviewKeyAnnouncementInBackground(message as Message);
}

function isNativeFailure(result: { status: string; }): result is NativeFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

function failureMessage(failure: NativeFailure): string {
    if (failure.status === "invalid_input") return failure.error;
    if (failure.status === "unavailable") {
        if (failure.reason === "encryption_unavailable") return "Your operating system's secure key storage is unavailable.";
        if (failure.reason === "unsafe_linux_backend") return "Secure Messaging refuses Linux's unencrypted basic_text key-storage backend.";
        if (failure.reason === "vault_unreadable") return "The encrypted Secure Messaging vault could not be read. It was not reset.";
        return "Secure key storage is unavailable.";
    }
    if (failure.error === "attachment_download_failed") return "The encrypted attachment could not be downloaded from Discord.";
    if (failure.error === "attachment_too_large") return "The encrypted attachment exceeds Secure Messaging's safety limit.";
    if (failure.error === "message_too_long") return "The encrypted envelope would exceed Discord's 2,000 character limit. Shorten the message or select fewer recipients.";
    if (failure.error === "counter_exhausted") return "This identity's message counter is exhausted. Rotate the identity before sending again.";
    if (failure.error === "capacity_exceeded") return "The encrypted vault reached a safety limit.";
    if (failure.error === "cryptographic_operation_failed") return "The cryptographic operation failed.";
    if (failure.error === "screen_capture_protection_failed") return "Operating-system screen-capture protection is unavailable, so encrypted content remains hidden.";
    return "The encrypted vault could not be saved.";
}

function showFailure(failure: NativeFailure): void {
    showToast(failureMessage(failure), Toasts.Type.FAILURE);
}

function userLabel(userId: string): string {
    const user = UserStore.getUser(userId);
    return user?.globalName || user?.username || userId;
}

function snapshotForChannel(channel: Channel | undefined, localUserId: string): ConversationSnapshot | null {
    if (!channel) return null;
    const isGroup = Boolean(channel.isGroupDM?.() || channel.isMultiUserDM?.());
    if (!isGroup && !channel.isDM?.()) return null;

    const participantUserIds = [...new Set((channel.recipients ?? [])
        .filter((value): value is string => typeof value === "string" && value !== localUserId))]
        .sort((left, right) => left.localeCompare(right));
    if (participantUserIds.length === 0 || (!isGroup && participantUserIds.length !== 1)) return null;

    return {
        channelId: channel.id,
        kind: isGroup ? "GROUP_DM" : "DM",
        participantUserIds,
    };
}

function currentSnapshot(channel: Channel | undefined): { localUserId: string; snapshot: ConversationSnapshot; } | null {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId) return null;
    const snapshot = snapshotForChannel(channel, localUserId);
    return snapshot ? { localUserId, snapshot } : null;
}

function conversationHasDetails(result: ConversationResult): result is Exclude<ConversationResult, NativeFailure> {
    return !isNativeFailure(result);
}

function requiresFailClosedSend(result: ConversationResult): boolean {
    return isNativeFailure(result) || (result.status !== "unconfigured" && result.status !== "disabled");
}

function conversationStatusMessage(result: ConversationResult): string {
    if (isNativeFailure(result)) return failureMessage(result);
    if (result.status === "enabled") return "Encryption is enabled for the selected recipients.";
    if (result.status === "participant_changed") return "Discord group membership changed. Review recipients and enable encryption again.";
    if (result.status === "unverified_recipients") return "A selected recipient key is missing or changed. Re-verify it before sending.";
    if (result.status === "disabled") return "Encryption is disabled for this conversation.";
    return "This conversation has not been configured.";
}

function selectedOutgoingStickerIds(options: Record<string, any>, props: Record<string, any>): string[] | null {
    const ids: string[] = [];
    for (const source of [options.stickerIds, options.stickers]) {
        if (source == null) continue;
        if (!Array.isArray(source) || source.some(value => typeof value !== "string" || !/^\d{17,20}$/u.test(value))) return null;
        for (const id of source) if (!ids.includes(id)) ids.push(id);
    }
    if ((props.hasStickers && ids.length === 0) || ids.length > MAX_STICKER_COUNT) return null;
    return ids;
}

function secureStickerItem(value: unknown, expectedId: string): SecureStickerItem | null {
    if (!value || typeof value !== "object") return null;
    const sticker = value as Record<string, unknown>;
    const formatType = sticker.format_type ?? sticker.formatType;
    if (sticker.id !== expectedId || typeof sticker.name !== "string" || sticker.name.length < 1 ||
        sticker.name.length > 100 || sticker.name.includes("\0") ||
        typeof formatType !== "number" || !Number.isInteger(formatType) || formatType < 1 || formatType > 4) return null;
    return { formatType, id: expectedId, name: sticker.name };
}

async function resolveSelectedStickers(ids: string[]): Promise<SecureStickerItem[]> {
    return Promise.all(ids.map(async id => {
        const cached = secureStickerItem(StickersStore.getStickerById(id), id);
        if (cached) return cached;
        const response = await RestAPI.get({ url: Constants.Endpoints.STICKER(id) });
        const fetched = secureStickerItem(response?.body, id);
        if (!fetched) throw new Error("Discord returned an invalid sticker item");
        return fetched;
    }));
}

function clearOutgoingStickers(options: Record<string, any>): void {
    if (Array.isArray(options.stickerIds)) options.stickerIds.length = 0;
    if (Array.isArray(options.stickers)) options.stickers.length = 0;
}

function blockedOutgoingReason(
    messageContent: string,
    options: Record<string, any>,
    props: Record<string, any>,
    stickerIds: string[] | null,
): string | null {
    if (props.hasAttachments && (!Array.isArray(options.uploads) || options.uploads.length === 0))
        return "Secure Messaging could not access the pending attachments before Discord uploaded them.";
    if (stickerIds === null) return "Secure Messaging could not resolve the selected stickers safely.";
    if (options.alsoForwardToChannelId) return "Forwarded messages are not encrypted by Secure Messaging v1.";
    if (options.command != null) return "Discord commands cannot be sent through an encrypted conversation.";
    if (!messageContent && (!Array.isArray(options.uploads) || options.uploads.length === 0) && stickerIds.length === 0)
        return "Enter text, choose a GIF or sticker, or attach a file to send an encrypted message.";
    return null;
}

function reservationFiles(body: unknown): Array<{ filename: string; size: number; }> | null {
    if (!body || typeof body !== "object") return null;
    const { files } = (body as Record<string, unknown>);
    if (!Array.isArray(files) || files.length === 0) return null;
    const result: Array<{ filename: string; size: number; }> = [];
    for (const file of files) {
        if (!file || typeof file !== "object") return null;
        const value = file as Record<string, unknown>;
        if (typeof value.filename !== "string" || !Number.isSafeInteger(value.file_size) || (value.file_size as number) < 1)
            return null;
        result.push({ filename: value.filename, size: value.file_size as number });
    }
    return result;
}

function messageAttachmentFilenames(body: Record<string, any>): string[] | null {
    if (body.attachments == null) return [];
    if (!Array.isArray(body.attachments)) return null;
    const filenames: string[] = [];
    for (const attachment of body.attachments) {
        if (!attachment || typeof attachment !== "object" || typeof attachment.filename !== "string") return null;
        filenames.push(attachment.filename);
    }
    return filenames;
}

function messageEndpoint(url: unknown, edit: boolean): { channelId: string; } | null {
    if (typeof url !== "string" || url.length > 500) return null;
    let pathname: string;
    try {
        pathname = new URL(url, "https://discord.invalid").pathname;
    } catch {
        return null;
    }
    const pattern = edit
        ? /^\/channels\/(\d{17,20})\/messages\/\d{17,20}$/u
        : /^\/channels\/(\d{17,20})\/messages$/u;
    const match = pattern.exec(pathname);
    return match ? { channelId: match[1] } : null;
}

function attachmentReservationEndpoint(url: unknown): { channelId: string; } | null {
    if (typeof url !== "string" || url.length > 500) return null;
    let pathname: string;
    try {
        pathname = new URL(url, "https://discord.invalid").pathname;
    } catch {
        return null;
    }
    const match = /^\/channels\/(\d{17,20})\/attachments$/u.exec(pathname);
    return match ? { channelId: match[1] } : null;
}

type ConversationProtection =
    | { kind: "unprotected"; }
    | { kind: "persisted_protected"; }
    | {
        kind: "snapshot";
        context: { localUserId: string; snapshot: ConversationSnapshot; };
        conversation: ConversationResult;
    };

async function resolveConversationProtection(channelId: string): Promise<ConversationProtection> {
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId) throw new Error("Secure Messaging could not identify the authenticated account");

    const channel = ChannelStore.getChannel(channelId);
    const snapshot = snapshotForChannel(channel, localUserId);
    if (snapshot) {
        const context = { localUserId, snapshot };
        return { kind: "snapshot", context, conversation: await Native.getConversation(localUserId, snapshot) };
    }

    const loadedNonPrivateChannel = typeof channel?.guild_id === "string" && /^\d{17,20}$/u.test(channel.guild_id);
    if (loadedNonPrivateChannel) return { kind: "unprotected" };

    const persisted: ChannelProtectionResult = await Native.getChannelProtection(localUserId, channelId);
    if (isNativeFailure(persisted)) throw new Error(`Secure Messaging could not establish channel protection: ${failureMessage(persisted)}`);
    return persisted.status === "protected" ? { kind: "persisted_protected" } : { kind: "unprotected" };
}

function installAttachmentUploadGuard(): void {
    if (guardedAttachmentUpload) return;
    const original = CloudUploader.prototype.upload;
    originalAttachmentUpload = original;
    guardedAttachmentUpload = async function (this: CloudUpload) {
        if (approvedAttachmentUploads.has(this)) return original.call(this);
        let protection: ConversationProtection;
        try {
            protection = await resolveConversationProtection(this.channelId);
        } catch {
            return;
        }
        if (protection.kind === "unprotected" ||
            (protection.kind === "snapshot" && !requiresFailClosedSend(protection.conversation)))
            return original.call(this);
    };
    CloudUploader.prototype.upload = guardedAttachmentUpload;
}

function uninstallAttachmentUploadGuard(): void {
    if (guardedAttachmentUpload && CloudUploader.prototype.upload === guardedAttachmentUpload && originalAttachmentUpload)
        CloudUploader.prototype.upload = originalAttachmentUpload;
    originalAttachmentUpload = null;
    guardedAttachmentUpload = null;
    approvedAttachmentUploads = new WeakSet();
}

async function protectProgrammaticPost(request: Record<string, any>): Promise<Record<string, any>> {
    const message = messageEndpoint(request?.url, false);
    const attachment = attachmentReservationEndpoint(request?.url);
    const endpoint = message ?? attachment;
    if (!endpoint) return request;
    const protection = await resolveConversationProtection(endpoint.channelId);
    if (protection.kind === "unprotected") return request;
    if (screenCaptureProtectionStatus !== "ready")
        throw new Error("Secure Messaging blocked a protected send because screen-capture protection is unavailable");
    if (attachment) {
        if (protection.kind === "persisted_protected" || requiresFailClosedSend(protection.conversation)) {
            const files = reservationFiles(request.body);
            if (!files || !consumeAttachmentUploadReservations(endpoint.channelId, files))
                throw new Error("Secure Messaging blocked an unauthorized attachment upload reservation in a protected conversation");
        }
        return request;
    }
    if (protection.kind === "persisted_protected")
        throw new Error("Secure Messaging blocked a send because the protected conversation snapshot is unavailable");
    if (!request.body || typeof request.body !== "object")
        throw new Error("Secure Messaging blocked a non-text programmatic send in a protected conversation");
    const body = request.body as Record<string, any>;
    const content = typeof body.content === "string" ? body.content : "";
    const { context, conversation } = protection;
    if (!requiresFailClosedSend(conversation)) return request;
    if (hasSelectedKeyReviewBlock(context.localUserId, conversation))
        throw new Error("Secure Messaging blocked a send while a selected recipient key announcement is being verified");
    const attachmentFilenames = messageAttachmentFilenames(body);
    if (!content || attachmentFilenames === null || (Array.isArray(body.sticker_ids) && body.sticker_ids.length > 0) || body.poll != null)
        throw new Error("Secure Messaging blocked a malformed or unsupported programmatic send in a protected conversation");
    if (isEncryptedMessage(content) || isKeyAnnouncement(content)) {
        if (consumeWirePayloadAuthorization(endpoint.channelId, content, attachmentFilenames)) return request;
        throw new Error("Secure Messaging blocked an unauthorized prefixed programmatic payload");
    }
    if (attachmentFilenames.length > 0)
        throw new Error("Secure Messaging blocked an unencrypted programmatic attachment send in a protected conversation");
    if (isNativeFailure(conversation)) throw new Error(`Secure Messaging blocked a programmatic send: ${failureMessage(conversation)}`);
    if (conversation.status !== "enabled") throw new Error(`Secure Messaging blocked a programmatic send: ${conversationStatusMessage(conversation)}`);

    const encrypted = await Native.encryptOutgoing(context.localUserId, { plaintext: content, snapshot: context.snapshot });
    if (encrypted.status !== "encrypted") {
        const reason = isNativeFailure(encrypted)
            ? failureMessage(encrypted)
            : conversationStatusMessage(encrypted.conversation);
        throw new Error(`Secure Messaging blocked a programmatic send: ${reason}`);
    }
    return { ...request, body: { ...body, content: encrypted.content } };
}

async function assertProgrammaticEditAllowed(request: Record<string, any>): Promise<void> {
    const endpoint = messageEndpoint(request?.url, true);
    if (!endpoint) return;
    const protection = await resolveConversationProtection(endpoint.channelId);
    if (protection.kind === "persisted_protected" ||
        (protection.kind === "snapshot" && requiresFailClosedSend(protection.conversation)))
        throw new Error("Secure Messaging blocked a programmatic edit in a protected conversation");
}

function installNetworkGuard(): void {
    const rest = RestAPI as unknown as Record<string, any>;
    const { post } = rest;
    const { patch } = rest;
    if (typeof post !== "function" || typeof patch !== "function")
        throw new Error("Discord REST message methods are unavailable");

    networkGuardEnabled = true;
    originalRestPost = post;
    originalRestPatch = patch;
    guardedRestPost = async (request, ...args) => {
        const guardedRequest = networkGuardEnabled ? await protectProgrammaticPost(request) : request;
        return post.call(rest, guardedRequest, ...args);
    };
    guardedRestPatch = async (request, ...args) => {
        if (networkGuardEnabled) await assertProgrammaticEditAllowed(request);
        return patch.call(rest, request, ...args);
    };
    rest.post = guardedRestPost;
    rest.patch = guardedRestPatch;
}

function uninstallNetworkGuard(): void {
    networkGuardEnabled = false;
    const rest = RestAPI as unknown as Record<string, any>;
    if (guardedRestPost && rest.post === guardedRestPost && originalRestPost) rest.post = originalRestPost;
    if (guardedRestPatch && rest.patch === guardedRestPatch && originalRestPatch) rest.patch = originalRestPatch;
    originalRestPost = null;
    originalRestPatch = null;
    guardedRestPost = null;
    guardedRestPatch = null;
}

const outgoingListener: MessageSendListener = async (channelId, message, options, props) => {
    try {
        const context = currentSnapshot(props.channel);
        if (!context || context.snapshot.channelId !== channelId) return;

        if (takePermittedAnnouncement(channelId, message.content)) return { stop: true };

        const conversation = await Native.getConversation(context.localUserId, context.snapshot);
        if (!requiresFailClosedSend(conversation)) return;

        if (isNativeFailure(conversation)) {
            showFailure(conversation);
            return { cancel: true };
        }
        if (conversation.status !== "enabled") {
            showToast(conversationStatusMessage(conversation), Toasts.Type.FAILURE);
            return { cancel: true };
        }
        if (hasSelectedKeyReviewBlock(context.localUserId, conversation)) {
            showToast("Secure Messaging is verifying a selected recipient key. The send was blocked.", Toasts.Type.FAILURE);
            return { cancel: true };
        }

        const stickerIds = selectedOutgoingStickerIds(options, props);
        const blockedReason = blockedOutgoingReason(message.content, options, props, stickerIds);
        if (blockedReason) {
            showToast(blockedReason, Toasts.Type.FAILURE);
            return { cancel: true };
        }

        const stickers = await resolveSelectedStickers(stickerIds ?? []);
        const uploads = Array.isArray(options.uploads) ? options.uploads : [];
        const preparedAttachments = uploads.length > 0
            ? await prepareEncryptedAttachments(uploads, message.content, channelId, context.localUserId, stickers)
            : null;
        const encrypted = await Native.encryptOutgoing(context.localUserId, {
            plaintext: preparedAttachments?.plaintext ?? serializeSecurePlaintext(message.content, null, stickers),
            snapshot: context.snapshot,
        });
        if (encrypted.status !== "encrypted") {
            if (isNativeFailure(encrypted)) showFailure(encrypted);
            else showToast(conversationStatusMessage(encrypted.conversation), Toasts.Type.FAILURE);
            return { cancel: true };
        }

        void prefetchEncryptedMessageEmbeds(message.content);
        preparedAttachments?.apply();
        clearOutgoingStickers(options);
        const attachmentFilenames = preparedAttachments?.files.map(file => file.filename) ?? [];
        if (preparedAttachments) authorizeAttachmentUploadReservations(channelId, preparedAttachments.files);
        authorizeWirePayload(channelId, encrypted.content, attachmentFilenames);
        message.content = encrypted.content;
        for (const upload of uploads) approvedAttachmentUploads.add(upload);
        return { stop: true };
    } catch {
        showToast("Secure Messaging stopped the send because encryption failed unexpectedly.", Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

const editListener: MessageEditListener = async channelId => {
    try {
        const channel = ChannelStore.getChannel(channelId);
        const context = currentSnapshot(channel);
        if (!context) return;
        const conversation = await Native.getConversation(context.localUserId, context.snapshot);
        if (!requiresFailClosedSend(conversation)) return;

        if (isNativeFailure(conversation)) showFailure(conversation);
        else showToast("Editing is blocked in protected conversations. Send a new encrypted correction instead.", Toasts.Type.FAILURE);
        return { cancel: true };
    } catch {
        showToast("Secure Messaging stopped the edit because its protection state could not be verified.", Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

function LockIcon({ color }: Record<string, any>) {
    return (
        <svg aria-hidden role="img" width="20" height="20" viewBox="0 0 24 24" style={{ color }}>
            <path
                fill="currentColor"
                d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V7Zm3 9.73V18h-2v-1.27a2 2 0 1 1 2 0Z"
            />
        </svg>
    );
}

async function sendKeyAnnouncement(channelId: string, localUserId: string): Promise<void> {
    const announcement = await Native.createAnnouncement(localUserId);
    if (announcement.status !== "created") {
        showFailure(announcement);
        return;
    }

    permitAnnouncement(channelId, announcement.content);
    authorizeWirePayload(channelId, announcement.content);
    try {
        await sendMessage(channelId, { content: announcement.content });
        showToast("Public key announcement sent. Ask recipients to compare the fingerprint outside Discord.", Toasts.Type.SUCCESS);
    } catch {
        showToast("Discord failed to send the key announcement.", Toasts.Type.FAILURE);
    } finally {
        revokeAnnouncement(channelId, announcement.content);
    }
}

function IdentityBlock({ identity }: { identity: IdentitySummary; }) {
    return (
        <>
            <code className="pc-secure-fingerprint">{identity.formattedFingerprint}</code>
            <div className="pc-secure-modal-actions">
                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                        copyToClipboard(identity.formattedFingerprint);
                        showToast("Fingerprint copied.", Toasts.Type.SUCCESS);
                    }}
                >
                    Copy fingerprint
                </Button>
            </div>
        </>
    );
}

interface ConversationManagerProps {
    channel: Channel;
    modalProps: RenderModalProps;
}

function ConversationManager({ channel, modalProps }: ConversationManagerProps) {
    const context = currentSnapshot(channel);
    const [identity, setIdentity] = useState<IdentityResult | null>(null);
    const [conversation, setConversation] = useState<ConversationResult | null>(null);
    const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
    const [enableEncryption, setEnableEncryption] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRotation, setConfirmRotation] = useState(false);
    const captureProtection = useScreenCaptureProtectionStatus();

    const load = useCallback(async () => {
        if (!context) return;
        setBusy(true);
        setError(null);
        try {
            const [nextIdentity, nextConversation] = await Promise.all([
                Native.getIdentity(context.localUserId),
                Native.getConversation(context.localUserId, context.snapshot),
            ]);
            setIdentity(nextIdentity);
            setConversation(nextConversation);
            if (conversationHasDetails(nextConversation)) {
                setSelectedRecipientIds(availableSelectedRecipientIds(nextConversation));
                setEnableEncryption(nextConversation.status === "enabled");
            }
        } catch {
            setError("Secure Messaging could not load the encrypted conversation state.");
        } finally {
            setBusy(false);
        }
    }, [channel.id, channel.recipients?.join(","), context?.localUserId]);

    useEffect(() => { void load(); }, [load]);

    if (!context) {
        return <Modal {...modalProps} size="sm" title="Secure Messaging"><div className="pc-secure-modal">Only DMs and group DMs are supported.</div></Modal>;
    }

    const details = conversation && conversationHasDetails(conversation) ? conversation : null;
    const readyIdentity = identity?.status === "ready" ? identity.identity : null;

    const toggleRecipient = (userId: string, checked: boolean) => {
        setSelectedRecipientIds(current => checked
            ? [...new Set([...current, userId])].sort((left, right) => left.localeCompare(right))
            : current.filter(id => id !== userId));
    };

    const save = async () => {
        if (enableEncryption && selectedRecipientIds.length === 0) {
            setError("Select at least one verified recipient before enabling encryption.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await Native.configureConversation(context.localUserId, {
                enabled: enableEncryption,
                selectedRecipientIds,
                snapshot: context.snapshot,
            });
            setConversation(result);
            if (result.status === "enabled" || result.status === "disabled") {
                showToast(result.status === "enabled" ? "Encrypted sending enabled." : "Encrypted sending disabled.", Toasts.Type.SUCCESS);
                modalProps.onClose();
            } else if (isNativeFailure(result)) {
                setError(failureMessage(result));
            } else {
                setError(conversationStatusMessage(result));
            }
        } catch {
            setError("Secure Messaging refused to save an unverified configuration.");
        } finally {
            setBusy(false);
        }
    };

    const rotate = async () => {
        if (!readyIdentity || !confirmRotation) return;
        setBusy(true);
        setError(null);
        try {
            const result = await Native.rotateIdentity(context.localUserId, readyIdentity.fingerprint);
            if (result.status === "rotated") {
                setIdentity({ status: "ready", identity: result.identity });
                setEnableEncryption(false);
                setConfirmRotation(false);
                showToast(`Identity rotated; ${result.disabledConversationCount} protected conversation(s) disabled.`, Toasts.Type.SUCCESS);
                await load();
            } else if (result.status === "fingerprint_mismatch") {
                setIdentity({ status: "ready", identity: result.identity });
                setError("The identity changed before rotation. Review the new fingerprint first.");
            } else {
                setError(failureMessage(result));
            }
        } catch {
            setError("Identity rotation failed safely; the previous identity remains in use.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="medium"
            title="Secure Messaging (experimental v1)"
            actions={[
                { text: "Save", variant: "primary", onClick: () => void save(), disabled: busy || !details },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose, disabled: busy },
            ]}
        >
            <div className="pc-secure-modal">
                <BaseText size="sm">
                    Non-ratcheting end-to-end encryption for selected people in this conversation. Everyone you select must install the plugin and verify fingerprints outside Discord.
                </BaseText>

                <section className="pc-secure-modal-section">
                    <Heading tag="h5">Your identity</Heading>
                    {identity == null && <BaseText size="sm">Loading OS-protected identity…</BaseText>}
                    {identity && isNativeFailure(identity) && <BaseText size="sm" className="pc-secure-status-danger">{failureMessage(identity)}</BaseText>}
                    {readyIdentity && (
                        <>
                            <IdentityBlock identity={readyIdentity} />
                            <Button size="small" onClick={() => void sendKeyAnnouncement(channel.id, context.localUserId)} disabled={busy}>
                                Share public key in this chat
                            </Button>
                        </>
                    )}
                </section>

                <section className="pc-secure-modal-section">
                    <Heading tag="h5">Selected recipients</Heading>
                    <BaseText size="xs" color="text-muted">
                        Unselected group members can see the ciphertext and metadata but cannot decrypt the message text.
                    </BaseText>
                    {details?.participants.map(participant => {
                        const userId = participant.status === "untrusted" ? participant.userId : participant.identity.userId;
                        const trusted = participant.status === "trusted";
                        return (
                            <div className="pc-secure-participant" key={userId}>
                                <Checkbox
                                    value={trusted && selectedRecipientIds.includes(userId)}
                                    disabled={!trusted || busy}
                                    onChange={(_event, checked) => toggleRecipient(userId, checked)}
                                    size={20}
                                >
                                    <div className="pc-secure-participant-identity">
                                        <BaseText size="sm" weight="semibold">{userLabel(userId)}</BaseText>
                                        <Span size="xs" color="text-muted">
                                            {trusted ? participant.identity.formattedFingerprint :
                                                participant.status === "key_changed" ? "Trusted key changed — review a new announcement" : "No verified key announcement"}
                                        </Span>
                                    </div>
                                </Checkbox>
                            </div>
                        );
                    })}
                    {!details && !busy && <BaseText size="sm">Conversation state is unavailable.</BaseText>}
                </section>

                <section className="pc-secure-modal-section">
                    <Checkbox
                        value={enableEncryption}
                        disabled={busy || !details}
                        onChange={(_event, checked) => setEnableEncryption(checked)}
                        size={20}
                    >
                        <BaseText size="sm" weight="semibold">Encrypt new messages and file attachments for the selected recipients</BaseText>
                    </Checkbox>
                    {conversation && (
                        <BaseText
                            size="xs"
                            className={conversation.status === "enabled" ? "pc-secure-status-enabled" :
                                conversation.status === "participant_changed" || conversation.status === "unverified_recipients" ? "pc-secure-status-warning" : undefined}
                        >
                            {conversationStatusMessage(conversation)}
                        </BaseText>
                    )}
                </section>

                <section className="pc-secure-modal-section">
                    <Heading tag="h5">Screenshots and screen sharing</Heading>
                    <BaseText size="xs" color="text-muted">
                        Screenshot mode makes Discord capturable while replacing decrypted messages and attachments with protected placeholders. Protected sending and decryption resume after capture protection is restored.
                    </BaseText>
                    <Button
                        size="small"
                        variant={captureProtection === "screenshot" ? "primary" : "secondary"}
                        disabled={captureProtection === "pending" || captureProtection === "disabled"}
                        onClick={() => void setScreenshotMode(captureProtection === "ready")}
                    >
                        {captureProtection === "screenshot" ? "Protect encrypted messages again" :
                            captureProtection === "failed" ? "Retry screen-capture protection" : "Allow screenshots safely"}
                    </Button>
                    <BaseText size="xs" className={captureProtection === "screenshot" ? "pc-secure-status-warning" : undefined}>
                        {captureProtection === "screenshot" ? "Screenshots are allowed. Encrypted content is hidden." :
                            captureProtection === "ready" ? "Encrypted content is visible and Discord is excluded from capture." :
                                captureProtection === "failed" ? "Encrypted content remains hidden because capture protection is unavailable." :
                                    "Updating screen-capture protection…"}
                    </BaseText>
                </section>

                <section className="pc-secure-modal-section">
                    <Heading tag="h5">Important limitations</Heading>
                    <BaseText size="xs" color="text-muted">
                        v1 encrypts text, GIF-picker links, sticker metadata, and ordinary file attachments. Received files are fully downloaded, authenticated, and decrypted locally before Discord's normal renderers display them. Commands and edits remain blocked. Discord still sees who talks, when, ciphertext sizes, attachment counts, channel membership, and reply metadata. Normal link and GIF previews disclose their URL to Discord's unfurl service; displaying a sticker requests its asset ID from Discord's media CDN. v1 has no forward secrecy or post-compromise healing, and a compromised client or plugin can read plaintext while it is displayed.
                    </BaseText>
                </section>

                {readyIdentity && (
                    <section className="pc-secure-modal-section">
                        <Heading tag="h5">Identity reset</Heading>
                        <Checkbox
                            value={confirmRotation}
                            disabled={busy}
                            onChange={(_event, checked) => setConfirmRotation(checked)}
                            size={20}
                        >
                            <BaseText size="xs">I understand that rotating my key disables every protected conversation and requires everyone to verify me again.</BaseText>
                        </Checkbox>
                        <Button size="small" variant="dangerPrimary" disabled={!confirmRotation || busy} onClick={() => void rotate()}>
                            Rotate my identity
                        </Button>
                    </section>
                )}

                {busy && <BaseText size="xs" color="text-muted">Working…</BaseText>}
                {error && <BaseText size="sm" className="pc-secure-status-danger">{error}</BaseText>}
            </div>
        </Modal>
    );
}

function openConversationManager(channel: Channel): void {
    openModal(modalProps => <ConversationManager channel={channel} modalProps={modalProps} />);
}

const SecureMessagingButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const context = currentSnapshot(channel);
    const [status, setStatus] = useState<ConversationResult["status"] | "loading">("loading");
    const captureProtection = useScreenCaptureProtectionStatus();
    const participantsKey = channel.recipients?.join(",") ?? "";

    useEffect(() => {
        let active = true;
        if (!context) return () => { active = false; };
        setStatus("loading");
        void Native.getConversation(context.localUserId, context.snapshot)
            .then(result => { if (active) setStatus(result.status); })
            .catch(() => { if (active) setStatus("failed"); });
        return () => { active = false; };
    }, [channel.id, context?.localUserId, participantsKey]);

    if (!isMainChat || !context) return null;
    const color = captureProtection === "screenshot" ? "var(--status-warning)" : status === "enabled" ? "var(--status-positive)" :
        status === "participant_changed" || status === "unverified_recipients" ? "var(--status-warning)" :
            status === "failed" || status === "unavailable" ? "var(--status-danger)" : undefined;
    const tooltip = captureProtection === "screenshot" ? "Secure Messaging: screenshots allowed, encrypted content hidden" :
        status === "enabled" ? "Secure Messaging: encrypted" :
        status === "participant_changed" || status === "unverified_recipients" ? "Secure Messaging needs attention" :
            "Configure Secure Messaging";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => openConversationManager(channel)}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <LockIcon color={color} />
        </ChatBarButton>
    );
};

function encryptedStatusText(result: DecryptIncomingResult): string {
    if (result.status === "untrusted_author") return "Encrypted message from an unverified key. Verify the sender's key announcement first.";
    if (result.status === "replay_detected") return "Blocked a replayed or conflicting encrypted envelope.";
    if (result.status === "invalid_message") return "This encrypted message failed authentication, targets another recipient, or is malformed.";
    if (isNativeFailure(result)) return failureMessage(result);
    return "";
}

function EncryptedAttachmentStatus({ expectedCount, message }: { expectedCount: number; message: Message; }) {
    const [, setRevision] = useState(0);
    useEffect(
        () => subscribeEncryptedAttachmentStatus(message, () => setRevision(revision => revision + 1)),
        [message.channel_id, message.id, message.content, message.attachments],
    );
    if (expectedCount !== message.attachments.length) {
        return (
            <BaseText size="xs" className="pc-secure-status-danger">
                The authenticated attachment bundle is incomplete or has conflicting Discord attachments.
            </BaseText>
        );
    }
    if (expectedCount === 0) return null;
    const status = encryptedAttachmentStatus(message);
    if (status.status === "idle" || status.status === "ready") return null;
    const messageText = status.status === "loading"
        ? "Authenticating and decrypting attachments locally…"
        : "reason" in status ? status.reason : "The encrypted attachments could not be loaded.";
    return (
        <BaseText size="xs" className={status.status === "failed" ? "pc-secure-status-danger" : undefined}>
            {messageText}
        </BaseText>
    );
}

function EncryptedMessageAccessory({ message }: { message: Message; }) {
    const [result, setResult] = useState<DecryptIncomingResult | null>(null);
    const localUserId = UserStore.getCurrentUser()?.id;
    const captureProtection = useScreenCaptureProtectionStatus();

    useEffect(() => {
        let active = true;
        setResult(null);
        if (captureProtection !== "ready" || !localUserId || !message.author?.id) return () => { active = false; };
        void Native.decryptIncoming(localUserId, {
            channelId: message.channel_id,
            content: message.content,
            discordAuthorId: message.author.id,
            discordEditedTimestamp: discordEditedTimestamp(message),
            discordMessageId: message.id,
        }).then(next => { if (active) setResult(next); }).catch(() => {
            if (active) setResult({ status: "failed", error: "cryptographic_operation_failed" });
        });
        return () => { active = false; };
    }, [captureProtection, localUserId, message.channel_id, message.id, message.content, message.author?.id]);

    if (captureProtection !== "ready") {
        const screenshotMode = captureProtection === "screenshot";
        const detail = screenshotMode
            ? "Screenshot mode is on. Restore screen-capture protection to view this message."
            : captureProtection === "pending"
            ? "Waiting for operating-system screen-capture protection before decrypting…"
            : "Operating-system screen-capture protection is unavailable, so plaintext remains hidden.";
        return (
            <div className={`pc-secure-card ${screenshotMode ? "pc-secure-card-warning" : "pc-secure-card-danger"} pc-secure-content-hidden pc-secure-replaces-content`}>
                <div className="pc-secure-card-header"><LockIcon color={screenshotMode ? "var(--status-warning)" : "var(--status-danger)"} /> Encrypted message protected</div>
                <BaseText size="sm">{detail}</BaseText>
            </div>
        );
    }

    if (!result) {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header"><LockIcon /> Authenticating and decrypting locally…</div>
            </div>
        );
    }
    if (result.status === "decrypted") {
        return (
            <div className="pc-secure-card pc-secure-message pc-secure-replaces-content">
                <div className="pc-secure-card-header"><LockIcon color="var(--status-positive)" /> Verified encrypted message · v1</div>
                {result.plaintext && <div className="pc-secure-card-plaintext">{Parser.parse(result.plaintext)}</div>}
                <EncryptedAttachmentStatus expectedCount={result.attachmentBundle?.count ?? 0} message={message} />
            </div>
        );
    }

    return (
        <div className="pc-secure-card pc-secure-card-danger pc-secure-replaces-content">
            <div className="pc-secure-card-header"><LockIcon color="var(--status-danger)" /> Encrypted message blocked</div>
            <BaseText size="sm">{encryptedStatusText(result)}</BaseText>
        </div>
    );
}

interface KeyReviewModalProps {
    content: string;
    discordEditedTimestamp: string | null;
    discordMessageId: string;
    initialReview: AnnouncementReviewResult;
    localUserId: string;
    modalProps: RenderModalProps;
    peerUserId: string;
}

function KeyReviewModal({ content, discordEditedTimestamp, discordMessageId, initialReview, localUserId, modalProps, peerUserId }: KeyReviewModalProps) {
    const [review, setReview] = useState(initialReview);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const identity = review.status === "trust_required" || review.status === "trusted" || review.status === "key_changed"
        ? review.identity
        : null;

    const trust = async () => {
        if (!confirmed || !identity) return;
        setBusy(true);
        setError(null);
        try {
            let reviewed = review;
            if (reviewed.status === "key_changed") {
                const forgotten = await Native.forgetPeer(localUserId, peerUserId);
                if (forgotten.status !== "forgotten" && forgotten.status !== "not_found") {
                    setError(failureMessage(forgotten));
                    return;
                }
                reviewed = await Native.reviewAnnouncement(
                    localUserId,
                    peerUserId,
                    content,
                    discordMessageId,
                    discordEditedTimestamp,
                );
                setReview(reviewed);
            }
            if (reviewed.status !== "trust_required") {
                setError(reviewed.status === "trusted" ? "This key is already trusted." :
                    isNativeFailure(reviewed) ? failureMessage(reviewed) : "The reviewed key changed before it could be trusted.");
                return;
            }
            const trusted = await Native.trustReviewedKey(
                localUserId,
                peerUserId,
                reviewed.reviewToken,
                identity.fingerprint,
            );
            if (trusted.status === "trusted" || trusted.status === "already_trusted") {
                showToast(`Verified Secure Messaging key for ${userLabel(peerUserId)}.`, Toasts.Type.SUCCESS);
                modalProps.onClose();
            } else if (isNativeFailure(trusted)) {
                setError(failureMessage(trusted));
            } else {
                setError(trusted.status === "review_expired" ? "The review expired. Close this window and review the announcement again." :
                    trusted.status === "fingerprint_mismatch" ? "The fingerprint changed during verification." :
                        "A different key is already trusted. Review the change again.");
            }
        } catch {
            setError("The key was not trusted because verification failed unexpectedly.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title={review.status === "key_changed" ? "Verify changed encryption key" : "Verify encryption key"}
            actions={[
                {
                    text: review.status === "key_changed" ? "Replace verified key" : "Trust key",
                    variant: review.status === "key_changed" ? "danger" : "primary",
                    onClick: () => void trust(),
                    disabled: !confirmed || busy || !identity || review.status === "trusted",
                },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose, disabled: busy },
            ]}
        >
            <div className="pc-secure-modal">
                {review.status === "key_changed" && (
                    <BaseText size="sm" className="pc-secure-status-danger">
                        The sender's key changed. This can be a legitimate reset or an impersonation attempt. Replacing it disables affected protected conversations.
                    </BaseText>
                )}
                {identity && <IdentityBlock identity={identity} />}
                {review.status === "key_changed" && (
                    <>
                        <BaseText size="xs" color="text-muted">Previously trusted fingerprint</BaseText>
                        <code className="pc-secure-fingerprint">{review.trustedIdentity.formattedFingerprint}</code>
                    </>
                )}
                <Checkbox
                    value={confirmed}
                    disabled={busy || !identity || review.status === "trusted"}
                    onChange={(_event, checked) => setConfirmed(checked)}
                    size={20}
                >
                    <BaseText size="sm">
                        I compared the full fingerprint with {userLabel(peerUserId)} through a trusted channel outside this Discord conversation.
                    </BaseText>
                </Checkbox>
                <BaseText size="xs" color="text-muted">
                    Comparing a fingerprint sent inside this same Discord chat does not prevent a first-contact interception.
                </BaseText>
                {error && <BaseText size="sm" className="pc-secure-status-danger">{error}</BaseText>}
            </div>
        </Modal>
    );
}

function openKeyReviewModal(message: Message, review: AnnouncementReviewResult, localUserId: string): void {
    openModal(modalProps => (
        <KeyReviewModal
            content={message.content}
            discordEditedTimestamp={discordEditedTimestamp(message)}
            discordMessageId={message.id}
            initialReview={review}
            localUserId={localUserId}
            modalProps={modalProps}
            peerUserId={message.author.id}
        />
    ));
}

function KeyAnnouncementAccessory({ message }: { message: Message; }) {
    const localUserId = UserStore.getCurrentUser()?.id;
    const [review, setReview] = useState<AnnouncementReviewResult | null>(null);

    useEffect(() => {
        let active = true;
        setReview(null);
        if (!localUserId || !message.author?.id || message.author.id === localUserId) return () => { active = false; };
        void Native.reviewAnnouncement(
            localUserId,
            message.author.id,
            message.content,
            message.id,
            discordEditedTimestamp(message),
        )
            .then(result => { if (active) setReview(result); })
            .catch(() => { if (active) setReview({ status: "failed", error: "cryptographic_operation_failed" }); });
        return () => { active = false; };
    }, [localUserId, message.author?.id, message.content]);

    if (message.author?.id === localUserId) {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Your Secure Messaging public-key announcement</div>
                <BaseText size="xs" color="text-muted">Recipients must compare its fingerprint with you outside Discord.</BaseText>
            </div>
        );
    }
    if (!review) {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Verifying public-key announcement…</div>
            </div>
        );
    }
    if (review.status === "invalid_announcement" || isNativeFailure(review)) {
        return (
            <div className="pc-secure-card pc-secure-card-danger pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Invalid Secure Messaging key announcement</div>
                {isNativeFailure(review) && <BaseText size="xs">{failureMessage(review)}</BaseText>}
            </div>
        );
    }
    if (review.status === "stale_announcement") {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Older Secure Messaging key announcement ignored</div>
                <BaseText size="xs" color="text-muted">
                    A newer key is already verified for this person. This historical announcement cannot replace or disable it.
                </BaseText>
                <code className="pc-secure-fingerprint">{review.trustedIdentity.formattedFingerprint}</code>
            </div>
        );
    }

    const trusted = review.status === "trusted";
    return (
        <div className={`pc-secure-card pc-secure-replaces-content ${review.status === "key_changed" ? "pc-secure-card-danger" : "pc-secure-card-warning"}`}>
            <div className="pc-secure-card-header">
                🔑 {trusted ? "Verified Secure Messaging key" : review.status === "key_changed" ? "Encryption key changed" : "Encryption key needs verification"}
            </div>
            <code className="pc-secure-fingerprint">{review.identity.formattedFingerprint}</code>
            {!trusted && (
                <div className="pc-secure-card-actions">
                    <Button size="xs" variant={review.status === "key_changed" ? "dangerPrimary" : "primary"} onClick={() => openKeyReviewModal(message, review, localUserId!)}>
                        {review.status === "key_changed" ? "Review changed key" : "Review & verify"}
                    </Button>
                </div>
            )}
        </div>
    );
}

function SecureMessageAccessory({ message }: { message: Message; }) {
    if (isEncryptedMessage(message.content)) return <EncryptedMessageAccessory message={message} />;
    if (isKeyAnnouncement(message.content)) return <KeyAnnouncementAccessory message={message} />;
    return null;
}

export default definePlugin({
    name: "SecureMessaging",
    description: "Non-ratcheting end-to-end encrypted messages, stickers, GIF links, and file attachments for explicitly verified people in DMs and group DMs.",
    tags: ["Chat", "Privacy", "Utility"],
    authors: [EquicordDevs.creations],
    dependencies: ["ChatInputButtonAPI", "MessageAccessoriesAPI", "MessageEventsAPI"],

    patches: [
        {
            find: "renderAttachments",
            replacement: [
                {
                    match: /renderAttachments\((\i)\)\{(?=let\{channel:)/,
                    replace: "$&$1=$self.patchEncryptedAttachments($1,this);",
                },
                {
                    match: /renderEmbeds\((\i)\)\{/,
                    replace: "$&$1=$self.patchEncryptedEmbeds($1,this);",
                },
                {
                    match: /renderStickersAccessories\((\i)\)\{/,
                    replace: "$&$1=$self.patchEncryptedStickers($1,this);",
                },
            ],
        },
        {
            find: /function\(\i\)\{let\{baseMessage:\i,referencedMessage:\i,channel:\i,compact:/,
            replacement: {
                match: /(function\((\i)\)\{)(?=let\{baseMessage:\i,referencedMessage:\i,channel:\i,compact:)/,
                replace: "$1$2=$self.useSecureReplyPreview($2);",
            },
        },
    ],

    chatBarButton: {
        icon: LockIcon,
        render: SecureMessagingButton,
    },

    renderMessageAccessory: props => <SecureMessageAccessory message={props.message} />,

    toolboxActions: {
        async "Toggle safe screenshots"() {
            const enabling = screenCaptureProtectionStatus === "ready";
            if (!enabling && screenCaptureProtectionStatus !== "screenshot" && screenCaptureProtectionStatus !== "failed") {
                showToast("Screen-capture protection is still updating.", Toasts.Type.FAILURE);
                return;
            }
            if (await setScreenshotMode(enabling)) {
                showToast(
                    enabling ? "Screenshots are allowed; encrypted content is hidden." : "Encrypted content is protected again.",
                    Toasts.Type.SUCCESS,
                );
            }
        },
    },

    flux: {
        MESSAGE_CREATE: handleKeyAnnouncementDispatch,
        MESSAGE_UPDATE: handleKeyAnnouncementDispatch,
        LOAD_MESSAGES_SUCCESS: handleLoadedKeyAnnouncements,
    },

    start() {
        const generation = ++screenCaptureProtectionGeneration;
        setScreenCaptureProtectionStatus("pending");
        installAttachmentUploadGuard();
        installNetworkGuard();
        void applyScreenCaptureProtection(true).then(applied => {
            if (generation !== screenCaptureProtectionGeneration) return;
            if (!applied) {
                setScreenCaptureProtectionStatus("failed");
                return;
            }
            setScreenCaptureProtectionStatus("ready");
            try {
                addMessagePreSendListener(outgoingListener, { priority: SECURE_LISTENER_PRIORITY, cancelOnError: true });
                addMessagePreEditListener(editListener, { priority: SECURE_LISTENER_PRIORITY, cancelOnError: true });
                secureMessageListenersInstalled = true;
            } catch {
                removeMessagePreSendListener(outgoingListener);
                removeMessagePreEditListener(editListener);
                setScreenCaptureProtectionStatus("failed");
                showToast("Secure Messaging could not install its protected message listeners.", Toasts.Type.FAILURE);
            }
        });
    },

    stop() {
        screenCaptureProtectionGeneration++;
        setScreenCaptureProtectionStatus("disabled");
        uninstallAttachmentUploadGuard();
        uninstallNetworkGuard();
        void applyScreenCaptureProtection(false);
        if (secureMessageListenersInstalled) {
            removeMessagePreSendListener(outgoingListener);
            removeMessagePreEditListener(editListener);
            secureMessageListenersInstalled = false;
        }
        permittedAnnouncements.clear();
        clearWirePayloadAuthorizations();
        clearEncryptedAttachmentCache();
        clearEncryptedEmbedCache();
        keyReviewGate = new KeyReviewGate();
    },

    patchEncryptedAttachments(message: Message, owner: { forceUpdate(): void; }) {
        const ready = screenCaptureProtectionStatus === "ready";
        if (!ready) pendingEncryptedRenderOwners.add(owner);
        return patchEncryptedMessageAttachments(message, () => owner.forceUpdate(), ready);
    },

    patchEncryptedEmbeds(message: Message, owner: { forceUpdate(): void; }) {
        const ready = screenCaptureProtectionStatus === "ready";
        if (!ready) pendingEncryptedRenderOwners.add(owner);
        return patchEncryptedMessageEmbeds(message, () => owner.forceUpdate(), ready);
    },

    patchEncryptedStickers(message: Message, owner: { forceUpdate(): void; }) {
        const ready = screenCaptureProtectionStatus === "ready";
        if (!ready) pendingEncryptedRenderOwners.add(owner);
        return patchEncryptedMessageStickers(message, () => owner.forceUpdate(), ready);
    },

    useSecureReplyPreview,

    getScreenCaptureProtectionStatus() {
        return screenCaptureProtectionStatus;
    },

    setScreenshotMode,
});
