/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore } from "@webpack/common";

import { requireOneOf } from "./policy";
import { isRaw, type Raw, serializeChannel, serializeMessage, str } from "./serialize";

export const SUBSCRIPTION_EVENTS = ["message_create", "message_update", "message_delete", "reaction_add", "reaction_remove"] as const;

type EventType = typeof SUBSCRIPTION_EVENTS[number];
type ScopeKind = "channel" | "guild" | "dms";

interface SubscriptionEvent {
    type: EventType;
    at: string;
    channelId: string;
    guildId: string | null;
    message?: ReturnType<typeof serializeMessage>;
    messageId?: string;
    messageIds?: string[];
    userId?: string;
    emoji?: { id: string | null; name: string | null; };
}

interface WaitResult {
    subscriptionId: string;
    timedOut: boolean;
    cancelled: boolean;
    message: ReturnType<typeof serializeMessage> | null;
    event: SubscriptionEvent | null;
    queuedRemaining: number;
}

interface Waiter {
    resolve(result: WaitResult): void;
    timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
    id: string;
    scope: ScopeKind;
    targetId: string | null;
    events: EventType[];
    createdAt: string;
    lastMessageId: string | null;
    queue: SubscriptionEvent[];
    dropped: number;
    waiter?: Waiter;
}

const MAX_SUBSCRIPTIONS = 100;
const MAX_QUEUED_EVENTS = 100;
const subscriptions = new Map<string, Subscription>();

export function normalizeEvents(value: unknown): EventType[] {
    if (value === undefined) return ["message_create"];
    if (!Array.isArray(value) || value.length < 1) throw new Error(`events must list at least one of: ${SUBSCRIPTION_EVENTS.join(", ")}`);
    return [...new Set(value.map(item => requireOneOf(item, "events", SUBSCRIPTION_EVENTS)))];
}

export function addSubscription(scope: ScopeKind, targetId: string | null, events: EventType[], lastMessageId: string | null) {
    if (subscriptions.size >= MAX_SUBSCRIPTIONS)
        throw new Error(`Discord MCP supports at most ${MAX_SUBSCRIPTIONS} active subscriptions`);
    const subscription: Subscription = {
        id: globalThis.crypto.randomUUID(),
        scope,
        targetId,
        events,
        createdAt: new Date().toISOString(),
        lastMessageId,
        queue: [],
        dropped: 0,
    };
    subscriptions.set(subscription.id, subscription);
    return subscriptionMetadata(subscription);
}

function subscriptionMetadata(subscription: Subscription) {
    const channel = subscription.scope === "channel" && subscription.targetId ? ChannelStore.getChannel(subscription.targetId) : null;
    return {
        id: subscription.id,
        scope: subscription.scope,
        targetId: subscription.targetId,
        events: subscription.events,
        channel: channel ? serializeChannel(channel) : subscription.scope === "channel" ? { id: subscription.targetId } : null,
        createdAt: subscription.createdAt,
        lastMessageId: subscription.lastMessageId,
        queuedMessageCount: subscription.queue.length,
        droppedEvents: subscription.dropped,
        waiting: Boolean(subscription.waiter),
    };
}

export function listSubscriptions() {
    const items = [...subscriptions.values()].map(subscriptionMetadata).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { subscriptions: items, count: items.length };
}

export function waitForSubscription(subscriptionId: string, timeoutSeconds: number): Promise<WaitResult> {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) throw new Error("Discord MCP subscription was not found");
    if (subscription.waiter) throw new Error("A wait is already active for this subscription");

    const queued = subscription.queue.shift();
    if (queued) return Promise.resolve(waitResult(subscription, queued));

    return new Promise(resolve => {
        const timer = setTimeout(() => {
            if (subscription.waiter?.timer === timer) subscription.waiter = undefined;
            resolve({ subscriptionId, timedOut: true, cancelled: false, message: null, event: null, queuedRemaining: 0 });
        }, timeoutSeconds * 1_000);
        subscription.waiter = { resolve, timer };
    });
}

function waitResult(subscription: Subscription, event: SubscriptionEvent): WaitResult {
    return {
        subscriptionId: subscription.id,
        timedOut: false,
        cancelled: false,
        message: event.message ?? null,
        event,
        queuedRemaining: subscription.queue.length,
    };
}

