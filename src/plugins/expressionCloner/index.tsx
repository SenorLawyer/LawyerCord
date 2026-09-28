/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { migratePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { getGuildAcronym } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { isObject, tryOrElse } from "@utils/misc";
import definePlugin from "@utils/types";
import { Guild, GuildSticker } from "@vencord/discord-types";
import { StickerFormatType } from "@vencord/discord-types/enums";
import { findByCodeLazy } from "@webpack";
import { Constants, EmojiStore, FluxDispatcher, GuildStore, IconUtils, lodash, Menu, Modal, openModalLazy, PermissionsBits, PermissionStore, React, RestAPI, StickersStore, TextInput, Toasts, Tooltip, UserStore, useStateFromStores } from "@webpack/common";
import { Promisable } from "type-fest";

const logger = new Logger("ExpressionCloner");
let cloneController: AbortController | undefined;

const uploadEmoji = findByCodeLazy(".GUILD_EMOJIS(", "EMOJI_UPLOAD_START");

const getGuildMaxEmojiSlots = findByCodeLazy(".additionalEmojiSlots") as (guild: Guild) => number;

interface Sticker extends GuildSticker {
    t: "Sticker";
}

interface Emoji {
    t: "Emoji";
    id: string;
    name: string;
    isAnimated: boolean;
}

type Data = Emoji | Sticker;

const StickerExtMap = {
    [StickerFormatType.PNG]: "png",
    [StickerFormatType.APNG]: "png",
    [StickerFormatType.LOTTIE]: "json",
    [StickerFormatType.GIF]: "gif"
} as const;

const PremiumTierStickerLimitMap = {
    0: 5,
    1: 15,
    2: 30,
    3: 60
} as const;

const MAX_EMOJI_SIZE_BYTES = 256 * 1024;
const MAX_STICKER_SIZE_BYTES = 512 * 1024;

function getGuildMaxStickerSlots(guild: Guild) {
    if (guild.features.has("MORE_STICKERS") && guild.premiumTier === 3)
        return 120;

    return PremiumTierStickerLimitMap[guild.premiumTier] ?? PremiumTierStickerLimitMap[0];
}

function getUrl(data: Data, size: number) {
    if (data.t === "Emoji")
        return `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/emojis/${data.id}.webp?size=${size}&lossless=true&animated=true`;

    return `${window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT}/stickers/${data.id}.${StickerExtMap[data.format_type]}?size=${size}&lossless=true&animated=true`;
}

async function fetchSticker(id: string) {
    const cached = StickersStore.getStickerById(id);
    if (cached) return cached;

    const { body } = await RestAPI.get({
        url: Constants.Endpoints.STICKER(id)
    });

    FluxDispatcher.dispatch({
        type: "STICKER_FETCH_SUCCESS",
        sticker: body
    });

    return body as Sticker;
}

function ensureCloneAccount(userId: string, signal: AbortSignal | undefined) {
    if (!signal || signal.aborted || UserStore.getCurrentUser()?.id !== userId)
        throw new Error("The cloning session ended.");
}

async function cloneSticker(guildId: string, sticker: Sticker, userId: string, signal = cloneController?.signal) {
    const data = new FormData();
    data.append("name", sticker.name);
    data.append("tags", sticker.tags);
    data.append("description", sticker.description);
    data.append("file", await fetchBlob(sticker, signal));

    ensureCloneAccount(userId, signal);
    const { body } = await RestAPI.post({
        url: Constants.Endpoints.GUILD_STICKER_PACKS(guildId),
        body: data,
    });

    ensureCloneAccount(userId, signal);
    FluxDispatcher.dispatch({
        type: "GUILD_STICKERS_CREATE_SUCCESS",
        guildId,
        sticker: {
            ...body,
            user: UserStore.getCurrentUser()
        }
    });
}

async function cloneEmoji(guildId: string, emoji: Emoji, userId: string, signal = cloneController?.signal) {
    const data = await fetchBlob(emoji, signal);

    const reader = new FileReader();
    const abort = () => reader.abort();
    let dataUrl: string;
    try {
        ensureCloneAccount(userId, signal);
        dataUrl = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.onabort = () => reject(new Error("The cloning session ended."));
            signal?.addEventListener("abort", abort, { once: true });
            reader.readAsDataURL(data);
        });
    } finally {
        signal?.removeEventListener("abort", abort);
    }

    ensureCloneAccount(userId, signal);
    return uploadEmoji({
        guildId,
        name: emoji.name.split("~")[0],
        image: dataUrl
    });
}

