/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "esbuild";
import type { IpcMainInvokeEvent } from "electron";

import { generateAttachmentBundleMaterial, serializeSecurePlaintext } from "../src/equicordplugins/secureMessaging.desktop/attachments";
import type { ConversationSnapshot } from "../src/equicordplugins/secureMessaging.desktop/native";

type NativeModule = typeof import("../src/equicordplugins/secureMessaging.desktop/native");

const ALICE_ID = "100000000000000001";
const BOB_ID = "100000000000000002";
const CAROL_ID = "100000000000000003";
const OUTSIDER_ID = "100000000000000004";
const DM_CHANNEL_ID = "200000000000000001";
const GROUP_CHANNEL_ID = "200000000000000002";
const OUTSIDER_CHANNEL_ID = "200000000000000003";
const DISCORD_EVENT = discordEvent("https://discord.com/channels/@me/200000000000000001");

class AuthenticatedProtector {
    available = true;
    backend = "kwallet6";
    failFinalFileSync = false;
    failParentDirectorySync = false;
    failVaultDirectorySync = false;
    finalFileSyncCalls = 0;
    parentDirectorySyncCalls = 0;
    vaultDirectorySyncCalls = 0;
    readonly key = createHash("sha256").update("secure-messaging-native-test-protector").digest();

    isEncryptionAvailable(): boolean {
        return this.available;
    }

    getSelectedStorageBackend(): string {
        return this.backend;
    }

    encryptString(plaintext: string): Buffer {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([Buffer.from("SMT1"), nonce, cipher.getAuthTag(), ciphertext]);
    }

    decryptString(protectedValue: Buffer): string {
        if (protectedValue.byteLength < 33 || protectedValue.subarray(0, 4).toString("ascii") !== "SMT1")
            throw new Error("Invalid protected value");
        const decipher = createDecipheriv("aes-256-gcm", this.key, protectedValue.subarray(4, 16));
        decipher.setAuthTag(protectedValue.subarray(16, 32));
        return Buffer.concat([decipher.update(protectedValue.subarray(32)), decipher.final()]).toString("utf8");
    }
}

interface HarnessRuntime {
    appListeners?: Array<[string, (event: unknown, window: HarnessWindow) => void]>;
    browserWindows?: HarnessWindow[];
    dataDir: string;
    protector: AuthenticatedProtector;
}

interface HarnessWindow {
    failWhen?: boolean;
    scripts: string[];
    values: boolean[];
    webContents: {
        fail?: boolean;
        executeJavaScript(script: string): Promise<void>;
    };
    setContentProtection(enabled: boolean): void;
}

interface HarnessGlobal {
    __secureMessagingNativeHarness: HarnessRuntime;
}

const harnessGlobal = globalThis as typeof globalThis & HarnessGlobal;
const protector = new AuthenticatedProtector();

function captureWindow(failWhen?: boolean): HarnessWindow {
    const scripts: string[] = [];
    const webContents: HarnessWindow["webContents"] = {
        async executeJavaScript(script) {
            scripts.push(script);
            if (this.fail) throw new Error("Injected encrypted-content visibility failure");
        },
    };
    return {
        failWhen,
        scripts,
        values: [],
        webContents,
        setContentProtection(enabled) {
            this.values.push(enabled);
            if (this.failWhen === enabled) throw new Error("Injected screen-capture protection failure");
        },
    };
}

function discordEvent(url: string): IpcMainInvokeEvent {
    return {
        senderFrame: { url } as IpcMainInvokeEvent["senderFrame"],
    } as IpcMainInvokeEvent;
}

function messageId(index: number): string {
    return (30_000_000_000_000_000n + BigInt(index)).toString();
}

function messageIdAt(timestamp: number): string {
    return ((BigInt(timestamp) - 1_420_070_400_000n) << 22n).toString();
}

function lastNumber(values: number[], label: string): number {
    const value = values.at(-1);
    if (value === undefined) assert.fail(`${label} must not be empty`);
    return value;
}

type WithStatus<T, S extends string> = T extends { status: infer Status extends string; }
    ? S extends Status ? T & { status: S; } : never
    : never;

function expectStatus<T extends { status: string; }, S extends string>(
    result: T,
    expected: S,
    label: string,
): asserts result is WithStatus<T, S> {
    assert.equal(result.status, expected, `${label}: ${JSON.stringify(result)}`);
}

function dmSnapshot(channelId: string, peerId: string): ConversationSnapshot {
    return { channelId, kind: "DM", participantUserIds: [peerId] };
}

function groupSnapshot(...participantUserIds: string[]): ConversationSnapshot {
    return { channelId: GROUP_CHANNEL_ID, kind: "GROUP_DM", participantUserIds };
}

