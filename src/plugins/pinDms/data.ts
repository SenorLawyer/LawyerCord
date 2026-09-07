/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PinOrder, PrivateChannelSortStore, settings } from "@plugins/pinDms";
import { useForceUpdater } from "@utils/react";
import { useEffect, UserStore } from "@webpack/common";

export interface Category {
    id: string;
    name: string;
    color: number;
    channels: string[];
    collapsed?: boolean;
}

const SETTINGS_KEYS = ["pinOrder", "canCollapseDmSection", "dmSectionCollapsed", "userBasedCategoryList"] satisfies Array<keyof typeof settings.store>;

let forceUpdateDms: (() => void) | undefined = undefined;
let lastPrivateChannelIds: string[] | null = null;
const lastSortOrder = new Map<string, number>();

export function getCurrentUserCategories(): Category[] {
    const userId = UserStore.getCurrentUser()?.id;
    return userId == null ? [] : settings.store.userBasedCategoryList[userId] ??= [];
}

export function init() {
    forceUpdateDms?.();
}

export function usePinnedDms() {
    const forceUpdate = useForceUpdater();
    useEffect(() => {
        forceUpdateDms = forceUpdate;
        return () => {
            if (forceUpdateDms === forceUpdate) forceUpdateDms = undefined;
        };
    }, [forceUpdate]);
    settings.use(SETTINGS_KEYS);
}

export function getCategory(id: string) {
    return getCurrentUserCategories().find(c => c.id === id);
}

export function getCategoryByIndex(index: number) {
    return getCurrentUserCategories()[index];
}

export function createCategory(category: Category) {
    const categories = getCurrentUserCategories();
    if (!categories.some(c => c.id === category.id)) categories.push(category);
}

export function addChannelToCategory(channelId: string, categoryId: string) {
    const category = getCurrentUserCategories().find(c => c.id === categoryId);
    if (category == null) return;

    if (category.channels.includes(channelId)) return;

    category.channels.push(channelId);
}

export function removeChannelFromCategory(channelId: string) {
    const category = getCurrentUserCategories().find(c => c.channels.includes(channelId));
    if (category == null) return;

    category.channels = category.channels.filter(c => c !== channelId);
}

export function removeCategory(categoryId: string) {
    const categories = getCurrentUserCategories();
    const categoryIndex = categories.findIndex(c => c.id === categoryId);
    if (categoryIndex === -1) return;

    categories.splice(categoryIndex, 1);
}

export function collapseCategory(id: string, value = true) {
    const category = getCurrentUserCategories().find(c => c.id === id);
    if (category == null) return;

    category.collapsed = value;
}

// Utils
export function isPinned(id: string) {
    return getCurrentUserCategories().some(c => c.channels.includes(id));
}

export function categoryLen() {
    return getCurrentUserCategories().length;
}

export function getSections() {
    return getCurrentUserCategories().reduce((acc, category) => {
        acc.push(category.channels.length === 0 ? 1 : category.channels.length);
        return acc;
    }, [] as number[]);
}

function getSortOrder(ids: string[]) {
    if (ids !== lastPrivateChannelIds) {
        lastPrivateChannelIds = ids;
        lastSortOrder.clear();
        for (let i = 0; i < ids.length; i++) {
            lastSortOrder.set(ids[i], i);
        }
    }
    return lastSortOrder;
}

export function getCategoryChannels(category: Category): string[] {
    if (category.channels.length === 0) return [];

    if (settings.store.pinOrder === PinOrder.LastMessage) {
        const sortedChannels = PrivateChannelSortStore.getPrivateChannelIds();
        const order = getSortOrder(sortedChannels);
        return [...category.channels].sort((a, b) => {
            return (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity);
        });
    }

    return category.channels;
}

export function getAllUncollapsedChannels() {
    return getCurrentUserCategories()
        .filter(c => !c.collapsed)
        .flatMap(getCategoryChannels);
}

// Move categories
export const canMoveArrayInDirection = (array: any[], index: number, direction: -1 | 1) => {
    const a = array[index];
    const b = array[index + direction];

    return a && b;
};

export const canMoveCategoryInDirection = (id: string, direction: -1 | 1) => {
    const categories = getCurrentUserCategories();
    const categoryIndex = categories.findIndex(m => m.id === id);
    return canMoveArrayInDirection(categories, categoryIndex, direction);
};

export const canMoveCategory = (id: string) => canMoveCategoryInDirection(id, -1) || canMoveCategoryInDirection(id, 1);

export const canMoveChannelInDirection = (channelId: string, direction: -1 | 1) => {
    const category = getCurrentUserCategories().find(c => c.channels.includes(channelId));
    if (category == null) return false;

    const channelIndex = category.channels.indexOf(channelId);
    return canMoveArrayInDirection(category.channels, channelIndex, direction);
};

function swapElementsInArray(array: any[], index1: number, index2: number) {
    if (!array[index1] || !array[index2]) return;
    [array[index1], array[index2]] = [array[index2], array[index1]];
}

export function moveCategory(id: string, direction: -1 | 1) {
    const categories = getCurrentUserCategories();
    const a = categories.findIndex(m => m.id === id);
    const b = a + direction;

    swapElementsInArray(categories, a, b);
}

export function moveChannel(channelId: string, direction: -1 | 1) {
    const category = getCurrentUserCategories().find(c => c.channels.includes(channelId));
    if (category == null) return;

    const a = category.channels.indexOf(channelId);
    const b = a + direction;

    swapElementsInArray(category.channels, a, b);
}
