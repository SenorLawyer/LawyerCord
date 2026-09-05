/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isObject } from "@utils/misc";

import { API_URL } from "./constants";
import { useAuthorizationStore } from "./stores/AuthorizationStore";

export interface Preset {
    id: string;
    name: string;
    description: string | null;
    decorations: Decoration[];
    authorIds: string[];
}

export interface Decoration {
    hash: string;
    animated: boolean;
    alt: string | null;
    authorId: string | null;
    reviewed: boolean | null;
    presetId: string | null;
}

export interface NewDecoration {
    file: File;
    alt: string | null;
}

export async function fetchApi(url: RequestInfo, options?: RequestInit) {
    const res = await fetch(url, {
        ...options,
        headers: {
            ...options?.headers,
            Authorization: `Bearer ${useAuthorizationStore.getState().token}`
        }
    });

    if (res.ok) return res;
    else throw new Error(await res.text());
}

export const getUsersDecorations = async (ids: string[], signal?: AbortSignal): Promise<Record<string, string | null>> => {
    if (ids.length === 0) return {};

    const url = new URL(API_URL + "/users");
    url.searchParams.set("ids", JSON.stringify(ids));

    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Could not load decorations.");
    const data: unknown = await response.json();
    if (!isObject(data)) throw new Error("Invalid decoration response.");
    const decorations: Record<string, string | null> = {};
    for (const id of ids) {
        const asset = Object.hasOwn(data, id) ? data[id] : null;
        if (asset !== null && typeof asset !== "string") throw new Error("Invalid decoration response.");
        Object.defineProperty(decorations, id, { value: asset, enumerable: true });
    }
    return decorations;
};

export const getUserDecorations = async (id: string = "@me"): Promise<Decoration[]> =>
    fetchApi(API_URL + `/users/${id}/decorations`).then(c => c.json());

export const getUserDecoration = async (id: string = "@me"): Promise<Decoration | null> =>
    fetchApi(API_URL + `/users/${id}/decoration`).then(c => c.json());

export const setUserDecoration = async (decoration: Decoration | NewDecoration | null, id: string = "@me"): Promise<string | Decoration> => {
    const formData = new FormData();

    if (!decoration) {
        formData.append("hash", "null");
    } else if ("hash" in decoration) {
        formData.append("hash", decoration.hash);
    } else if ("file" in decoration) {
        formData.append("image", decoration.file);
        formData.append("alt", decoration.alt ?? "null");
    }

    return fetchApi(API_URL + `/users/${id}/decoration`, { method: "PUT", body: formData }).then(c =>
        decoration && "file" in decoration ? c.json() : c.text()
    );
};

export const getDecoration = async (hash: string): Promise<Decoration> => fetch(API_URL + `/decorations/${hash}`).then(c => c.json());

export const deleteDecoration = async (hash: string): Promise<void> => {
    await fetchApi(API_URL + `/decorations/${hash}`, { method: "DELETE" });
};

export const getPresets = async (): Promise<Preset[]> => fetch(API_URL + "/decorations/presets").then(c => c.json());