const runtimeStubs: Plugin = {
    name: "secure-messaging-native-runtime-stubs",
    setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "secure-native-test" }));
        bundle.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: "constants", namespace: "secure-native-test" }));
        bundle.onResolve({ filter: /^fs\/promises$/ }, () => ({ path: "fs-promises", namespace: "secure-native-test" }));
        bundle.onLoad({ filter: /^electron$/, namespace: "secure-native-test" }, () => ({
            contents: `
                const runtime = globalThis.__secureMessagingNativeHarness;
                export const safeStorage = {
                    isEncryptionAvailable: () => runtime.protector.isEncryptionAvailable(),
                    getSelectedStorageBackend: () => runtime.protector.getSelectedStorageBackend(),
                    encryptString: value => runtime.protector.encryptString(value),
                    decryptString: value => runtime.protector.decryptString(value),
                };
                export const BrowserWindow = {
                    getAllWindows: () => runtime.browserWindows ?? [],
                };
                export const app = {
                    on: (event, listener) => {
                        (runtime.appListeners ??= []).push([event, listener]);
                    },
                };
            `,
            loader: "js",
        }));
        bundle.onLoad({ filter: /^constants$/, namespace: "secure-native-test" }, () => ({
            contents: "export const DATA_DIR = globalThis.__secureMessagingNativeHarness.dataDir;",
            loader: "js",
        }));
        bundle.onLoad({ filter: /^fs-promises$/, namespace: "secure-native-test" }, () => ({
            contents: `
                import * as fs from "node:fs/promises";
                export * from "node:fs/promises";
                export async function open(path, flags, mode) {
                    const handle = await fs.open(path, flags, mode);
                    const runtime = globalThis.__secureMessagingNativeHarness;
                    if (flags === "r" && (await fs.stat(path)).isDirectory()) {
                        const vaultDirectory = String(path).replaceAll("\\\\", "/").endsWith("/secure-messaging");
                        handle.sync = async () => {
                            if (vaultDirectory) runtime.protector.vaultDirectorySyncCalls++;
                            else runtime.protector.parentDirectorySyncCalls++;
                            if ((vaultDirectory && runtime.protector.failVaultDirectorySync) ||
                                (!vaultDirectory && runtime.protector.failParentDirectorySync)) {
                                const error = new Error("Injected directory fsync failure");
                                error.code = "EIO";
                                throw error;
                            }
                        };
                    } else if (flags === "r+" && runtime.protector.failFinalFileSync) {
                        handle.sync = async () => {
                            runtime.protector.finalFileSyncCalls++;
                            const error = new Error("Injected final-file fsync failure");
                            error.code = "EIO";
                            throw error;
                        };
                    } else if (flags === "r+") {
                        const sync = handle.sync.bind(handle);
                        handle.sync = async () => {
                            runtime.protector.finalFileSyncCalls++;
                            await sync();
                        };
                    }
                    return handle;
                }
            `,
            loader: "js",
        }));
    },
};

async function buildNativeBundle(bundlePath: string, emulatePlatform?: "linux" | "win32"): Promise<void> {
    await build({
        absWorkingDir: resolve("."),
        bundle: true,
        define: emulatePlatform ? { "process.platform": JSON.stringify(emulatePlatform) } : undefined,
        entryPoints: ["src/equicordplugins/secureMessaging.desktop/native.ts"],
        format: "esm",
        outfile: bundlePath,
        platform: "node",
        plugins: [runtimeStubs],
        target: "node22",
    });
}

let loadSequence = 0;

async function loadNative(bundlePath: string, dataDir: string): Promise<NativeModule> {
    harnessGlobal.__secureMessagingNativeHarness = { dataDir, protector };
    const url = pathToFileURL(bundlePath);
    url.searchParams.set("instance", String(++loadSequence));
    return import(url.href) as Promise<NativeModule>;
}

async function createAnnouncement(native: NativeModule, userId: string): Promise<string> {
    const result = await native.createAnnouncement(DISCORD_EVENT, userId);
    expectStatus(result, "created", `create announcement for ${userId}`);
    return result.content;
}

async function trustAnnouncement(
    native: NativeModule,
    localUserId: string,
    peerUserId: string,
    announcement: string,
    publishedAt = Date.now(),
): Promise<void> {
    const review = await native.reviewAnnouncement(
        DISCORD_EVENT,
        localUserId,
        peerUserId,
        announcement,
        messageIdAt(publishedAt),
        null,
    );
    expectStatus(review, "trust_required", `${localUserId} explicitly reviews ${peerUserId}`);
    const trusted = await native.trustReviewedKey(
        DISCORD_EVENT,
        localUserId,
        peerUserId,
        review.reviewToken,
        review.identity.fingerprint,
    );
    expectStatus(trusted, "trusted", `${localUserId} explicitly trusts ${peerUserId}`);
}

async function testInvalidInputs(native: NativeModule): Promise<void> {
    const hostileEvent = discordEvent("https://example.com/channels/@me/200000000000000001");
    expectStatus(await native.setScreenCaptureProtection(hostileEvent, true), "invalid_input", "non-Discord capture-protection IPC origin");
    expectStatus(
        await native.setScreenCaptureProtection(DISCORD_EVENT, "true" as never),
        "invalid_input",
        "capture-protection input must be boolean",
    );
    expectStatus(await native.getIdentity(hostileEvent, ALICE_ID), "invalid_input", "non-Discord IPC origin");
    expectStatus(await native.getIdentity(DISCORD_EVENT, "not-a-snowflake"), "invalid_input", "invalid local user");
    expectStatus(await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, "not-a-snowflake"), "invalid_input", "invalid protection channel");
    expectStatus(await native.rotateIdentity(DISCORD_EVENT, ALICE_ID, "bad"), "invalid_input", "invalid rotation fingerprint");
    expectStatus(
        await native.reviewAnnouncement(DISCORD_EVENT, ALICE_ID, ALICE_ID, "bad", messageIdAt(Date.now()), null),
        "invalid_input",
        "self review",
    );
    expectStatus(
        await native.reviewAnnouncement(DISCORD_EVENT, ALICE_ID, BOB_ID, "", messageIdAt(Date.now()), null),
        "invalid_input",
        "empty announcement",
    );
    expectStatus(
        await native.reviewAnnouncement(DISCORD_EVENT, ALICE_ID, BOB_ID, "bad", "not-a-snowflake", null),
        "invalid_input",
        "invalid announcement Discord message ID",
    );
    expectStatus(
        await native.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            "bad",
            messageIdAt(Date.now()),
            "9999-99-99T99:99:99.999Z",
        ),
        "invalid_input",
        "invalid announcement edited timestamp",
    );
    expectStatus(await native.trustReviewedKey(DISCORD_EVENT, ALICE_ID, BOB_ID, "bad", "bad"), "invalid_input", "invalid review proof");
    expectStatus(await native.forgetPeer(DISCORD_EVENT, ALICE_ID, ALICE_ID), "invalid_input", "forget self");
    expectStatus(await native.getConversation(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        kind: "DM",
        participantUserIds: [ALICE_ID],
    }), "invalid_input", "snapshot containing local user");
    expectStatus(await native.getConversation(DISCORD_EVENT, ALICE_ID, {
        channelId: GROUP_CHANNEL_ID,
        kind: "GROUP_DM",
        participantUserIds: [BOB_ID, BOB_ID],
    }), "invalid_input", "snapshot duplicate participants");
    expectStatus(await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [],
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "enabled conversation without recipients");
    expectStatus(await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [CAROL_ID],
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "recipient outside snapshot");
    expectStatus(await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "",
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "empty plaintext");
    expectStatus(await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "x".repeat(2_001),
        snapshot: dmSnapshot(DM_CHANNEL_ID, BOB_ID),
    }), "invalid_input", "oversized plaintext input");
    expectStatus(await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        content: "",
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(1),
    }), "invalid_input", "empty encrypted content");
    expectStatus(await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        content: "not-an-envelope",
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: "9999-99-99T99:99:99.999Z",
        discordMessageId: messageId(1),
    }), "invalid_input", "invalid canonical-shaped edited timestamp");
}

