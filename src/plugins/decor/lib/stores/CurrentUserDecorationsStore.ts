/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Decoration, deleteDecoration, getUserDecoration, getUserDecorations, NewDecoration, setUserDecoration } from "@plugins/decor/lib/api";
import { decorationToAsset } from "@plugins/decor/lib/utils/decoration";
import { proxyLazy } from "@utils/lazy";
import { UserStore, zustandCreate } from "@webpack/common";

import { useUsersDecorationsStore } from "./UsersDecorationsStore";

interface UserDecorationsState {
    decorations: Decoration[];
    selectedDecoration: Decoration | null;
    fetch: () => Promise<void>;
    delete: (decoration: Decoration | string) => Promise<void>;
    create: (decoration: NewDecoration) => Promise<void>;
    select: (decoration: Decoration | null) => Promise<void>;
    clear: () => void;
}

let generation = 0;

export const useCurrentUserDecorationsStore = proxyLazy(() => zustandCreate((set: (state: Partial<UserDecorationsState>) => void, get: () => UserDecorationsState) => ({
    decorations: [],
    selectedDecoration: null,
    async fetch() {
        const owner = generation;
        const decorations = await getUserDecorations();
        if (owner !== generation) return;
        const selectedDecoration = await getUserDecoration();
        if (owner !== generation) return;
        set({ decorations, selectedDecoration });
    },
    async create(newDecoration: NewDecoration) {
        const owner = generation;
        const decoration = (await setUserDecoration(newDecoration)) as Decoration;
        if (owner !== generation) return;
        set({ decorations: [...get().decorations, decoration] });
    },
    async delete(decoration: Decoration | string) {
        const owner = generation;
        const hash = typeof decoration === "object" ? decoration.hash : decoration;
        await deleteDecoration(hash);
        if (owner !== generation) return;

        const { selectedDecoration, decorations } = get();
        const newState = {
            decorations: decorations.filter(d => d.hash !== hash),
            selectedDecoration: selectedDecoration?.hash === hash ? null : selectedDecoration
        };

        set(newState);
    },
    async select(decoration: Decoration | null) {
        if (get().selectedDecoration === decoration) return;
        set({ selectedDecoration: decoration });
        setUserDecoration(decoration);
        const currentUserId = UserStore.getCurrentUser()?.id;
        if (currentUserId) {
            useUsersDecorationsStore.getState().set(currentUserId, decoration ? decorationToAsset(decoration) : null);
        }
    },
    clear() {
        generation++;
        set({ decorations: [], selectedDecoration: null });
    }
})));
