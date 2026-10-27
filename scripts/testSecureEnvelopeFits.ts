/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { encryptMessage, envelopeFits, generateIdentity, publicIdentity } from "../src/equicordplugins/secureMessaging.desktop/crypto";
import type { PublicIdentity } from "../src/equicordplugins/secureMessaging.desktop/protocol";

const CHANNEL_ID = "100000000000000001";
const SENDER_ID = "100000000000000002";

async function recipientIds(count: number) {
    const recipients: PublicIdentity[] = [];
    for (let index = 0; index < count; index++)
        recipients.push(await publicIdentity(await generateIdentity(), `2000000000000000${String(10 + index)}`));
    return recipients;
}

test("envelopeFits agrees with real encryption at the Discord length boundary", async () => {
    const identity = await generateIdentity();
    const recipients = await recipientIds(8);
    const userIds = recipients.map(recipient => recipient.userId);
    for (const length of [1, 100, 150, 200, 250, 300, 400, 2_000]) {
        const plaintext = "é".repeat(length);
        const fits = envelopeFits({ channelId: CHANNEL_ID, counter: 1, plaintext, recipientUserIds: userIds, senderUserId: SENDER_ID });
        const encrypted = await encryptMessage({ channelId: CHANNEL_ID, counter: 1, identity, plaintext, recipients, senderUserId: SENDER_ID })
            .then(() => true, () => false);
        assert.equal(fits, encrypted, `length ${length}`);
    }
});

test("envelopeFits counts recipients and ignores duplicates of the sender", async () => {
    const userIds = (await recipientIds(24)).map(recipient => recipient.userId);
    assert.equal(envelopeFits({ channelId: CHANNEL_ID, counter: 1, plaintext: "x", recipientUserIds: userIds, senderUserId: SENDER_ID }), false);
    assert.equal(envelopeFits({ channelId: CHANNEL_ID, counter: 1, plaintext: "x", recipientUserIds: userIds.slice(0, 5), senderUserId: SENDER_ID }), true);
    assert.equal(envelopeFits({ channelId: CHANNEL_ID, counter: 1, plaintext: "x", recipientUserIds: [SENDER_ID, SENDER_ID], senderUserId: SENDER_ID }), true);
});