async function testScreenCaptureProtection(native: NativeModule): Promise<void> {
    const primary = captureWindow();
    const failing = captureWindow(true);
    const runtime = harnessGlobal.__secureMessagingNativeHarness;
    runtime.browserWindows = [primary, failing];

    const failedEnable = await native.setScreenCaptureProtection(DISCORD_EVENT, true);
    expectStatus(failedEnable, "failed", "window capture-protection failure is structured across IPC");
    assert.equal(failedEnable.error, "screen_capture_protection_failed");
    assert.deepEqual(primary.values, [true, false], "a partial enable is rolled back on every reachable window");
    assert.deepEqual(failing.values, [true, false], "the failing window also receives the safe rollback attempt");
    assert.ok(primary.scripts.at(-1)?.includes("classList.add"), "an unprotected rollback hides encrypted DOM content");

    failing.failWhen = undefined;
    runtime.browserWindows = [primary];
    const enabled = await native.setScreenCaptureProtection(DISCORD_EVENT, true);
    expectStatus(enabled, "applied", "screen-capture protection enables after the injected failure clears");
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.windowCount, 1);
    assert.ok(primary.scripts.at(-1)?.includes("classList.remove"), "encrypted DOM content is revealed only after protection succeeds");
    assert.equal(runtime.appListeners?.filter(([event]) => event === "browser-window-created").length, 1, "future-window hook installs once");

    const futureWindow = captureWindow();
    const windowHook = runtime.appListeners?.find(([event]) => event === "browser-window-created")?.[1];
    assert.ok(windowHook, "future-window protection hook is registered");
    windowHook({}, futureWindow);
    assert.deepEqual(futureWindow.values, [true], "a future window is protected before it can display decrypted content");
    assert.ok(futureWindow.scripts.at(-1)?.includes("classList.remove"), "a protected future window is not left in screenshot mode");

    const failingFutureWindow = captureWindow(true);
    runtime.browserWindows = [primary, failingFutureWindow];
    windowHook({}, failingFutureWindow);
    assert.equal(primary.values.at(-1), true, "a future-window failure preserves protection on existing windows");
    const failClosedDecrypt = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: DM_CHANNEL_ID,
        content: "PCEM1:blocked-until-protection-recovers",
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(2),
    });
    expectStatus(failClosedDecrypt, "failed", "future-window protection failure blocks subsequent decryptions");
    assert.equal(failClosedDecrypt.error, "screen_capture_protection_failed");

    runtime.browserWindows = [primary];
    expectStatus(await native.setScreenCaptureProtection(DISCORD_EVENT, true), "applied", "protection recovers after a future-window failure");
    expectStatus(await native.setScreenCaptureProtection(DISCORD_EVENT, false), "applied", "screen-capture protection disables cleanly");
    assert.ok(primary.scripts.at(-1)?.includes("classList.add"), "screenshot mode hides encrypted DOM content before capture is enabled");
    expectStatus(await native.setScreenCaptureProtection(DISCORD_EVENT, true), "applied", "screen-capture protection re-enables serially");
    assert.ok(primary.scripts.at(-1)?.includes("classList.remove"), "capture protection is restored before encrypted DOM content is revealed");
    assert.equal(runtime.appListeners?.filter(([event]) => event === "browser-window-created").length, 1, "re-enabling does not duplicate hooks");
}