function getGuildCandidates(data: Data) {
    const meId = UserStore.getCurrentUser()?.id;
    if (!meId) return [];

    return Object.values(GuildStore.getGuilds()).filter(g => {
        const canCreate = g.ownerId === meId ||
            (PermissionStore.getGuildPermissions({ id: g.id }) & PermissionsBits.CREATE_GUILD_EXPRESSIONS) === PermissionsBits.CREATE_GUILD_EXPRESSIONS;
        if (!canCreate) return false;

        if (data.t === "Sticker") {
            const stickerSlots = getGuildMaxStickerSlots(g);
            const stickers = StickersStore.getStickersByGuildId(g.id);

            return !stickers || stickers.length < stickerSlots;
        }

        const { isAnimated } = data as Emoji;

        const emojiSlots = getGuildMaxEmojiSlots(g);
        const emojis = EmojiStore.getGuildEmoji(g.id);

        let count = 0;
        for (const emoji of emojis) {
            if (emoji.animated === isAnimated && !emoji.managed) {
                count++;
            }
        }

        return count < emojiSlots;
    }).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchBlob(data: Data, signal: AbortSignal | undefined) {
    const MAX_SIZE = data.t === "Sticker"
        ? MAX_STICKER_SIZE_BYTES
        : MAX_EMOJI_SIZE_BYTES;

    for (let size = 4096; size >= 16; size /= 2) {
        const url = getUrl(data, size);
        const res = await fetch(url, { signal });
        if (!res.ok)
            throw new Error(`Failed to fetch ${url} - ${res.status}`);

        const blob = await res.blob();
        if (blob.size <= MAX_SIZE)
            return blob;
    }

    throw new Error(`Failed to fetch ${data.t} within size limit of ${MAX_SIZE / 1000}kB`);
}

async function doClone(guildId: string, data: Sticker | Emoji, controller = new AbortController()) {
    const sessionSignal = cloneController?.signal;
    const abort = () => controller.abort();
    if (!sessionSignal || sessionSignal.aborted) abort();
    else sessionSignal.addEventListener("abort", abort, { once: true });
    try {
        const userId = UserStore.getCurrentUser()?.id;
        const { signal } = controller;
        if (!userId) throw new Error("Sign in before cloning an expression.");
        ensureCloneAccount(userId, signal);
        if (data.t === "Sticker")
            await cloneSticker(guildId, data, userId, signal);
        else
            await cloneEmoji(guildId, data, userId, signal);

        ensureCloneAccount(userId, signal);
        Toasts.show({
            message: `Successfully cloned ${data.name} to ${GuildStore.getGuild(guildId)?.name ?? "your server"}!`,
            type: Toasts.Type.SUCCESS,
            id: Toasts.genId()
        });
    } catch (error) {
        if (controller.signal.aborted) return;
        let message = "Something went wrong.";
        if (isObject(error) && "text" in error && typeof error.text === "string") {
            const { text } = error;
            const body: unknown = tryOrElse(() => JSON.parse(text), null);
            if (isObject(body) && "message" in body && typeof body.message === "string" && body.message.trim())
                message = body.message;
        }

        logger.error("Failed to clone expression.", error);
        Toasts.show({
            message: "Failed to clone: " + message,
            type: Toasts.Type.FAILURE,
            id: Toasts.genId()
        });
    } finally {
        sessionSignal?.removeEventListener("abort", abort);
    }
}

const getFontSize = (s: string) => {
    // [18, 18, 16, 16, 14, 12, 10]
    const sizes = [20, 20, 18, 18, 16, 14, 12];
    return sizes[s.length] ?? 4;
};

const nameValidator = /^\w{2,32}$/;

function CloneModal({ data }: { data: Sticker | Emoji; }) {
    const pendingClone = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => pendingClone.current?.abort(), []);
    const [isCloning, setIsCloning] = React.useState(false);
    const [name, setName] = React.useState(data.t === "Emoji" ? data.name.split("~")[0] : data.name);
    const nameError = data.t === "Emoji"
        ? nameValidator.test(name) ? undefined : "Emoji names must be 2 to 32 characters and use only letters, numbers, or underscores."
        : name.length >= 2 && name.length <= 30 ? undefined : "Sticker names must be 2 to 30 characters.";

    const guilds = useStateFromStores(
        [UserStore, GuildStore, PermissionStore, EmojiStore, StickersStore],
        () => getGuildCandidates(data), [data], lodash.isEqual
    );

    return (
        <>
            <Heading tag="h5">Custom Name</Heading>
            <TextInput value={name} onChange={setName} error={nameError} />
            <div style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "1em",
                padding: "1em 0.5em",
                justifyContent: "center",
                alignItems: "center"
            }}>
                {guilds.map(g => (
                    <Tooltip key={g.id} text={g.name}>
                        {({ onMouseLeave, onMouseEnter }) => (
                            <Button
                                type="button"
                                variant="none"
                                size="iconOnly"
                                onMouseLeave={onMouseLeave}
                                onMouseEnter={onMouseEnter}
                                aria-label={"Clone to " + g.name}
                                disabled={isCloning || !!nameError}
                                style={{
                                    borderRadius: "50%",
                                    backgroundColor: "var(--background-base-lower)",
                                    display: "inline-flex",
                                    justifyContent: "center",
                                    alignItems: "center",
                                    width: "4em",
                                    height: "4em",
                                    fontSize: "inherit"
                                }}
                                onClick={() => {
                                    if (pendingClone.current) return;
                                    const controller = pendingClone.current = new AbortController();
                                    setIsCloning(true);
                                    return doClone(g.id, { ...data, name }, controller).finally(() => {
                                        pendingClone.current = null;
                                        setIsCloning(false);
                                    });
                                }}
                            >
                                {g.icon ? (
                                    <img
                                        aria-hidden
                                        style={{
                                            borderRadius: "50%",
                                            width: "100%",
                                            height: "100%",
                                        }}
                                        src={IconUtils.getGuildIconURL({
                                            id: g.id,
                                            icon: g.icon,
                                            canAnimate: true,
                                            size: 512
                                        })}
                                        alt={g.name}
                                    />
                                ) : (
                                    <Paragraph
                                        style={{
                                            fontSize: getFontSize(getGuildAcronym(g)),
                                            width: "100%",
                                            overflow: "hidden",
                                            whiteSpace: "nowrap",
                                            textAlign: "center",
                                            cursor: isCloning ? "not-allowed" : "pointer",
                                        }}
                                    >
                                        {getGuildAcronym(g)}
                                    </Paragraph>
                                )}
                            </Button>
                        )}
                    </Tooltip>
                ))}
            </div>
        </>
    );
}

