/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import puppeteer, { Page } from "puppeteer-core";

import {
    createKeyAnnouncement,
    decryptMessage,
    generateIdentity,
    verifyKeyAnnouncement,
} from "../src/equicordplugins/secureMessaging.desktop/crypto";
import {
    attachmentBundleRoot,
    decryptAttachmentBytes,
    parseSecurePlaintext,
} from "../src/equicordplugins/secureMessaging.desktop/attachments";
import { decodeBase64Url } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const TEST_CHANNEL_ID = "895063026686885909";
const EXPECTED_RECIPIENT_ID = "710514340855545878";
// Synthetic peer-announcement fixture; this snowflake decodes to 2026-01-01T00:00:00.000Z.
// The announcement is never posted, so the fixture supplies stable Discord provenance without creating another live message.
const SYNTHETIC_ANNOUNCEMENT_MESSAGE_ID = "1456074443980800000";
const DEBUG_URL = process.env.DISCORD_DEBUG_URL ?? "http://127.0.0.1:9222";
const ENCRYPTED_PREFIX = "PCEM1:";
const DISPOSABLE_ACKNOWLEDGEMENT = "I_UNDERSTAND_THIS_IS_DISPOSABLE";
const DISPOSABLE_FLAG_ENV = "LAWYERCORD_SECURE_MESSAGING_LIVE_TEST";
const DISPOSABLE_DATA_DIR_ENV = "LAWYERCORD_SECURE_MESSAGING_LIVE_DATA_DIR";
const CLIENT_DATA_DIR_ENV = "LAWYERCORD_USER_DATA_DIR";
const PRESTARTED_PLUGIN_ENV = "LAWYERCORD_SECURE_MESSAGING_PRESTARTED";
const PAGE_MESSAGE_REGISTRY = "__lawyerCordSecureMessagingLiveMessageIds";
const PROOF_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGP8z8Dwn4GBgYEJRKAwADE7AgRVI0g0AAAAAElFTkSuQmCC";
const PROOF_PNG_FILENAME = "encrypted-proof-pixel.png";

interface RawDiscordMessage {
    attachments: RawDiscordAttachment[];
    authorId: string;
    channelId: string;
    content: string;
    editedTimestamp: string | null;
    id: string;
}

interface RawDiscordAttachment {
    contentType: string | null;
    filename: string;
    id: string;
    proxyUrl: string;
    size: number;
    url: string;
}

interface LivePreflight {
    localAnnouncement: string;
    localFingerprint: string;
    localUserId: string;
    recipientReviewToken: string;
    reviewedRecipientFingerprint: string;
    vaultReady: boolean;
}

interface CleanupProof {
    channelProtectionStatus: string;
    conversationStatus: string;
    participantStatus: string;
    selectedRecipientIds: string[];
    testMessagesDeleted: boolean;
}

function comparablePath(path: string): string {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
}

function requireDisposableDataDirectory(): string {
    assert.equal(
        process.env[DISPOSABLE_FLAG_ENV],
        DISPOSABLE_ACKNOWLEDGEMENT,
        `${DISPOSABLE_FLAG_ENV} must equal ${JSON.stringify(DISPOSABLE_ACKNOWLEDGEMENT)}`,
    );

    const declaredDataDir = process.env[DISPOSABLE_DATA_DIR_ENV];
    const clientDataDir = process.env[CLIENT_DATA_DIR_ENV];
    assert.ok(declaredDataDir, `${DISPOSABLE_DATA_DIR_ENV} must name the disposable test data directory`);
    assert.ok(clientDataDir, `${CLIENT_DATA_DIR_ENV} must explicitly route the client to the disposable test data directory`);
    assert.equal(isAbsolute(declaredDataDir), true, `${DISPOSABLE_DATA_DIR_ENV} must be an absolute path`);
    assert.equal(isAbsolute(clientDataDir), true, `${CLIENT_DATA_DIR_ENV} must be an absolute path`);
    assert.equal(
        comparablePath(declaredDataDir),
        comparablePath(clientDataDir),
        `${DISPOSABLE_DATA_DIR_ENV} and ${CLIENT_DATA_DIR_ENV} must resolve to the same directory`,
    );

    const absolute = resolve(declaredDataDir);
    assert.match(
        basename(absolute),
        /secure-messaging-live/iu,
        "the disposable data-directory basename must contain 'secure-messaging-live'",
    );
    return absolute;
}

function asError(error: unknown, context?: string): Error {
    const cause = error instanceof Error ? error : new Error(String(error));
    return context ? new Error(`${context}: ${cause.message}`) : cause;
}