async function testStorageFailures(bundlePath: string, linuxBundlePath: string, windowsBundlePath: string, root: string): Promise<void> {
    protector.available = false;
    let native = await loadNative(bundlePath, join(root, "unavailable"));
    let result = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(result, "unavailable", "safeStorage unavailable");
    assert.equal(result.reason, "encryption_unavailable");

    protector.available = true;
    protector.backend = "basic_text";
    native = await loadNative(linuxBundlePath, join(root, "unsafe-backend"));
    result = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(result, "unavailable", "unsafe Linux safeStorage backend");
    assert.equal(result.reason, "unsafe_linux_backend");

    protector.backend = "kwallet6";
    const corruptDir = join(root, "corrupt-vault");
    await mkdir(join(corruptDir, "secure-messaging"), { recursive: true });
    await writeFile(join(corruptDir, "secure-messaging", "vault.bin"), Buffer.from("not authenticated ciphertext"));
    native = await loadNative(bundlePath, corruptDir);
    result = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(result, "unavailable", "corrupt vault");
    assert.equal(result.reason, "vault_unreadable");

    const legacyQuarantineDir = join(root, "legacy-quarantine-order");
    const legacyQuarantineVaultDir = join(legacyQuarantineDir, "secure-messaging");
    await mkdir(legacyQuarantineVaultDir, { recursive: true });
    const legacyPairs = [
        `${ALICE_ID}:${BOB_ID}`,
        `${ALICE_ID}:${CAROL_ID}`,
        `${ALICE_ID}0:${OUTSIDER_ID}`,
    ];
    await writeFile(
        join(legacyQuarantineVaultDir, "quarantine.bin"),
        protector.encryptString(JSON.stringify({ pairs: legacyPairs, version: 1 })),
    );
    native = await loadNative(bundlePath, legacyQuarantineDir);
    expectStatus(await native.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "legacy locale-sorted quarantine journal loads");
    expectStatus(
        await native.forgetPeer(DISCORD_EVENT, ALICE_ID, BOB_ID),
        "forgotten",
        "legacy quarantine entry can be cleared and migrated",
    );
    const migratedJournal = JSON.parse(protector.decryptString(
        await readFile(join(legacyQuarantineVaultDir, "quarantine.bin")),
    )) as { entries: Array<{ pair: string; }>; version: number; };
    assert.equal(migratedJournal.version, 2, "legacy quarantine journal migrates to timestamped v2");
    const migratedPairs = migratedJournal.entries.map(entry => entry.pair);
    assert.deepEqual(
        migratedPairs,
        [...migratedPairs].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        "v2 quarantine writer uses the parser's code-unit ordering for mixed snowflake lengths",
    );
    const migratedQuarantineNative = await loadNative(bundlePath, legacyQuarantineDir);
    expectStatus(
        await migratedQuarantineNative.getIdentity(DISCORD_EVENT, ALICE_ID),
        "ready",
        "migrated mixed-length v2 quarantine journal reloads",
    );

    const parentSyncDir = join(root, "parent-sync-failure");
    await mkdir(parentSyncDir, { recursive: true });
    native = await loadNative(linuxBundlePath, parentSyncDir);
    const parentSyncCalls = protector.parentDirectorySyncCalls;
    protector.failParentDirectorySync = true;
    const parentSyncFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(parentSyncFailure, "failed", "first-write parent directory fsync failure propagates");
    assert.equal(parentSyncFailure.error, "storage_error");
    assert.ok(protector.parentDirectorySyncCalls > parentSyncCalls, "first write attempted a parent directory fsync");
    protector.failParentDirectorySync = false;
    const failedParentSyncCalls = protector.parentDirectorySyncCalls;
    expectStatus(await native.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "first-write parent fsync is retried");
    assert.ok(protector.parentDirectorySyncCalls > failedParentSyncCalls, "retry flushes the already-created parent directory");

    const directorySyncDir = join(root, "directory-sync-failure");
    native = await loadNative(linuxBundlePath, directorySyncDir);
    const beforeDirectoryFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(beforeDirectoryFailure, "ready", "identity before directory fsync fault");
    const vaultDirectorySyncCalls = protector.vaultDirectorySyncCalls;
    protector.failVaultDirectorySync = true;
    const directoryFailure = await native.rotateIdentity(
        DISCORD_EVENT,
        ALICE_ID,
        beforeDirectoryFailure.identity.fingerprint,
    );
    expectStatus(directoryFailure, "failed", "supported-platform directory fsync failure propagates");
    assert.equal(directoryFailure.error, "storage_error");
    assert.ok(protector.vaultDirectorySyncCalls > vaultDirectorySyncCalls, "post-rename vault directory fsync was attempted");
    protector.failVaultDirectorySync = false;
    const failedVaultDirectorySyncCalls = protector.vaultDirectorySyncCalls;
    const afterDirectoryFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(afterDirectoryFailure, "ready", "vault reloads after post-rename directory fsync fault");
    assert.ok(protector.vaultDirectorySyncCalls > failedVaultDirectorySyncCalls, "reload retries the failed vault directory fsync");
    assert.notEqual(afterDirectoryFailure.identity.fingerprint, beforeDirectoryFailure.identity.fingerprint);

    const finalSyncDir = join(root, "windows-final-sync-failure");
    native = await loadNative(windowsBundlePath, finalSyncDir);
    const finalFileSyncCalls = protector.finalFileSyncCalls;
    protector.failFinalFileSync = true;
    const finalSyncFailure = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(finalSyncFailure, "failed", "Windows final-file fsync failure propagates");
    assert.equal(finalSyncFailure.error, "storage_error");
    assert.ok(protector.finalFileSyncCalls > finalFileSyncCalls, "Windows write attempted a final-file flush");
    protector.failFinalFileSync = false;
    const failedFinalFileSyncCalls = protector.finalFileSyncCalls;
    expectStatus(await native.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "Windows strategy succeeds after sync fault clears");
    assert.ok(protector.finalFileSyncCalls > failedFinalFileSyncCalls, "Windows reload retries the failed final-file flush");
}