export function removeSubscription(subscriptionId: string) {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) return { subscriptionId, unsubscribed: false };

    subscriptions.delete(subscriptionId);
    cancelWaiter(subscription);
    return { subscriptionId, unsubscribed: true };
}

function cancelWaiter(subscription: Subscription) {
    if (!subscription.waiter) return;
    clearTimeout(subscription.waiter.timer);
    subscription.waiter.resolve({ subscriptionId: subscription.id, timedOut: false, cancelled: true, message: null, event: null, queuedRemaining: 0 });
    subscription.waiter = undefined;
}

export function clearSubscriptions() {
    for (const subscription of subscriptions.values()) cancelWaiter(subscription);
    subscriptions.clear();
}

function guildOf(channelId: string, guildId: unknown): string | null {
    if (typeof guildId === "string" && guildId) return guildId;
    const channel = ChannelStore.getChannel(channelId);
    return channel?.guild_id ? channel.guild_id : null;
}

function matches(subscription: Subscription, channelId: string, guildId: string | null): boolean {
    if (subscription.scope === "channel") return subscription.targetId === channelId;
    if (subscription.scope === "guild") return subscription.targetId === guildId;
    return guildId === null && ChannelStore.getChannel(channelId) != null;
}

function deliver(type: EventType, channelId: string, rawGuildId: unknown, build: (event: SubscriptionEvent) => void) {
    if (subscriptions.size === 0) return;
    const guildId = guildOf(channelId, rawGuildId);
    let event: SubscriptionEvent | undefined;
    for (const subscription of subscriptions.values()) {
        if (!subscription.events.includes(type) || !matches(subscription, channelId, guildId)) continue;
        if (!event) {
            event = { type, at: new Date().toISOString(), channelId, guildId };
            build(event);
        }
        if (type === "message_create" && event.message) {
            if (subscription.lastMessageId === event.message.id) continue;
            subscription.lastMessageId = event.message.id;
        }

        if (subscription.waiter) {
            const { waiter } = subscription;
            subscription.waiter = undefined;
            clearTimeout(waiter.timer);
            waiter.resolve(waitResult(subscription, event));
        } else {
            subscription.queue.push(event);
            if (subscription.queue.length > MAX_QUEUED_EVENTS) {
                subscription.queue.shift();
                subscription.dropped++;
            }
        }
    }
}

interface MessagePayload {
    optimistic?: boolean;
    message?: Raw;
    channelId?: string;
}

export function handleMessageCreate({ optimistic, message, channelId }: MessagePayload) {
    if (optimistic || !isRaw(message) || message.state === "SENDING") return;
    const target = String(channelId ?? message.channel_id ?? "");
    if (!target) return;
    deliver("message_create", target, message.guild_id, event => { event.message = serializeMessage(message); });
}

export function handleMessageUpdate({ message }: MessagePayload) {
    if (!isRaw(message) || !message.channel_id || !message.edited_timestamp || typeof message.content !== "string") return;
    deliver("message_update", String(message.channel_id), message.guild_id, event => { event.message = serializeMessage(message); });
}

export function handleMessageDelete({ id, channelId, guildId }: { id?: string; channelId?: string; guildId?: string; }) {
    if (!id || !channelId) return;
    deliver("message_delete", channelId, guildId, event => { event.messageId = id; });
}

export function handleMessageDeleteBulk({ ids, channelId, guildId }: { ids?: string[]; channelId?: string; guildId?: string; }) {
    if (!Array.isArray(ids) || !channelId) return;
    deliver("message_delete", channelId, guildId, event => { event.messageIds = ids.slice(0, 100); });
}

interface ReactionPayload {
    optimistic?: boolean;
    channelId?: string;
    messageId?: string;
    userId?: string;
    guildId?: string;
    emoji?: Raw;
}

function handleReaction(type: "reaction_add" | "reaction_remove", { optimistic, channelId, messageId, userId, guildId, emoji }: ReactionPayload) {
    if (optimistic || !channelId || !messageId) return;
    deliver(type, channelId, guildId, event => {
        event.messageId = messageId;
        event.userId = userId;
        event.emoji = { id: emoji?.id ? String(emoji.id) : null, name: str(emoji?.name) };
    });
}

export const handleReactionAdd = (payload: ReactionPayload) => handleReaction("reaction_add", payload);
export const handleReactionRemove = (payload: ReactionPayload) => handleReaction("reaction_remove", payload);