async function assertNoExistingSecureMessagingVault(dataDir: string): Promise<void> {
    const vaultPath = resolve(dataDir, "secure-messaging", "vault.bin");
    try {
        await stat(vaultPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    throw new Error(`Refusing to reuse a SecureMessaging data directory that already contains ${vaultPath}`);
}

async function connectWithRetry() {
    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            return await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw lastError;
}

async function getDiscordPage(pages: Page[]): Promise<Page> {
    const deadline = Date.now() + 30_000;
    let candidates = pages;
    while (Date.now() < deadline) {
        const page = candidates.find(candidate => !candidate.isClosed() && candidate.url().includes("discord.com/channels")) ??
            candidates.find(candidate => !candidate.isClosed());
        if (page) {
            try {
                if (await page.evaluate(() => Boolean((globalThis as any).Vencord?.Plugins?.plugins))) return page;
            } catch {
                // Discord replaces its startup frame; reacquire the renderer page until it settles.
            }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        candidates = page ? await page.browser().pages() : candidates;
    }
    throw new Error("Discord did not expose a stable LawyerCord renderer page");
}

async function assertConnectedClientUsesDisposableDataDir(page: Page, expectedDataDir: string): Promise<void> {
    const settingsDir = await page.evaluate(async () => {
        const getSettingsDir = (globalThis as any).VencordNative?.settings?.getSettingsDir;
        if (typeof getSettingsDir !== "function") throw new Error("The connected client cannot report its settings directory");
        return getSettingsDir();
    });
    assert.equal(
        comparablePath(dirname(settingsDir)),
        comparablePath(expectedDataDir),
        "the connected Discord client is not using the declared disposable LawyerCord data directory",
    );
}

async function initializeMessageRegistry(page: Page): Promise<void> {
    await page.evaluate(registryName => {
        (globalThis as any)[registryName] = [];
    }, PAGE_MESSAGE_REGISTRY);
}

async function assertSecureMessagingInitialState(page: Page, expectStarted: boolean): Promise<void> {
    if (expectStarted) {
        await page.waitForFunction(() => {
            const vencord = (globalThis as any).Vencord;
            return Boolean(vencord?.Plugins?.plugins?.SecureMessaging?.started) &&
                vencord?.Settings?.plugins?.SecureMessaging?.enabled === true;
        }, { timeout: 30_000 });
    }
    await page.evaluate(expected => {
        const vencord = (globalThis as any).Vencord;
        const plugin = vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is missing from the installed client bundle");
        if (Boolean(plugin.started) !== expected)
            throw new Error(`SecureMessaging initial started state was ${Boolean(plugin.started)} instead of ${expected}`);
        const pluginSettings = Object.prototype.hasOwnProperty.call(vencord.Settings?.plugins ?? {}, "SecureMessaging")
            ? vencord.Settings.plugins.SecureMessaging
            : undefined;
        if (Boolean(pluginSettings?.enabled) !== expected)
            throw new Error(`SecureMessaging initial enabled setting was ${Boolean(pluginSettings?.enabled)} instead of ${expected}`);
    }, expectStarted);
}

async function assertMessageEventsSendPatch(page: Page): Promise<void> {
    await page.waitForFunction(() => document.querySelector('[role="textbox"]'), { timeout: 30_000 });
    const result = await page.evaluate(() => {
        const editor = document.querySelector('[role="textbox"]');
        const fiberKey = editor && Object.keys(editor).find(key => key.startsWith("__reactFiber$"));
        let fiber = fiberKey ? (editor as any)[fiberKey] : null;
        while (fiber) {
            const handleSendMessage = fiber.stateNode?.handleSendMessage;
            if (typeof handleSendMessage === "function") {
                const source = Function.prototype.toString.call(handleSendMessage);
                return source.split("Vencord.Api.MessageEvents._handlePreSend").length - 1;
            }
            fiber = fiber.return;
        }
        return 0;
    });
    assert.equal(result, 1, "the current chat-input send path must invoke MessageEvents exactly once");
}

async function preflightPristineState(page: Page, announcement: string, pluginPrestarted: boolean): Promise<LivePreflight> {
    return page.evaluate(async ({ announcement, announcementMessageId, channelId, pluginPrestarted, recipientId }) => {
        const global = globalThis as any;
        const vencord = global.Vencord;
        const common = vencord.Webpack.Common;
        const plugin = vencord.Plugins.plugins.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is missing from the installed client bundle");
        const native = global.VencordNative?.pluginHelpers?.SecureMessaging;
        if (!native) throw new Error("SecureMessaging native IPC helpers are unavailable");
        if (Boolean(plugin.started) !== pluginPrestarted)
            throw new Error("SecureMessaging changed its started state after the initial preflight");
        const pluginSettings = Object.prototype.hasOwnProperty.call(vencord.Settings?.plugins ?? {}, "SecureMessaging")
            ? vencord.Settings.plugins.SecureMessaging
            : undefined;
        if (Boolean(pluginSettings?.enabled) !== pluginPrestarted)
            throw new Error("SecureMessaging changed its enabled setting after the initial preflight");

        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        if (localUserId === recipientId) throw new Error("The authorized recipient unexpectedly matches the local account");

        const channel = common.ChannelStore.getChannel(channelId);
        if (!channel?.isDM?.()) throw new Error("The authorized test channel is not a loaded DM");
        const recipients: unknown[] = Array.isArray(channel.recipients) ? channel.recipients : [];
        const participantUserIds = [...new Set(recipients
            .filter((value: unknown): value is string => typeof value === "string" && value !== localUserId))]
            .sort((left, right) => left.localeCompare(right));
        if (participantUserIds.length !== 1 || participantUserIds[0] !== recipientId)
            throw new Error("The authorized test DM does not belong to the expected recipient");

        const persisted = await native.getChannelProtection(localUserId, channelId);
        if (persisted.status !== "unconfigured") {
            throw new Error(
                `Refusing to mutate an existing SecureMessaging conversation: persisted status is ${persisted.status}`,
            );
        }

        const snapshot = { channelId, kind: "DM", participantUserIds: [recipientId] };
        const conversation = await native.getConversation(localUserId, snapshot);
        if (conversation.status !== "unconfigured")
            throw new Error(`Refusing to mutate an existing SecureMessaging conversation: status is ${conversation.status}`);
        if (!Array.isArray(conversation.selectedRecipientIds) || conversation.selectedRecipientIds.length !== 0)
            throw new Error("Refusing to replace existing selected SecureMessaging recipients");
        const participant = conversation.participants?.find((candidate: any) => candidate.userId === recipientId);
        if (!participant || participant.status !== "untrusted") {
            throw new Error(
                `Refusing to replace existing peer trust or a changed key: participant status is ${participant?.status ?? "missing"}`,
            );
        }

        const identity = await native.getIdentity(localUserId);
        if (identity.status !== "ready") throw new Error(`Local OS-protected identity is unavailable: ${identity.status}`);
        const localAnnouncement = await native.createAnnouncement(localUserId);
        if (localAnnouncement.status !== "created") throw new Error(`Could not create local announcement: ${localAnnouncement.status}`);

        const review = await native.reviewAnnouncement(
            localUserId,
            recipientId,
            announcement,
            announcementMessageId,
            null,
        );
        if (review.status !== "trust_required") {
            throw new Error(
                `Refusing to forget or replace a pre-existing peer key: announcement review returned ${review.status}`,
            );
        }

        return {
            localAnnouncement: localAnnouncement.content,
            localFingerprint: identity.identity.fingerprint,
            localUserId,
            recipientReviewToken: review.reviewToken,
            reviewedRecipientFingerprint: review.identity.fingerprint,
            vaultReady: identity.status === "ready",
        };
    }, {
        announcement,
        announcementMessageId: SYNTHETIC_ANNOUNCEMENT_MESSAGE_ID,
        channelId: TEST_CHANNEL_ID,
        pluginPrestarted,
        recipientId: EXPECTED_RECIPIENT_ID,
    });
}

async function trustSyntheticRecipient(page: Page, reviewToken: string, fingerprint: string) {
    return page.evaluate(async ({ fingerprint, recipientId, reviewToken }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        return native.trustReviewedKey(localUserId, recipientId, reviewToken, fingerprint);
    }, { fingerprint, recipientId: EXPECTED_RECIPIENT_ID, reviewToken });
}

async function configureSyntheticConversation(page: Page) {
    return page.evaluate(async ({ channelId, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        return native.configureConversation(localUserId, {
            enabled: true,
            selectedRecipientIds: [recipientId],
            snapshot: { channelId, kind: "DM", participantUserIds: [recipientId] },
        });
    }, { channelId: TEST_CHANNEL_ID, recipientId: EXPECTED_RECIPIENT_ID });
}

async function startSecureMessagingPlugin(page: Page): Promise<{ pluginStarted: boolean; startResult: unknown; }> {
    return page.evaluate(async () => {
        const vencord = (globalThis as any).Vencord;
        const plugin = vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is missing from the installed client bundle");
        if (plugin.started) throw new Error("SecureMessaging unexpectedly started after the pristine-state check");
        const startResult = await Promise.resolve(vencord.Plugins.startPlugin(plugin));
        return { pluginStarted: Boolean(plugin.started), startResult };
    });
}

async function waitForScreenCaptureProtection(page: Page): Promise<string> {
    await page.waitForFunction(() => {
        const plugin = (globalThis as any).Vencord?.Plugins?.plugins?.SecureMessaging;
        return plugin?.getScreenCaptureProtectionStatus?.() === "ready";
    }, { timeout: 30_000 });
    return page.evaluate(() => (globalThis as any).Vencord.Plugins.plugins.SecureMessaging.getScreenCaptureProtectionStatus());
}

async function verifyScreenshotMode(page: Page, message: RawDiscordMessage, plaintext: string) {
    return page.evaluate(async ({ message, plaintext }) => {
        const plugin = (globalThis as any).Vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin || typeof plugin.setScreenshotMode !== "function")
            throw new Error("SecureMessaging screenshot mode is unavailable");
        let screenshotModeEnabled = false;
        try {
            screenshotModeEnabled = await plugin.setScreenshotMode(true);
            if (!screenshotModeEnabled) throw new Error("SecureMessaging refused to enable screenshot mode");
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const row = document.getElementById(`chat-messages-${message.channelId}-${message.id}`);
            const attachmentSiblings = row?.querySelectorAll<HTMLElement>('[id^="message-accessories-"] > :not(.pc-secure-card)') ?? [];
            return {
                attachmentPixelsHidden: [...attachmentSiblings].every(element => getComputedStyle(element).display === "none"),
                encryptedPlaceholderVisible: row?.innerText.includes("Screenshot mode is on") ?? false,
                rootCaptureClassApplied: document.documentElement.classList.contains("pc-secure-screenshot-mode"),
                plaintextHidden: !(row?.innerText ?? "").includes(plaintext),
            };
        } finally {
            if (screenshotModeEnabled || plugin.getScreenCaptureProtectionStatus?.() === "failed") {
                const restored = await plugin.setScreenshotMode(false);
                if (!restored) throw new Error("SecureMessaging did not restore screen-capture protection");
            }
        }
    }, { message, plaintext });
}

async function verifyRenderedReplyPreview(
    page: Page,
    reply: RawDiscordMessage,
    referencedCiphertext: string,
    referencedPlaintext: string,
) {
    await page.waitForFunction(
        ({ channelId, messageId, plaintext }) => {
            const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
            return row?.innerText.includes(plaintext) ?? false;
        },
        { timeout: 30_000 },
        { channelId: reply.channelId, messageId: reply.id, plaintext: referencedPlaintext },
    );
    return page.evaluate(({ channelId, ciphertext, messageId, plaintext }) => {
        const row = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const rowText = row?.innerText ?? "";
        return {
            ciphertextHidden: !rowText.includes(ciphertext) && !rowText.includes("PCEM1:"),
            plaintextVisible: rowText.includes(plaintext),
        };
    }, {
        channelId: reply.channelId,
        ciphertext: referencedCiphertext,
        messageId: reply.id,
        plaintext: referencedPlaintext,
    });
}

async function assertPersistedProtectionAndMissingChannelFailClosed(page: Page): Promise<{
    channelStoreRestored: boolean;
    missingChannelBlocked: boolean;
    persistedStatus: string;
    safelyMocked: boolean;
}> {
    return page.evaluate(async ({ channelId, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user");
        const persisted = await native.getChannelProtection(localUserId, channelId);
        if (persisted.status !== "protected")
            throw new Error(`Persisted native channel protection is not active: ${persisted.status}`);

        const channelStore = common.ChannelStore;
        const originalGetChannel = channelStore.getChannel;
        if (typeof originalGetChannel !== "function") throw new Error("ChannelStore.getChannel is unavailable");

        let safelyMocked = false;
        let channelStoreRestored = false;
        let missingChannelError = "";
        try {
            channelStore.getChannel = function (candidateChannelId: string) {
                if (candidateChannelId === channelId) return undefined;
                return originalGetChannel.call(this, candidateChannelId);
            };
            safelyMocked = channelStore.getChannel(channelId) == null;
            if (!safelyMocked) throw new Error("ChannelStore.getChannel could not be safely shadowed");

            try {
                const response = await common.RestAPI.post({
                    url: common.Constants.Endpoints.MESSAGES(channelId),
                    body: { content: "" },
                });
                const messageId = response?.body?.id;
                if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
            } catch (error) {
                missingChannelError = String(error);
            }
        } finally {
            channelStore.getChannel = originalGetChannel;
            channelStoreRestored = channelStore.getChannel === originalGetChannel && channelStore.getChannel(channelId) != null;
        }

        return {
            channelStoreRestored,
            missingChannelBlocked: /protected conversation snapshot is unavailable/iu.test(missingChannelError),
            persistedStatus: persisted.status,
            safelyMocked,
        };
    }, { channelId: TEST_CHANNEL_ID, registryName: PAGE_MESSAGE_REGISTRY });
}

async function assertFailClosedBoundaries(page: Page): Promise<{
    attachmentBlocked: boolean;
    attachmentReservationBlocked: boolean;
    editBlocked: boolean;
    prefixedPayloadBlocked: boolean;
}> {
    return page.evaluate(async ({ channelId, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageUrl = common.Constants.Endpoints.MESSAGES(channelId);
        const editUrl = common.Constants.Endpoints.MESSAGE(channelId, "100000000000000001");
        const attachmentReservationUrl = common.Constants.Endpoints.MESSAGE_CREATE_ATTACHMENT_UPLOAD?.(channelId) ??
            `/channels/${channelId}/attachments`;

        let attachmentError = "";
        try {
            const response = await common.RestAPI.post({
                url: messageUrl,
                body: { content: "must never be sent", attachments: [{ id: "0" }] },
            });
            const messageId = response?.body?.id;
            if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
        } catch (error) {
            attachmentError = String(error);
        }
        const editError = await common.RestAPI.patch({
            url: editUrl,
            body: { content: "must never be edited" },
        }).then(() => "", (error: unknown) => String(error));
        let prefixedPayloadError = "";
        try {
            const response = await common.RestAPI.post({
                url: messageUrl,
                body: { content: "PCEM1:not-encrypted-plaintext", attachments: [] },
            });
            const messageId = response?.body?.id;
            if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
        } catch (error) {
            prefixedPayloadError = String(error);
        }
        let attachmentReservationError = "";
        try {
            const response = await common.RestAPI.post({
                url: attachmentReservationUrl,
                body: {
                    content: "must never reach an attachment reservation",
                    files: [{ filename: "blocked.txt", file_size: 1, id: "0" }],
                },
            });
            const messageId = response?.body?.id;
            if (typeof messageId === "string") (global[registryName] ??= []).push(messageId);
        } catch (error) {
            attachmentReservationError = String(error);
        }

        return {
            attachmentBlocked: /blocked a malformed or unsupported programmatic send/iu.test(attachmentError),
            attachmentReservationBlocked: /blocked an unauthorized attachment upload reservation/iu.test(attachmentReservationError),
            editBlocked: /blocked a programmatic edit/iu.test(editError),
            prefixedPayloadBlocked: /blocked an unauthorized prefixed programmatic payload/iu.test(prefixedPayloadError),
        };
    }, { channelId: TEST_CHANNEL_ID, registryName: PAGE_MESSAGE_REGISTRY });
}

async function prepareThroughRuntimeMessageEvents(page: Page, plaintext: string): Promise<{
    cancelled: boolean;
    content: string;
    plaintextWasTransformed: boolean;
}> {
    return page.evaluate(async ({ channelId, plaintext }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageEvents = global.Vencord.Api?.MessageEvents;
        if (typeof messageEvents?._handlePreSend !== "function")
            throw new Error("The runtime MessageEvents pre-send dispatcher is unavailable");
        const channel = common.ChannelStore.getChannel(channelId);
        if (!channel) throw new Error("The authorized test channel is not loaded");

        const message = {
            content: plaintext,
            invalidEmojis: [],
            tts: false,
            validNonShortcutEmojis: [],
        };
        const contentOptions = {
            channelId,
            command: null,
            content: plaintext,
            isGif: false,
            stickers: [],
            uploads: [],
        };
        const options = {
            ...contentOptions,
            allowedMentions: { parse: [], repliedUser: false },
            location: "SecureMessaging live harness",
            stickerIds: [],
        };
        const props = {
            channel,
            content: plaintext,
            hasAttachments: false,
            hasStickers: false,
            openWarningPopout: null,
        };
        const cancelled = await messageEvents._handlePreSend(channelId, message, options, props, contentOptions);
        return {
            cancelled: Boolean(cancelled),
            content: message.content,
            plaintextWasTransformed: message.content !== plaintext && message.content.startsWith("PCEM1:"),
        };
    }, { channelId: TEST_CHANNEL_ID, plaintext });
}

async function sendAuthorizedRuntimePayload(page: Page, content: string): Promise<{
    attachmentBearingPayloadBlocked: boolean;
    message: RawDiscordMessage;
    oneShotReplayBlocked: boolean;
}> {
    return page.evaluate(async ({ channelId, content, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const url = common.Constants.Endpoints.MESSAGES(channelId);
        const baseBody = {
            allowed_mentions: { parse: [], replied_user: false },
            channel_id: channelId,
            content,
            nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
            sticker_ids: [],
            type: 0,
        };

        let attachmentError = "";
        try {
            const unexpected = await common.RestAPI.post({
                url,
                body: { ...baseBody, attachments: [{ filename: "blocked.txt", id: "0" }] },
            });
            const unexpectedId = unexpected?.body?.id;
            if (typeof unexpectedId === "string") (global[registryName] ??= []).push(unexpectedId);
        } catch (error) {
            attachmentError = String(error);
        }

        const response = await common.RestAPI.post({ url, body: { ...baseBody, attachments: [] } });
        const message = response.body;
        if (!message?.id) throw new Error("Discord REST did not return the authorized runtime-listener message");
        (global[registryName] ??= []).push(String(message.id));

        let replayError = "";
        try {
            const unexpected = await common.RestAPI.post({
                url,
                body: {
                    ...baseBody,
                    attachments: [],
                    nonce: common.SnowflakeUtils.fromTimestamp(Date.now() + 1),
                },
            });
            const unexpectedId = unexpected?.body?.id;
            if (typeof unexpectedId === "string") (global[registryName] ??= []).push(unexpectedId);
        } catch (error) {
            replayError = String(error);
        }

        return {
            attachmentBearingPayloadBlocked: /blocked an unauthorized prefixed programmatic payload/iu.test(attachmentError),
            message: {
                attachments: [],
                authorId: String(message.author.id),
                channelId: String(message.channel_id),
                content: String(message.content),
                editedTimestamp: typeof message.edited_timestamp === "string" ? message.edited_timestamp : null,
                id: String(message.id),
            },
            oneShotReplayBlocked: /blocked an unauthorized prefixed programmatic payload/iu.test(replayError),
        };
    }, { channelId: TEST_CHANNEL_ID, content, registryName: PAGE_MESSAGE_REGISTRY });
}

async function sendAuthorizedRuntimeReply(page: Page, content: string, referencedMessageId: string): Promise<RawDiscordMessage> {
    return page.evaluate(async ({ channelId, content, referencedMessageId, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const response = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [], replied_user: false },
                attachments: [],
                channel_id: channelId,
                content,
                message_reference: {
                    channel_id: channelId,
                    message_id: referencedMessageId,
                },
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        const message = response.body;
        if (!message?.id) throw new Error("Discord REST did not return the authorized encrypted reply");
        (global[registryName] ??= []).push(String(message.id));
        return {
            attachments: [],
            authorId: String(message.author.id),
            channelId: String(message.channel_id),
            content: String(message.content),
            editedTimestamp: typeof message.edited_timestamp === "string" ? message.edited_timestamp : null,
            id: String(message.id),
        };
    }, { channelId: TEST_CHANNEL_ID, content, referencedMessageId, registryName: PAGE_MESSAGE_REGISTRY });
}

async function sendEncryptedAttachmentThroughRuntime(page: Page, plaintext: string): Promise<{
    ciphertextHidFileBytes: boolean;
    ciphertextHidFilename: boolean;
    eagerPlaintextUploadDeferred: boolean;
    encryptedFilename: string;
    message: RawDiscordMessage;
    plaintextWasTransformed: boolean;
    wireContentLength: number;
}> {
    return page.evaluate(async ({ channelId, filename, plaintext, pngBase64, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const messageEvents = global.Vencord.Api?.MessageEvents;
        if (typeof messageEvents?._handlePreSend !== "function")
            throw new Error("The runtime MessageEvents pre-send dispatcher is unavailable");
        const channel = common.ChannelStore.getChannel(channelId);
        if (!channel) throw new Error("The authorized test channel is not loaded");

        const pngBytes = Uint8Array.from(atob(pngBase64), value => value.charCodeAt(0));
        const file = new File([pngBytes], filename, { type: "image/png" });
        const upload = new common.CloudUploader({ file, platform: 1 }, channelId);
        await upload.upload();
        const eagerPlaintextUploadDeferred = upload.status === "NOT_STARTED" &&
            upload.uploadedFilename == null && upload.responseUrl == null;
        if (!eagerPlaintextUploadDeferred)
            throw new Error("Secure Messaging did not defer Discord's eager plaintext attachment upload");
        const message = {
            content: plaintext,
            invalidEmojis: [],
            tts: false,
            validNonShortcutEmojis: [],
        };
        const contentOptions = {
            channelId,
            command: null,
            content: plaintext,
            isGif: false,
            stickers: [],
            uploads: [upload],
        };
        const options = {
            ...contentOptions,
            allowedMentions: { parse: [], repliedUser: false },
            location: "SecureMessaging encrypted-attachment live harness",
            stickerIds: [],
        };
        const props = {
            channel,
            content: plaintext,
            hasAttachments: true,
            hasStickers: false,
            openWarningPopout: null,
        };
        const cancelled = await messageEvents._handlePreSend(channelId, message, options, props, contentOptions);
        if (cancelled) throw new Error("Secure Messaging cancelled a valid encrypted attachment send");
        if (!message.content.startsWith("PCEM1:") || message.content.includes(plaintext))
            throw new Error("Secure Messaging did not transform attachment-message plaintext before upload");
        if (!(upload.item.file instanceof File) || !upload.filename.endsWith(".pcaf") || upload.item.file.type !== "application/octet-stream")
            throw new Error("Secure Messaging did not replace the pending file with an opaque encrypted upload");

        const ciphertext = new Uint8Array(await upload.item.file.arrayBuffer());
        let ciphertextHidFileBytes = true;
        outer: for (let offset = 0; offset <= ciphertext.length - pngBytes.length; offset++) {
            for (let index = 0; index < pngBytes.length; index++) {
                if (ciphertext[offset + index] !== pngBytes[index]) continue outer;
                }
            ciphertextHidFileBytes = false;
            break;
        }
        const ciphertextHidFilename = !new TextDecoder().decode(ciphertext).includes(filename);

        await new Promise<void>((resolve, reject) => {
            upload.on("complete", resolve);
            upload.on("error", (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
            try {
                upload.upload();
            } catch (error) {
                reject(error);
            }
        });
        if (typeof upload.uploadedFilename !== "string" || upload.uploadedFilename.length === 0)
            throw new Error("Discord did not return an encrypted attachment upload token");

        const response = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [], replied_user: false },
                attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
                channel_id: channelId,
                content: message.content,
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        const sent = response.body;
        if (!sent?.id || !Array.isArray(sent.attachments) || sent.attachments.length !== 1)
            throw new Error("Discord REST did not return the encrypted attachment message");
        (global[registryName] ??= []).push(String(sent.id));

        return {
            ciphertextHidFileBytes,
            ciphertextHidFilename,
            eagerPlaintextUploadDeferred,
            encryptedFilename: String(upload.filename),
            message: {
                attachments: sent.attachments.map((attachment: any) => ({
                    contentType: typeof attachment.content_type === "string" ? attachment.content_type : null,
                    filename: String(attachment.filename),
                    id: String(attachment.id),
                    proxyUrl: String(attachment.proxy_url),
                    size: Number(attachment.size),
                    url: String(attachment.url),
                })),
                authorId: String(sent.author.id),
                channelId: String(sent.channel_id),
                content: String(sent.content),
                editedTimestamp: typeof sent.edited_timestamp === "string" ? sent.edited_timestamp : null,
                id: String(sent.id),
            },
            plaintextWasTransformed: message.content !== plaintext,
            wireContentLength: message.content.length,
        };
    }, {
        channelId: TEST_CHANNEL_ID,
        filename: PROOF_PNG_FILENAME,
        plaintext,
        pngBase64: PROOF_PNG_BASE64,
        registryName: PAGE_MESSAGE_REGISTRY,
    });
}

async function sendThroughRestGuard(page: Page, plaintext: string): Promise<RawDiscordMessage> {
    return page.evaluate(async ({ channelId, plaintext, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const response = await common.RestAPI.post({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            body: {
                allowed_mentions: { parse: [], replied_user: false },
                attachments: [],
                channel_id: channelId,
                content: plaintext,
                nonce: common.SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
            },
        });
        const message = response.body;
        if (!message?.id) throw new Error("Discord REST did not return the sent message");
        (global[registryName] ??= []).push(String(message.id));
        return {
            attachments: [],
            authorId: String(message.author.id),
            channelId: String(message.channel_id),
            content: String(message.content),
            editedTimestamp: typeof message.edited_timestamp === "string" ? message.edited_timestamp : null,
            id: String(message.id),
        };
    }, { channelId: TEST_CHANNEL_ID, plaintext, registryName: PAGE_MESSAGE_REGISTRY });
}

async function verifyRenderedMessage(page: Page, message: RawDiscordMessage, plaintext: string) {
    await page.waitForFunction(({ channelId, messageId, plaintext }) => {
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        return item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext);
    }, { timeout: 30_000 }, { channelId: message.channelId, messageId: message.id, plaintext });

    return page.evaluate(({ channelId, messageId, plaintext }) => {
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const rawContent = item?.querySelector<HTMLElement>("[class*='messageContent']");
        const plaintextCard = item?.querySelector<HTMLElement>(".pc-secure-card-plaintext");
        return {
            plaintextVisible: plaintextCard?.textContent?.includes(plaintext) ?? false,
            rawCiphertextHidden: rawContent ? getComputedStyle(rawContent).display === "none" : false,
            verifiedHeader: item?.querySelector(".pc-secure-card-header")?.textContent?.includes("Verified encrypted message") ?? false,
        };
    }, { channelId: message.channelId, messageId: message.id, plaintext });
}

async function verifyRenderedEncryptedAttachment(page: Page, message: RawDiscordMessage, plaintext: string) {
    try {
        await page.waitForFunction(({ channelId, messageId, plaintext }) => {
            const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
            const image = item?.querySelector<HTMLImageElement>("img[src^='blob:']");
            return item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext) &&
                image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
        }, { timeout: 20_000 }, { channelId: message.channelId, messageId: message.id, plaintext });
    } catch {
        // The structured diagnostic below is more useful than Puppeteer's generic timeout.
    }

    const proof = await page.evaluate(({ channelId, encryptedFilename, messageId, plaintext }) => {
        const global = globalThis as any;
        const item = document.getElementById(`chat-messages-${channelId}-${messageId}`);
        const image = item?.querySelector<HTMLImageElement>("img[src^='blob:']");
        const storedMessage = global.Vencord?.Webpack?.Common?.MessageStore?.getMessage?.(channelId, messageId);
        const projectedMessage = storedMessage
            ? global.Vencord?.Plugins?.plugins?.SecureMessaging?.patchEncryptedAttachments?.(storedMessage, { forceUpdate() { } })
            : null;
        let imageObscured = false;
        for (let ancestor: HTMLElement | null = image?.parentElement ?? null; ancestor && ancestor !== item; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.filter.includes("brightness(0)") || ancestor.className.includes("hiddenExplicit")) {
                imageObscured = true;
                break;
            }
        }
        return {
            html: item?.innerHTML.slice(0, 8_000) ?? "",
            images: [...(item?.querySelectorAll<HTMLImageElement>("img") ?? [])].map(candidate => ({
                complete: candidate.complete,
                height: candidate.naturalHeight,
                src: candidate.src.slice(0, 200),
                width: candidate.naturalWidth,
            })),
            imageHeight: image?.naturalHeight ?? 0,
            imageObscured,
            imageUsesLocalAuthenticatedUrl: image?.src.startsWith("blob:") ?? false,
            imageWidth: image?.naturalWidth ?? 0,
            localContentScanVersion: projectedMessage?.attachments?.[0]?.content_scan_version ?? null,
            plaintextVisible: item?.querySelector(".pc-secure-card-plaintext")?.textContent?.includes(plaintext) ?? false,
            rawEncryptedFilenameHidden: !(item?.textContent ?? "").includes(encryptedFilename),
            text: item?.textContent?.slice(0, 2_000) ?? "",
        };
    }, {
        channelId: message.channelId,
        encryptedFilename: message.attachments[0]?.filename ?? "",
        messageId: message.id,
        plaintext,
    });
    if (!proof.imageUsesLocalAuthenticatedUrl || proof.imageWidth < 1 || proof.imageHeight < 1)
        throw new Error(`Encrypted attachment native-render diagnostic: ${JSON.stringify(proof)}`);
    return proof;
}

async function verifyNativeRejectionPaths(page: Page, message: RawDiscordMessage, plaintext: string) {
    return page.evaluate(async ({ message, plaintext }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser().id;
        const alternativeLastDigit = message.id.endsWith("9") ? "8" : "9";
        const replacementMessageId = `${message.id.slice(0, -1)}${alternativeLastDigit}`;
        const tamperedLastCharacter = message.content.endsWith("A") ? "B" : "A";
        const tamperedContent = `${message.content.slice(0, -1)}${tamperedLastCharacter}`;

        const exactRerender = await native.decryptIncoming(localUserId, {
            channelId: message.channelId,
            content: message.content,
            discordAuthorId: message.authorId,
            discordEditedTimestamp: message.editedTimestamp,
            discordMessageId: message.id,
        });
        const senderIdReplacement = await native.decryptIncoming(localUserId, {
            channelId: message.channelId,
            content: message.content,
            discordAuthorId: message.authorId,
            discordEditedTimestamp: message.editedTimestamp,
            discordMessageId: replacementMessageId,
        });
        const tampered = await native.decryptIncoming(localUserId, {
            channelId: message.channelId,
            content: tamperedContent,
            discordAuthorId: message.authorId,
            discordEditedTimestamp: message.editedTimestamp,
            discordMessageId: `${message.id.slice(0, -2)}77`,
        });

        return {
            exactPlaintext: exactRerender.status === "decrypted" ? exactRerender.plaintext : "",
            exactStatus: exactRerender.status,
            senderIdReplacementStatus: senderIdReplacement.status,
            tamperedStatus: tampered.status,
            expectedPlaintext: plaintext,
        };
    }, { message, plaintext });
}

async function collectRegisteredMessageIds(page: Page): Promise<string[]> {
    return page.evaluate(registryName => {
        const registry = (globalThis as any)[registryName];
        return Array.isArray(registry) ? registry.filter((value: unknown) => typeof value === "string") : [];
    }, PAGE_MESSAGE_REGISTRY);
}

async function deleteOwnTestMessages(page: Page, messageIds: string[]): Promise<boolean> {
    if (messageIds.length === 0) return true;
    return page.evaluate(async ({ channelId, messageIds, registryName }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const deletionErrors: string[] = [];
        for (const messageId of messageIds) {
            try {
                await common.RestAPI.del({ url: common.Constants.Endpoints.MESSAGE(channelId, messageId) });
            } catch (error) {
                deletionErrors.push(`${messageId}: ${String(error)}`);
            }
        }
        const response = await common.RestAPI.get({
            url: common.Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100 },
        });
        const remainingIds = new Set((response.body ?? []).map((message: any) => String(message.id)));
        const remainingTestIds = messageIds.filter(messageId => remainingIds.has(messageId));
        global[registryName] = remainingTestIds;
        if (deletionErrors.length > 0)
            throw new Error(`SecureMessaging live-message cleanup failed: ${deletionErrors.join("; ")}`);
        return remainingTestIds.length === 0;
    }, { channelId: TEST_CHANNEL_ID, messageIds, registryName: PAGE_MESSAGE_REGISTRY });
}

async function disableSyntheticConversation(page: Page) {
    return page.evaluate(async ({ channelId, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user during conversation cleanup");
        return native.configureConversation(localUserId, {
            enabled: false,
            selectedRecipientIds: [],
            snapshot: { channelId, kind: "DM", participantUserIds: [recipientId] },
        });
    }, { channelId: TEST_CHANNEL_ID, recipientId: EXPECTED_RECIPIENT_ID });
}

async function forgetSyntheticRecipient(page: Page) {
    return page.evaluate(async recipientId => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user during trust cleanup");
        return native.forgetPeer(localUserId, recipientId);
    }, EXPECTED_RECIPIENT_ID);
}

async function inspectCleanSyntheticState(page: Page, expectedConversationStatus: "disabled" | "unconfigured") {
    return page.evaluate(async ({ channelId, expectedConversationStatus, recipientId }) => {
        const global = globalThis as any;
        const common = global.Vencord.Webpack.Common;
        const native = global.VencordNative.pluginHelpers.SecureMessaging;
        const localUserId = common.UserStore.getCurrentUser()?.id;
        if (!localUserId) throw new Error("Discord has no authenticated user during cleanup verification");
        const snapshot = { channelId, kind: "DM", participantUserIds: [recipientId] };
        const [conversation, channelProtection] = await Promise.all([
            native.getConversation(localUserId, snapshot),
            native.getChannelProtection(localUserId, channelId),
        ]);
        return {
            channelProtectionStatus: channelProtection.status,
            conversationStatus: conversation.status,
            expectedConversationStatus,
            participantStatus: conversation.participants?.[0]?.status ?? "missing",
            selectedRecipientIds: conversation.selectedRecipientIds ?? [],
        };
    }, { channelId: TEST_CHANNEL_ID, expectedConversationStatus, recipientId: EXPECTED_RECIPIENT_ID });
}

async function stopSecureMessagingPlugin(page: Page) {
    return page.evaluate(async () => {
        const vencord = (globalThis as any).Vencord;
        const plugin = vencord?.Plugins?.plugins?.SecureMessaging;
        if (!plugin) throw new Error("SecureMessaging is unavailable during plugin cleanup");
        if (!plugin.started) throw new Error("SecureMessaging stopped unexpectedly before cleanup");
        const stopResult = await Promise.resolve(vencord.Plugins.stopPlugin(plugin));
        return { pluginStopped: !plugin.started, stopResult };
    });
}

async function main(): Promise<void> {
    const expectedDataDir = requireDisposableDataDirectory();
    const pluginPrestarted = process.env[PRESTARTED_PLUGIN_ENV] === "1";
    if (!pluginPrestarted) await assertNoExistingSecureMessagingVault(expectedDataDir);
    const temporaryRecipient = await generateIdentity();
    const recipientAnnouncement = await createKeyAnnouncement(temporaryRecipient, EXPECTED_RECIPIENT_ID);
    const recipientPublicIdentity = await verifyKeyAnnouncement(recipientAnnouncement, EXPECTED_RECIPIENT_ID);
    const browser = await connectWithRetry();
    const sentMessageIds = new Set<string>();
    const cleanupErrors: Error[] = [];
    let cleanupProof: CleanupProof | undefined;
    let page: Page | undefined;
    let primaryError: unknown;
    let syntheticConversationCreated = false;
    let syntheticTrustCreated = false;
    let pluginStartedByHarness = false;
    let report: Record<string, unknown> | undefined;

    try {
        page = await getDiscordPage(await browser.pages());
        await assertConnectedClientUsesDisposableDataDir(page, expectedDataDir);
        await assertSecureMessagingInitialState(page, pluginPrestarted);
        await page.goto(`https://discord.com/channels/@me/${TEST_CHANNEL_ID}`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        await page.waitForFunction(
            () => Boolean((globalThis as any).Vencord?.Webpack?.Common?.UserStore?.getCurrentUser?.()),
            { timeout: 30_000 },
        );
        await assertMessageEventsSendPatch(page);
        await initializeMessageRegistry(page);

        const preflight = await preflightPristineState(page, recipientAnnouncement, pluginPrestarted);
        assert.equal(preflight.vaultReady, true);
        assert.equal(preflight.reviewedRecipientFingerprint, recipientPublicIdentity.fingerprint);
        const localPublicIdentity = await verifyKeyAnnouncement(preflight.localAnnouncement, preflight.localUserId);
        assert.equal(localPublicIdentity.fingerprint, preflight.localFingerprint);

        const trust = await trustSyntheticRecipient(
            page,
            preflight.recipientReviewToken,
            preflight.reviewedRecipientFingerprint,
        );
        syntheticTrustCreated = trust.status === "trusted";
        assert.equal(
            trust.status,
            "trusted",
            `the disposable recipient must be newly trusted, never reused or auto-forgotten (received ${trust.status})`,
        );

        const configured = await configureSyntheticConversation(page);
        syntheticConversationCreated = configured.status === "enabled";
        assert.equal(configured.status, "enabled", `protected DM configuration failed: ${configured.status}`);
        assert.deepEqual(configured.selectedRecipientIds, [EXPECTED_RECIPIENT_ID]);

        const pluginStart = pluginPrestarted
            ? { pluginStarted: true, startResult: "enabled before Discord loaded so webpack attachment patches were installed" }
            : await startSecureMessagingPlugin(page);
        pluginStartedByHarness = !pluginPrestarted && pluginStart.pluginStarted;
        assert.equal(pluginStart.pluginStarted, true, `SecureMessaging failed to start: ${String(pluginStart.startResult)}`);
        const screenCaptureProtection = await waitForScreenCaptureProtection(page);
        assert.equal(screenCaptureProtection, "ready", "screen-capture protection must be active before any decryption or protected send");

        const persistedProof = await assertPersistedProtectionAndMissingChannelFailClosed(page);
        assert.equal(persistedProof.persistedStatus, "protected", "native persisted protection lookup must identify the test DM");
        assert.equal(persistedProof.safelyMocked, true, "ChannelStore must be safely mockable for the missing-snapshot proof");
        assert.equal(persistedProof.missingChannelBlocked, true, "a protected persisted channel must fail closed without ChannelStore");
        assert.equal(persistedProof.channelStoreRestored, true, "ChannelStore.getChannel must be restored after the fail-closed proof");

        const failClosed = await assertFailClosedBoundaries(page);
        assert.equal(failClosed.attachmentBlocked, true, "protected attachments must fail before reaching Discord");
        assert.equal(failClosed.attachmentReservationBlocked, true, "attachment upload slots must be blocked before file bytes reach Discord");
        assert.equal(failClosed.editBlocked, true, "protected edits must fail before reaching Discord");
        assert.equal(failClosed.prefixedPayloadBlocked, true, "a fake encrypted-message prefix must not bypass the REST guard");

        const runtimePlaintext = `Secure Messaging runtime-listener proof ${crypto.randomUUID()} α`;
        const runtimePrepared = await prepareThroughRuntimeMessageEvents(page, runtimePlaintext);
        assert.equal(runtimePrepared.cancelled, false, "the secure listener should stop later listeners without cancelling valid text");
        assert.equal(runtimePrepared.plaintextWasTransformed, true, "the runtime MessageEvents listener must transform plaintext before REST");
        assert.ok(runtimePrepared.content.startsWith(ENCRYPTED_PREFIX));
        assert.equal(runtimePrepared.content.includes(runtimePlaintext), false);

        const runtimeProof = await sendAuthorizedRuntimePayload(page, runtimePrepared.content);
        sentMessageIds.add(runtimeProof.message.id);
        assert.equal(
            runtimeProof.attachmentBearingPayloadBlocked,
            true,
            "an encrypted text authorization must not authorize a different attachment-bearing payload",
        );
        assert.equal(
            runtimeProof.oneShotReplayBlocked,
            true,
            "attachment rejection must preserve authorization for one clean send, and that send must consume it",
        );
        assert.equal(runtimeProof.message.authorId, preflight.localUserId);
        assert.equal(runtimeProof.message.channelId, TEST_CHANNEL_ID);
        assert.equal(
            runtimeProof.message.content,
            runtimePrepared.content,
            "REST must pass the runtime listener's authorized ciphertext exactly instead of encrypting plaintext itself",
        );
        const runtimeDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: runtimeProof.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(runtimeDecrypted.plaintext, runtimePlaintext, "the selected recipient must decrypt the runtime-listener send exactly");

        const replyPlaintext = `Secure Messaging encrypted-reply proof ${crypto.randomUUID()} δ`;
        const preparedReply = await prepareThroughRuntimeMessageEvents(page, replyPlaintext);
        assert.equal(preparedReply.cancelled, false, "the secure listener must accept an ordinary reply");
        assert.equal(preparedReply.plaintextWasTransformed, true, "reply text must be encrypted before REST");
        const replyMessage = await sendAuthorizedRuntimeReply(page, preparedReply.content, runtimeProof.message.id);
        sentMessageIds.add(replyMessage.id);
        const recipientReply = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: replyMessage.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(recipientReply.plaintext, replyPlaintext, "the selected recipient must decrypt the reply exactly");

        const attachmentPlaintext = `Secure Messaging encrypted-attachment proof ${crypto.randomUUID()} γ`;
        const attachmentSend = await sendEncryptedAttachmentThroughRuntime(page, attachmentPlaintext);
        sentMessageIds.add(attachmentSend.message.id);
        assert.equal(attachmentSend.plaintextWasTransformed, true, "attachment-message plaintext must be encrypted before upload");
        assert.equal(attachmentSend.eagerPlaintextUploadDeferred, true, "Discord's eager plaintext upload must be deferred until send encryption");
        assert.equal(attachmentSend.ciphertextHidFileBytes, true, "the opaque Discord upload must not contain the original PNG bytes");
        assert.equal(attachmentSend.ciphertextHidFilename, true, "the opaque Discord upload must not expose the original filename");
        assert.match(attachmentSend.encryptedFilename, /^pc-[A-Za-z0-9_-]{22}-0\.pcaf$/u);
        assert.equal(attachmentSend.message.attachments.length, 1);
        assert.equal(attachmentSend.message.attachments[0].filename, attachmentSend.encryptedFilename);
        assert.ok(
            attachmentSend.message.attachments[0].contentType === null ||
                attachmentSend.message.attachments[0].contentType === "application/octet-stream",
            "Discord must not classify the stored ciphertext as the original image type",
        );
        assert.equal(attachmentSend.message.content.includes(PROOF_PNG_FILENAME), false);
        assert.equal(attachmentSend.message.content.includes(attachmentPlaintext), false);

        const recipientAttachmentEnvelope = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: attachmentSend.message.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        const recipientAttachmentPlaintext = parseSecurePlaintext(recipientAttachmentEnvelope.plaintext);
        assert.equal(recipientAttachmentPlaintext.text, attachmentPlaintext);
        assert.ok(recipientAttachmentPlaintext.attachments, "the selected recipient must receive the encrypted attachment descriptor");
        const rawAttachmentResponse = await fetch(attachmentSend.message.attachments[0].url);
        assert.equal(rawAttachmentResponse.ok, true, "Discord must return the stored encrypted attachment bytes");
        const rawAttachmentBytes = new Uint8Array(await rawAttachmentResponse.arrayBuffer());
        assert.equal(rawAttachmentBytes.byteLength, attachmentSend.message.attachments[0].size);
        assert.equal(
            await attachmentBundleRoot(recipientAttachmentPlaintext.attachments.id, [rawAttachmentBytes]),
            recipientAttachmentPlaintext.attachments.root,
            "the selected recipient must authenticate the exact ordered Discord attachment set",
        );
        const recipientAttachmentMasterKey = decodeBase64Url(recipientAttachmentPlaintext.attachments.key, 32);
        const recipientAttachment = await decryptAttachmentBytes({
            bundleId: recipientAttachmentPlaintext.attachments.id,
            channelId: TEST_CHANNEL_ID,
            ciphertext: rawAttachmentBytes,
            count: recipientAttachmentPlaintext.attachments.count,
            index: 0,
            masterKey: recipientAttachmentMasterKey,
            senderUserId: preflight.localUserId,
        });
        recipientAttachmentMasterKey.fill(0);
        assert.equal(recipientAttachment.metadata.name, PROOF_PNG_FILENAME);
        assert.equal(recipientAttachment.metadata.mimeType, "image/png");
        assert.equal(recipientAttachment.metadata.width, 2);
        assert.equal(recipientAttachment.metadata.height, 3);
        assert.equal(Buffer.from(recipientAttachment.data).toString("base64"), PROOF_PNG_BASE64);

        const restPlaintext = `Secure Messaging REST-guard proof ${crypto.randomUUID()} β`;
        const restMessage = await sendThroughRestGuard(page, restPlaintext);
        sentMessageIds.add(restMessage.id);
        assert.equal(restMessage.authorId, preflight.localUserId);
        assert.equal(restMessage.channelId, TEST_CHANNEL_ID);
        assert.ok(restMessage.content.startsWith(ENCRYPTED_PREFIX), "programmatic send must store ciphertext on Discord");
        assert.equal(restMessage.content.includes(restPlaintext), false, "programmatic plaintext must not be present in Discord's stored content");
        const restDecrypted = await decryptMessage({
            channelId: TEST_CHANNEL_ID,
            content: restMessage.content,
            discordAuthorId: preflight.localUserId,
            identity: temporaryRecipient,
            localUserId: EXPECTED_RECIPIENT_ID,
            senderIdentity: localPublicIdentity,
        });
        assert.equal(restDecrypted.plaintext, restPlaintext, "the selected recipient must decrypt the guarded REST send exactly");

        const renderProof = await verifyRenderedMessage(page, runtimeProof.message, runtimePlaintext);
        assert.equal(renderProof.plaintextVisible, true, "locally decrypted plaintext must render");
        assert.equal(renderProof.rawCiphertextHidden, true, "raw Discord ciphertext must be hidden in the message row");
        assert.equal(renderProof.verifiedHeader, true, "rendered message must identify authenticated encrypted content");

        const replyPreviewProof = await verifyRenderedReplyPreview(
            page,
            replyMessage,
            runtimeProof.message.content,
            runtimePlaintext,
        );
        assert.equal(replyPreviewProof.plaintextVisible, true, "an encrypted reply preview must show the referenced plaintext");
        assert.equal(replyPreviewProof.ciphertextHidden, true, "an encrypted reply preview must never show the referenced ciphertext envelope");

        const attachmentRenderProof = await verifyRenderedEncryptedAttachment(page, attachmentSend.message, attachmentPlaintext);
        assert.equal(attachmentRenderProof.plaintextVisible, true, "encrypted attachment text must render locally");
        assert.equal(attachmentRenderProof.imageUsesLocalAuthenticatedUrl, true, "Discord's native renderer must receive a local authenticated blob URL");
        assert.equal(attachmentRenderProof.imageWidth, 2, "Discord's native image renderer must decode the original width");
        assert.equal(attachmentRenderProof.imageHeight, 3, "Discord's native image renderer must decode the original height");
        assert.equal(attachmentRenderProof.imageObscured, false, "decrypted E2EE media must not be mistaken for a pending Discord content scan");
        assert.equal(attachmentRenderProof.localContentScanVersion, -1, "decrypted E2EE media must carry Discord's local unscanned sentinel");
        assert.equal(attachmentRenderProof.rawEncryptedFilenameHidden, true, "the opaque Discord filename must not be shown to the user");

        const screenshotModeProof = await verifyScreenshotMode(page, attachmentSend.message, attachmentPlaintext);
        assert.equal(screenshotModeProof.rootCaptureClassApplied, true, "screenshot mode must apply its capture-safe root class before releasing OS protection");
        assert.equal(screenshotModeProof.plaintextHidden, true, "screenshot mode must hide decrypted text");
        assert.equal(screenshotModeProof.attachmentPixelsHidden, true, "screenshot mode must hide decrypted attachment pixels");
        assert.equal(screenshotModeProof.encryptedPlaceholderVisible, true, "screenshot mode must leave a clear protected placeholder");
        assert.equal(await waitForScreenCaptureProtection(page), "ready", "screen-capture protection must restore after the screenshot-mode proof");

        const rejectionProof = await verifyNativeRejectionPaths(page, runtimeProof.message, runtimePlaintext);
        assert.equal(rejectionProof.exactStatus, "decrypted", "an exact React rerender must remain idempotent");
        assert.equal(rejectionProof.exactPlaintext, rejectionProof.expectedPlaintext);
        assert.equal(
            rejectionProof.senderIdReplacementStatus,
            "decrypted",
            "the sender must still render ciphertext after Discord replaces its optimistic message ID",
        );
        assert.equal(rejectionProof.tamperedStatus, "invalid_message", "tampered ciphertext must be rejected");

        report = {
            attachmentBlocked: failClosed.attachmentBlocked,
            attachmentReservationBlocked: failClosed.attachmentReservationBlocked,
            encryptedAttachment: {
                ciphertextHidFileBytes: attachmentSend.ciphertextHidFileBytes,
                ciphertextHidFilename: attachmentSend.ciphertextHidFilename,
                decryptedBySelectedRecipient: recipientAttachment.metadata.name === PROOF_PNG_FILENAME,
                eagerPlaintextUploadDeferred: attachmentSend.eagerPlaintextUploadDeferred,
                nativeImageHeight: attachmentRenderProof.imageHeight,
                nativeImageObscured: attachmentRenderProof.imageObscured,
                nativeImageRendererUsed: attachmentRenderProof.imageUsesLocalAuthenticatedUrl,
                nativeImageWidth: attachmentRenderProof.imageWidth,
                localContentScanVersion: attachmentRenderProof.localContentScanVersion,
                originalFilenameRestored: recipientAttachment.metadata.name,
                rawEncryptedFilenameHidden: attachmentRenderProof.rawEncryptedFilenameHidden,
                wireContentLength: attachmentSend.wireContentLength,
            },
            authorizedAttachmentBlockedBeforeCapabilityConsumption: runtimeProof.attachmentBearingPayloadBlocked,
            editBlocked: failClosed.editBlocked,
            localIdentityFingerprintMatched: true,
            missingChannelStoreFailedClosed: persistedProof.missingChannelBlocked,
            nativeTamperRejected: rejectionProof.tamperedStatus === "invalid_message",
            oneShotAuthorizationConsumed: runtimeProof.oneShotReplayBlocked,
            persistedNativeProtectionLookup: persistedProof.persistedStatus,
            pluginStarted: pluginStart.pluginStarted,
            prefixedPayloadBypassBlocked: failClosed.prefixedPayloadBlocked,
            rawCiphertextHidden: renderProof.rawCiphertextHidden,
            rendererPlaintextVerified: renderProof.plaintextVisible && renderProof.verifiedHeader,
            replyPreview: replyPreviewProof,
            senderIdReplacementAccepted: rejectionProof.senderIdReplacementStatus === "decrypted",
            screenCaptureProtection,
            screenshotMode: screenshotModeProof,
            restGuard: {
                decryptedBySelectedRecipient: restDecrypted.plaintext === restPlaintext,
                messageId: restMessage.id,
                plaintextAbsentFromWire: !restMessage.content.includes(restPlaintext),
                wirePrefix: restMessage.content.slice(0, ENCRYPTED_PREFIX.length),
            },
            runtimeMessageEvents: {
                decryptedBySelectedRecipient: runtimeDecrypted.plaintext === runtimePlaintext,
                exactListenerCiphertextReachedDiscord: runtimeProof.message.content === runtimePrepared.content,
                messageId: runtimeProof.message.id,
                plaintextTransformedBeforeRest: runtimePrepared.plaintextWasTransformed,
                wirePrefix: runtimeProof.message.content.slice(0, ENCRYPTED_PREFIX.length),
            },
            temporaryRecipientFingerprintMatched: true,
            vaultReady: preflight.vaultReady,
        };
    } catch (error) {
        primaryError = error;
    }

    const captureCleanup = async (name: string, action: () => Promise<void>): Promise<void> => {
        try {
            await action();
        } catch (error) {
            cleanupErrors.push(asError(error, name));
        }
    };

    let allKnownMessageIds = [...sentMessageIds];
    if (page) {
        await captureCleanup("collecting the live-message cleanup registry", async () => {
            allKnownMessageIds = [...new Set([...allKnownMessageIds, ...await collectRegisteredMessageIds(page!)])];
        });
        await captureCleanup("deleting and verifying all live-proof messages", async () => {
            const deleted = await deleteOwnTestMessages(page!, allKnownMessageIds);
            assert.equal(deleted, true, "all live-proof messages must be absent after deletion");
        });

        if (syntheticConversationCreated) {
            await captureCleanup("disabling the synthetic conversation configuration", async () => {
                const disabled = await disableSyntheticConversation(page!);
                assert.equal(disabled.status, "disabled", `conversation cleanup returned ${disabled.status}`);
                assert.deepEqual(disabled.selectedRecipientIds, [], "cleanup must remove every synthetic recipient selection");
            });
        }
        if (syntheticTrustCreated) {
            await captureCleanup("forgetting the newly-created synthetic peer trust", async () => {
                const forgotten = await forgetSyntheticRecipient(page!);
                assert.equal(
                    forgotten.status,
                    "forgotten",
                    `synthetic trust cleanup must forget exactly this run's new key (received ${forgotten.status})`,
                );
            });
        }
        if (syntheticConversationCreated || syntheticTrustCreated) {
            await captureCleanup("verifying synthetic trust and configuration removal", async () => {
                const expectedStatus = syntheticConversationCreated ? "disabled" : "unconfigured";
                const clean = await inspectCleanSyntheticState(page!, expectedStatus);
                assert.equal(clean.conversationStatus, expectedStatus, "no enabled or review-required synthetic configuration may remain");
                assert.equal(clean.channelProtectionStatus, expectedStatus, "persisted channel protection must be inactive after cleanup");
                assert.deepEqual(clean.selectedRecipientIds, [], "no synthetic selected recipient may remain");
                assert.equal(clean.participantStatus, "untrusted", "no synthetic peer trust may remain");
                cleanupProof = {
                    channelProtectionStatus: clean.channelProtectionStatus,
                    conversationStatus: clean.conversationStatus,
                    participantStatus: clean.participantStatus,
                    selectedRecipientIds: clean.selectedRecipientIds,
                    testMessagesDeleted: true,
                };
            });
        }
        if (pluginStartedByHarness) {
            await captureCleanup("stopping the SecureMessaging plugin started by the harness", async () => {
                const stopped = await stopSecureMessagingPlugin(page!);
                assert.equal(stopped.pluginStopped, true, `SecureMessaging failed to stop: ${String(stopped.stopResult)}`);
            });
        }
    } else if (allKnownMessageIds.length > 0 || syntheticConversationCreated || syntheticTrustCreated || pluginStartedByHarness) {
        cleanupErrors.push(new Error("the Discord page became unavailable before required live-state cleanup"));
    }

    await captureCleanup("disconnecting the DevTools client", async () => {
        await browser.disconnect();
    });

    const errors = [primaryError == null ? undefined : asError(primaryError), ...cleanupErrors]
        .filter((error): error is Error => error != null);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
        throw new AggregateError(errors, "SecureMessaging live proof failed and one or more cleanup operations also failed");

    assert.ok(report, "the live proof completed without producing a report");
    assert.ok(cleanupProof, "the live proof completed without a synthetic-state cleanup proof");
    console.log(JSON.stringify({
        ...report,
        cleanup: cleanupProof,
        disposableDataDirectory: expectedDataDir,
        disposableDirectoryMustBeDeletedAfterDiscordStops: true,
    }, null, 2));
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