async function testNativeLifecycle(bundlePath: string, dataDir: string): Promise<void> {
    const native = await loadNative(bundlePath, dataDir);
    await testInvalidInputs(native);
    await testScreenCaptureProtection(native);

    const aliceIdentity = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    const bobIdentity = await native.getIdentity(DISCORD_EVENT, BOB_ID);
    const carolIdentity = await native.getIdentity(DISCORD_EVENT, CAROL_ID);
    const outsiderIdentity = await native.getIdentity(DISCORD_EVENT, OUTSIDER_ID);
    expectStatus(aliceIdentity, "ready", "Alice identity creation");
    expectStatus(bobIdentity, "ready", "Bob identity creation");
    expectStatus(carolIdentity, "ready", "Carol identity creation");
    expectStatus(outsiderIdentity, "ready", "outsider identity creation");
    assert.equal(new Set([
        aliceIdentity.identity.fingerprint,
        bobIdentity.identity.fingerprint,
        carolIdentity.identity.fingerprint,
        outsiderIdentity.identity.fingerprint,
    ]).size, 4, "each account receives an independent identity");

    const [aliceAnnouncement, bobAnnouncement, carolAnnouncement, outsiderAnnouncement] = await Promise.all([
        createAnnouncement(native, ALICE_ID),
        createAnnouncement(native, BOB_ID),
        createAnnouncement(native, CAROL_ID),
        createAnnouncement(native, OUTSIDER_ID),
    ]);
    const bobOriginalPublishedAt = Date.now();
    await trustAnnouncement(native, ALICE_ID, BOB_ID, bobAnnouncement, bobOriginalPublishedAt);
    await trustAnnouncement(native, ALICE_ID, CAROL_ID, carolAnnouncement);
    await trustAnnouncement(native, BOB_ID, ALICE_ID, aliceAnnouncement);
    await trustAnnouncement(native, CAROL_ID, ALICE_ID, aliceAnnouncement);
    await trustAnnouncement(native, OUTSIDER_ID, ALICE_ID, aliceAnnouncement);

    const vaultPath = join(dataDir, "secure-messaging", "vault.bin");
    const legacyVault = JSON.parse(protector.decryptString(await readFile(vaultPath))) as {
        accounts: Record<string, Record<string, unknown>>;
    };
    for (const account of Object.values(legacyVault.accounts)) {
        delete account.identityHistory;
        delete account.peerIdentityHistory;
        const trustedPeers = account.trustedPeers as Record<string, Record<string, unknown>>;
        for (const peer of Object.values(trustedPeers)) {
            delete peer.keyChangedAt;
            delete peer.publishedAt;
        }
    }
    await writeFile(vaultPath, protector.encryptString(JSON.stringify(legacyVault)));
    const migratedNative = await loadNative(bundlePath, dataDir);
    expectStatus(await migratedNative.getIdentity(DISCORD_EVENT, ALICE_ID), "ready", "legacy v1 account migrates without losing identity");

    const aliceDm = dmSnapshot(DM_CHANNEL_ID, BOB_ID);
    const bobDm = dmSnapshot(DM_CHANNEL_ID, ALICE_ID);
    let conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceDm,
    });
    expectStatus(conversation, "enabled", "Alice DM recipient configuration");
    conversation = await native.configureConversation(DISCORD_EVENT, BOB_ID, {
        enabled: true,
        selectedRecipientIds: [ALICE_ID],
        snapshot: bobDm,
    });
    expectStatus(conversation, "enabled", "Bob DM recipient configuration");
    expectStatus(await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, DM_CHANNEL_ID), "protected", "persisted protection lookup");
    expectStatus(await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, "200000000000000099"), "unconfigured", "unknown channel protection lookup");

    const aliceGroup = groupSnapshot(BOB_ID, CAROL_ID);
    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "selected group recipient configuration");

    const bobHistoricalPlaintext = "Bob message before either key rotation";
    const bobBeforeReplacement = await native.encryptOutgoing(DISCORD_EVENT, BOB_ID, {
        plaintext: bobHistoricalPlaintext,
        snapshot: bobDm,
    });
    expectStatus(bobBeforeReplacement, "encrypted", "Bob encrypts before key replacement");
    const aliceHistoricalInput = {
        channelId: DM_CHANNEL_ID,
        content: bobBeforeReplacement.content,
        discordAuthorId: BOB_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(9),
    };
    let decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(decrypted, "decrypted", "Alice initially decrypts Bob pre-replacement message");
    assert.equal(decrypted.plaintext, bobHistoricalPlaintext);

    const dmPlaintext = "native DM secret α";
    const encryptedDm = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, { plaintext: dmPlaintext, snapshot: aliceDm });
    expectStatus(encryptedDm, "encrypted", "Alice encrypts for Bob");
    const bobDmInput = {
        channelId: DM_CHANNEL_ID,
        content: encryptedDm.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(10),
    };
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "Bob decrypts Alice DM");
    assert.equal(decrypted.plaintext, dmPlaintext);
    const aliceOwnDmInput = {
        ...bobDmInput,
        discordMessageId: messageId(11),
    };
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceOwnDmInput);
    expectStatus(decrypted, "decrypted", "sender decrypts own message");
    assert.equal(decrypted.plaintext, dmPlaintext);
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        discordMessageId: messageId(13),
    });
    expectStatus(decrypted, "decrypted", "sender decrypts own message after Discord replaces its optimistic message ID");
    assert.equal(decrypted.plaintext, dmPlaintext);

    const attachmentMaterial = generateAttachmentBundleMaterial(2);
    const encryptedAttachmentMessage = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: serializeSecurePlaintext("", {
            ...attachmentMaterial.descriptor,
            root: attachmentMaterial.descriptor.key,
        }),
        snapshot: aliceDm,
    });
    attachmentMaterial.keyBytes.fill(0);
    expectStatus(encryptedAttachmentMessage, "encrypted", "Alice encrypts an attachment bundle descriptor");
    const attachmentMessageInput = {
        channelId: DM_CHANNEL_ID,
        content: encryptedAttachmentMessage.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(14),
    };
    const decryptedAttachmentMessage = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, attachmentMessageInput);
    expectStatus(decryptedAttachmentMessage, "decrypted", "Bob authenticates the attachment bundle descriptor");
    assert.equal(decryptedAttachmentMessage.plaintext, "");
    assert.equal(decryptedAttachmentMessage.attachmentBundle?.count, 2);
    assert.deepEqual(decryptedAttachmentMessage.stickers, []);
    const secureSticker = { formatType: 3, id: "749054660769218631", name: "Wave" };
    const encryptedStickerMessage = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: serializeSecurePlaintext("", null, [secureSticker]),
        snapshot: aliceDm,
    });
    expectStatus(encryptedStickerMessage, "encrypted", "Alice encrypts a sticker item");
    const decryptedStickerMessage = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        channelId: DM_CHANNEL_ID,
        content: encryptedStickerMessage.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(15),
    });
    expectStatus(decryptedStickerMessage, "decrypted", "Bob authenticates encrypted sticker metadata");
    assert.equal(decryptedStickerMessage.plaintext, "");
    assert.equal(decryptedStickerMessage.attachmentBundle, null);
    assert.deepEqual(decryptedStickerMessage.stickers, [secureSticker]);
    const invalidAttachmentUrl = await native.decryptIncomingAttachments(DISCORD_EVENT, BOB_ID, {
        ...attachmentMessageInput,
        attachments: [{
            id: messageId(101),
            proxyUrl: "https://example.com/not-discord",
            size: 100,
            url: "https://example.com/not-discord",
        }],
    });
    expectStatus(invalidAttachmentUrl, "invalid_input", "native attachment downloads reject non-Discord origins");
    const oneOfTwoAttachments = await native.decryptIncomingAttachments(DISCORD_EVENT, BOB_ID, {
        ...attachmentMessageInput,
        attachments: [{
            id: messageId(101),
            proxyUrl: `https://media.discordapp.net/attachments/${DM_CHANNEL_ID}/${messageId(101)}/pc-test.pcaf`,
            size: 100,
            url: `https://cdn.discordapp.com/attachments/${DM_CHANNEL_ID}/${messageId(101)}/pc-test.pcaf`,
        }],
    });
    expectStatus(oneOfTwoAttachments, "invalid_message", "missing ciphertext attachments fail before any download");

    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "exact message rerender is idempotent");
    const copiedReplay = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...bobDmInput,
        discordMessageId: messageId(12),
    });
    expectStatus(copiedReplay, "replay_detected", "copied ciphertext under another Discord message");

    const secondDm = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, { plaintext: "second native secret", snapshot: aliceDm });
    expectStatus(secondDm, "encrypted", "second Alice DM encryption");
    const differentMessageReplay = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...bobDmInput,
        content: secondDm.content,
    });
    expectStatus(differentMessageReplay, "replay_detected", "different ciphertext reusing a Discord message ID");
    const senderMessageIdCollision = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceOwnDmInput,
        content: secondDm.content,
    });
    expectStatus(senderMessageIdCollision, "replay_detected", "sender still rejects different ciphertext reusing a Discord message ID");

    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "group can deliberately leave a participant unselected");
    const selectedOnly = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "Bob only in this group",
        snapshot: aliceGroup,
    });
    expectStatus(selectedOnly, "encrypted", "group message for selected recipients");
    const unselected = await native.decryptIncoming(DISCORD_EVENT, CAROL_ID, {
        channelId: GROUP_CHANNEL_ID,
        content: selectedOnly.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(20),
    });
    expectStatus(unselected, "invalid_message", "trusted but unselected participant cannot decrypt");

    const outsiderDm = dmSnapshot(OUTSIDER_CHANNEL_ID, ALICE_ID);
    conversation = await native.configureConversation(DISCORD_EVENT, OUTSIDER_ID, {
        enabled: true,
        selectedRecipientIds: [ALICE_ID],
        snapshot: outsiderDm,
    });
    expectStatus(conversation, "enabled", "outsider configures Alice as recipient");
    const outsiderMessage = await native.encryptOutgoing(DISCORD_EVENT, OUTSIDER_ID, {
        plaintext: "untrusted sender message",
        snapshot: outsiderDm,
    });
    expectStatus(outsiderMessage, "encrypted", "outsider encrypts for Alice");
    const untrustedAuthor = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        channelId: OUTSIDER_CHANNEL_ID,
        content: outsiderMessage.content,
        discordAuthorId: OUTSIDER_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(21),
    });
    expectStatus(untrustedAuthor, "untrusted_author", "untrusted author is rejected before decryption");

    const changedGroup = groupSnapshot(BOB_ID, CAROL_ID, OUTSIDER_ID);
    const participantChanged = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "must not send",
        snapshot: changedGroup,
    });
    expectStatus(participantChanged, "not_enabled", "participant snapshot change disables send");
    assert.equal(participantChanged.reason, "participant_changed");
    const remainsDisabled = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "still must not send",
        snapshot: aliceGroup,
    });
    expectStatus(remainsDisabled, "not_enabled", "changed conversation remains disabled");
    assert.equal(remainsDisabled.reason, "participant_changed", "participant-change latch persists until explicit reconfiguration");
    expectStatus(
        await native.getChannelProtection(DISCORD_EVENT, ALICE_ID, GROUP_CHANNEL_ID),
        "protected",
        "background sends remain fail-closed after a participant-change auto-disable",
    );

    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceDm,
    });
    expectStatus(conversation, "enabled", "DM enabled before counter stress");
    const concurrent = await Promise.all(Array.from({ length: 16 }, (_, index) => native.encryptOutgoing(
        DISCORD_EVENT,
        ALICE_ID,
        { plaintext: `concurrent ${index}`, snapshot: aliceDm },
    )));
    const encryptedConcurrent = concurrent.map((result, index) => {
        expectStatus(result, "encrypted", `concurrent encryption ${index}`);
        return result;
    });
    const counters = encryptedConcurrent.map(result => result.counter);
    assert.equal(new Set(counters).size, counters.length, "concurrent sends receive unique counters");
    assert.deepEqual([...counters].sort((left, right) => left - right), counters, "serialized concurrent counters are monotonic");

    const [moduleA, moduleB] = await Promise.all([
        loadNative(bundlePath, dataDir),
        loadNative(bundlePath, dataDir),
    ]);
    const warmed = await Promise.all([
        moduleA.getConversation(DISCORD_EVENT, ALICE_ID, aliceDm),
        moduleB.getConversation(DISCORD_EVENT, ALICE_ID, aliceDm),
    ]);
    warmed.forEach((result, index) => expectStatus(result, "enabled", `module ${index + 1} warms its vault cache`));
    const beforeCrossModule = lastNumber(counters, "single-module counters");
    const crossModule = await Promise.all(Array.from({ length: 16 }, (_, index) => {
        const module = index % 2 === 0 ? moduleA : moduleB;
        return module.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
            plaintext: `cross-module concurrent ${index}`,
            snapshot: aliceDm,
        });
    }));
    const encryptedCrossModule = crossModule.map((result, index) => {
        expectStatus(result, "encrypted", `cross-module encryption ${index}`);
        return result;
    });
    const crossModuleCounters = encryptedCrossModule.map(result => result.counter);
    const sortedCrossModuleCounters = [...crossModuleCounters].sort((left, right) => left - right);
    assert.equal(new Set(crossModuleCounters).size, crossModuleCounters.length, "two module instances allocate unique counters");
    assert.deepEqual(
        sortedCrossModuleCounters,
        Array.from({ length: crossModuleCounters.length }, (_, index) => beforeCrossModule + index + 1),
        "cross-module counters are contiguous with no lost vault updates",
    );
    for (const parity of [0, 1]) {
        const moduleCounters = crossModuleCounters.filter((_, index) => index % 2 === parity);
        assert.deepEqual(
            [...moduleCounters].sort((left, right) => left - right),
            moduleCounters,
            `module ${parity + 1} observes monotonic counters`,
        );
    }

    const freshlyLoaded = await loadNative(bundlePath, dataDir);
    expectStatus(
        await freshlyLoaded.setScreenCaptureProtection(DISCORD_EVENT, true),
        "applied",
        "fresh native bundle protects its windows before decrypting",
    );
    const durableCounter = await freshlyLoaded.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "counter after fresh module load",
        snapshot: aliceDm,
    });
    expectStatus(durableCounter, "encrypted", "counter survives a freshly loaded native bundle");
    assert.equal(
        durableCounter.counter,
        lastNumber(sortedCrossModuleCounters, "cross-module counters") + 1,
        "fresh reload observes every cross-module counter update",
    );
    decrypted = await freshlyLoaded.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "exact replay remains allowed after reload");
    const persistedReplay = await freshlyLoaded.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        ...bobDmInput,
        discordMessageId: messageId(13),
    });
    expectStatus(persistedReplay, "replay_detected", "replay cache survives a freshly loaded native bundle");

    const preRetirementEditTimestamp = new Date().toISOString();
    const bobRotated = await native.rotateIdentity(DISCORD_EVENT, BOB_ID, bobIdentity.identity.fingerprint);
    expectStatus(bobRotated, "rotated", "Bob rotates identity");
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, bobDmInput);
    expectStatus(decrypted, "decrypted", "Bob retains the old private identity for pre-rotation history");
    assert.equal(decrypted.plaintext, dmPlaintext);
    const bobChangedAnnouncement = await createAnnouncement(native, BOB_ID);
    const peerReplacementPublishedAt = Math.max(Date.now(), bobOriginalPublishedAt + 1);
    const realDateNow = Date.now;
    let changedReview: Awaited<ReturnType<NativeModule["reviewAnnouncement"]>>;
    Date.now = () => peerReplacementPublishedAt + 5 * 60_000;
    try {
        changedReview = await native.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            bobChangedAnnouncement,
            messageIdAt(peerReplacementPublishedAt),
            null,
        );
    } finally {
        Date.now = realDateNow;
    }
    expectStatus(changedReview, "key_changed", "Alice fails closed on Bob key change");
    expectStatus(
        await native.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            bobAnnouncement,
            messageIdAt(bobOriginalPublishedAt),
            null,
        ),
        "key_changed",
        "current-key replay cannot clear an active replacement quarantine",
    );
    const quarantineAfterCurrentReplay = JSON.parse(protector.decryptString(
        await readFile(join(dataDir, "secure-messaging", "quarantine.bin")),
    )) as { entries: Array<{ detectedAt: number; pair: string; }>; };
    assert.equal(
        quarantineAfterCurrentReplay.entries.find(entry => entry.pair === `${ALICE_ID}:${BOB_ID}`)?.detectedAt,
        peerReplacementPublishedAt,
        "current or stale replays cannot move the authoritative replacement cutoff",
    );
    const quarantinedHistoricalMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(quarantinedHistoricalMessage, "untrusted_author", "quarantine blocks even previously readable retired peer keys");
    const keyChangedSend = await freshlyLoaded.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "must not use changed key",
        snapshot: aliceDm,
    });
    expectStatus(keyChangedSend, "not_enabled", "key quarantine blocks a second module with a stale warm cache");
    assert.equal(keyChangedSend.reason, "unverified_recipients");
    const forgotten = await native.forgetPeer(DISCORD_EVENT, ALICE_ID, BOB_ID);
    expectStatus(forgotten, "forgotten", "Alice explicitly forgets Bob old key");
    await trustAnnouncement(native, ALICE_ID, BOB_ID, bobChangedAnnouncement, peerReplacementPublishedAt);
    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID],
        snapshot: aliceDm,
    });
    expectStatus(conversation, "enabled", "Alice reconfigures DM after retrust");
    const afterReplacementReload = await loadNative(bundlePath, dataDir);
    const staleOldAnnouncement = await afterReplacementReload.reviewAnnouncement(
        DISCORD_EVENT,
        ALICE_ID,
        BOB_ID,
        bobAnnouncement,
        messageIdAt(bobOriginalPublishedAt),
        null,
    );
    expectStatus(
        staleOldAnnouncement,
        "stale_announcement",
        "reloaded historical A announcement cannot quarantine current B",
    );
    assert.equal(
        staleOldAnnouncement.trustedIdentity.fingerprint,
        bobRotated.identity.fingerprint,
        "stale announcement result identifies the unchanged current key",
    );
    expectStatus(
        await afterReplacementReload.reviewAnnouncement(
            DISCORD_EVENT,
            ALICE_ID,
            BOB_ID,
            bobChangedAnnouncement,
            messageIdAt(peerReplacementPublishedAt + 10_000),
            null,
        ),
        "trusted",
        "later replay of current B announcement remains trusted",
    );
    const publicationWatermarkVault = JSON.parse(protector.decryptString(await readFile(vaultPath))) as {
        accounts: Record<string, { trustedPeers: Record<string, { publishedAt: number | null; }>; }>;
    };
    assert.equal(
        publicationWatermarkVault.accounts[ALICE_ID].trustedPeers[BOB_ID].publishedAt,
        peerReplacementPublishedAt,
        "same-key re-announcements cannot advance the trusted publication watermark",
    );
    expectStatus(
        await afterReplacementReload.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
            plaintext: "stale announcement did not disable B",
            snapshot: aliceDm,
        }),
        "encrypted",
        "historical A replay leaves the B conversation enabled",
    );
    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(decrypted, "decrypted", "Alice retains Bob's previously trusted key after explicit replacement");
    assert.equal(decrypted.plaintext, bobHistoricalPlaintext);
    const editedBeforeRetirement = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordEditedTimestamp: preRetirementEditTimestamp,
    });
    expectStatus(editedBeforeRetirement, "decrypted", "an authoritative edit before retirement remains historically readable");
    const editedAfterRetirement = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordEditedTimestamp: new Date(peerReplacementPublishedAt + 1_000).toISOString(),
    });
    expectStatus(editedAfterRetirement, "invalid_message", "an edit after retirement cannot reuse a retired peer key");
    const retiredKeyNewMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordMessageId: messageIdAt(peerReplacementPublishedAt + 1),
    });
    expectStatus(
        retiredKeyNewMessage,
        "invalid_message",
        "server publication cutoff rejects retired-key posts despite a forward-skewed local clock",
    );
    const retiredKeyBoundaryMessage = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordMessageId: messageIdAt(peerReplacementPublishedAt),
    });
    expectStatus(
        retiredKeyBoundaryMessage,
        "invalid_message",
        "retirement boundary is strict when an old-key post shares the announcement millisecond",
    );
    const afterRetrust = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "trusted again",
        snapshot: aliceDm,
    });
    expectStatus(afterRetrust, "encrypted", "encryption resumes only after forget, retrust, and reconfigure");
    decrypted = await native.decryptIncoming(DISCORD_EVENT, BOB_ID, {
        channelId: DM_CHANNEL_ID,
        content: afterRetrust.content,
        discordAuthorId: ALICE_ID,
        discordEditedTimestamp: null,
        discordMessageId: messageId(30),
    });
    expectStatus(decrypted, "decrypted", "Bob decrypts after his rotation");
    assert.equal(decrypted.plaintext, "trusted again");

    conversation = await native.configureConversation(DISCORD_EVENT, ALICE_ID, {
        enabled: true,
        selectedRecipientIds: [BOB_ID, CAROL_ID],
        snapshot: aliceGroup,
    });
    expectStatus(conversation, "enabled", "group re-enabled before local rotation");
    const aliceBeforeRotation = await native.getIdentity(DISCORD_EVENT, ALICE_ID);
    expectStatus(aliceBeforeRotation, "ready", "Alice identity before rotation");
    const aliceRotated = await native.rotateIdentity(DISCORD_EVENT, ALICE_ID, aliceBeforeRotation.identity.fingerprint);
    expectStatus(aliceRotated, "rotated", "Alice rotates identity");
    assert.equal(aliceRotated.disabledConversationCount, 2, "local rotation disables every enabled configuration");
    assert.notEqual(aliceRotated.identity.fingerprint, aliceBeforeRotation.identity.fingerprint);
    const rotationDisabled = await native.encryptOutgoing(DISCORD_EVENT, ALICE_ID, {
        plaintext: "must reconfigure after rotation",
        snapshot: aliceDm,
    });
    expectStatus(rotationDisabled, "not_enabled", "local rotation disables sending");
    assert.equal(rotationDisabled.reason, "unverified_recipients", "rotation review latch persists until reconfiguration");

    decrypted = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, aliceHistoricalInput);
    expectStatus(decrypted, "decrypted", "historical message survives both local rotation and peer replacement");
    assert.equal(decrypted.plaintext, bobHistoricalPlaintext);
    const retiredKeysRemainBoundedToOldMessages = await native.decryptIncoming(DISCORD_EVENT, ALICE_ID, {
        ...aliceHistoricalInput,
        discordMessageId: messageIdAt(Date.now() + 120_000),
    });
    expectStatus(retiredKeysRemainBoundedToOldMessages, "invalid_message", "historical local and peer keys reject new messages");

    for (let replacementIndex = 0; replacementIndex < 5; replacementIndex++) {
        const bobBeforeReplacement = await native.getIdentity(DISCORD_EVENT, BOB_ID);
        expectStatus(bobBeforeReplacement, "ready", `Bob identity before bounded replacement ${replacementIndex}`);
        expectStatus(
            await native.rotateIdentity(DISCORD_EVENT, BOB_ID, bobBeforeReplacement.identity.fingerprint),
            "rotated",
            `Bob bounded replacement ${replacementIndex}`,
        );
        const replacementAnnouncement = await createAnnouncement(native, BOB_ID);
        expectStatus(
            await native.reviewAnnouncement(
                DISCORD_EVENT,
                ALICE_ID,
                BOB_ID,
                replacementAnnouncement,
                messageIdAt(Date.now()),
                null,
            ),
            "key_changed",
            `Alice detects bounded Bob replacement ${replacementIndex}`,
        );
        expectStatus(
            await native.forgetPeer(DISCORD_EVENT, ALICE_ID, BOB_ID),
            "forgotten",
            `Alice retires bounded Bob key ${replacementIndex}`,
        );
        await trustAnnouncement(native, ALICE_ID, BOB_ID, replacementAnnouncement);
    }

    const vaultBytes = await readFile(vaultPath);
    const vaultPlaintext = protector.decryptString(vaultBytes);
    const vaultState = JSON.parse(vaultPlaintext) as {
        accounts: Record<string, {
            identityHistory: Record<string, unknown>;
            peerIdentityHistory: Record<string, Record<string, unknown>>;
        }>;
    };
    assert.equal(Object.keys(vaultState.accounts[BOB_ID].identityHistory).length, 4, "local private identity history is capped");
    assert.equal(
        Object.keys(vaultState.accounts[ALICE_ID].peerIdentityHistory[BOB_ID]).length,
        4,
        "retired peer identity history is capped per Discord user",
    );
    const privateKeys = [...vaultPlaintext.matchAll(/"(?:hpkePrivateKey|signingPrivateKey)":"([^"]+)"/gu)]
        .map(match => match[1]);
    assert.ok(privateKeys.length >= 8, "test protector can authenticate and inspect all persisted private keys");
    for (const privateKey of privateKeys)
        assert.equal(vaultBytes.includes(Buffer.from(privateKey, "utf8")), false, "vault bytes do not expose raw private keys");
    for (const plaintext of [dmPlaintext, bobHistoricalPlaintext, "second native secret", "trusted again", "counter after fresh module load"])
        assert.equal(vaultBytes.includes(Buffer.from(plaintext, "utf8")), false, "vault bytes do not expose message plaintext");
}

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "lawyercord-secure-native-"));
    const bundlePath = join(root, "secure-messaging-native.mjs");
    const linuxBundlePath = join(root, "secure-messaging-native-linux.mjs");
    const windowsBundlePath = join(root, "secure-messaging-native-windows.mjs");
    try {
        await buildNativeBundle(bundlePath);
        await buildNativeBundle(linuxBundlePath, "linux");
        await buildNativeBundle(windowsBundlePath, "win32");
        await testStorageFailures(bundlePath, linuxBundlePath, windowsBundlePath, root);
        await testNativeLifecycle(bundlePath, join(root, "lifecycle"));
        console.log("secure-messaging native IPC checks passed");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