function buildMenuItem(type: "Emoji" | "Sticker", fetchData: () => Promisable<Omit<Sticker | Emoji, "t">>) {
    return (
        <Menu.MenuItem
            id="emote-cloner"
            key="emote-cloner"
            label={`Clone ${type}`}
            action={() =>
                openModalLazy(async () => {
                    const res = await fetchData();
                    const data = { t: type, ...res } as Sticker | Emoji;
                    const url = getUrl(data, 128);

                    return modalProps => (
                        <Modal
                            {...modalProps}
                            title={
                                <Flex gap="0.5em" alignItems="center">
                                    <img
                                        role="presentation"
                                        aria-hidden
                                        src={url}
                                        alt=""
                                        height={24}
                                        width={24}
                                    />
                                    <BaseText tag="h3" size="md" weight="medium">Clone {data.name}</BaseText>
                                </Flex>
                            }
                        >
                            <CloneModal data={data} />
                        </Modal>
                    );
                })
            }
        />
    );
}

function isGifUrl(url: string) {
    const u = new URL(url);
    return u.pathname.endsWith(".gif") || u.searchParams.get("animated") === "true";
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const { favoriteableId, itemHref, itemSrc, favoriteableType } = props ?? {};

    if (!favoriteableId) return;

    const menuItem = (() => {
        switch (favoriteableType) {
            case "emoji":
                const match = props.message.content.match(RegExp(`<a?:(\\w+)(?:~\\d+)?:${favoriteableId}>|https://cdn\\.discordapp\\.com/emojis/${favoriteableId}\\.`));
                const reaction = props.message.reactions.find(reaction => reaction.emoji.id === favoriteableId);
                if (!match && !reaction) return;
                const name = (match && match[1]) ?? reaction?.emoji.name ?? "FakeNitroEmoji";

                return buildMenuItem("Emoji", () => ({
                    id: favoriteableId,
                    name,
                    isAnimated: isGifUrl(itemHref ?? itemSrc)
                }));
            case "sticker":
                const sticker = props.message.stickerItems.find(s => s.id === favoriteableId);
                if (sticker?.format_type === 3 /* LOTTIE */) return;

                return buildMenuItem("Sticker", () => fetchSticker(favoriteableId));
        }
    })();

    if (menuItem)
        findGroupChildrenByChildId("copy-link", children)?.push(menuItem);
};

const expressionPickerPatch: NavContextMenuPatchCallback = (children, props: { target: HTMLElement; }) => {
    const { id, name, type } = props?.target?.dataset ?? {};
    if (!id) return;

    if (type === "emoji" && name) {
        const firstChild = props.target.firstChild as HTMLImageElement;

        children.push(buildMenuItem("Emoji", () => ({
            id,
            name,
            isAnimated: firstChild && isGifUrl(firstChild.src)
        })));
    } else if (type === "sticker") {
        const sticker = StickersStore.getStickerById(id);
        if (!sticker || sticker.format_type === StickerFormatType.LOTTIE) return;
        children.push(buildMenuItem("Sticker", () => fetchSticker(id)));
    }
};

migratePluginSettings("ExpressionCloner", "EmoteCloner");
export default definePlugin({
    name: "ExpressionCloner",
    description: "Allows you to clone Emotes & Stickers to your own server (right click them)",
    tags: ["Emotes", "Servers"],
    searchTerms: ["StickerCloner", "EmoteCloner", "EmojiCloner"],
    authors: [Devs.Ven, Devs.Nuckyz],
    start() {
        cloneController?.abort();
        cloneController = new AbortController();
    },
    stop() {
        cloneController?.abort();
        cloneController = undefined;
    },
    flux: {
        LOGOUT() {
            cloneController?.abort();
            if (cloneController) cloneController = new AbortController();
        }
    },
    contextMenus: {
        "message": messageContextMenuPatch,
        "expression-picker": expressionPickerPatch
    }
});
