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

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { migratePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { makeLazy } from "@utils/lazy";
import { sleep } from "@utils/misc";
import definePlugin from "@utils/types";
import { CommandArgument, CommandContext } from "@vencord/discord-types";
import { DraftType, UploadAttachmentStore, UploadHandler, UploadManager, UserStore, UserUtils } from "@webpack/common";
import { GIFEncoder, nearestColorIndex, quantize } from "gifenc";

const DEFAULT_DELAY = 20;
const DEFAULT_RESOLUTION = 128;
const FRAMES = 10;
let generation = 0;
let stopped = false;

const getFrames = makeLazy(() => Promise.all(
    Array.from(
        { length: FRAMES },
        (_, i) => loadImage(`https://raw.githubusercontent.com/VenPlugs/petpet/main/frames/pet${i}.gif`)
    ))
);

function loadImage(source: File | string) {
    const isFile = source instanceof File;
    const url = isFile ? URL.createObjectURL(source) : source;

    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        const revokeUrl = () => {
            if (isFile) URL.revokeObjectURL(url);
        };

        img.onload = () => {
            revokeUrl();
            resolve(img);
        };
        img.onerror = _event => {
            revokeUrl();
            reject(Error(`An error occurred while loading ${url}. Check the console for more info.`));
        };
        img.crossOrigin = "Anonymous";
        img.src = url;
    });
}

async function resolveImage(options: CommandArgument[], ctx: CommandContext, noServerPfp: boolean): Promise<File | string | null> {
    for (const opt of options) {
        switch (opt.name) {
            case "image":
                const upload = UploadAttachmentStore.getUpload(ctx.channel.id, opt.name, DraftType.SlashCommand);
                if (upload) {
                    if (!upload.isImage) {
                        UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                        throw "Upload is not an image";
                    }
                    return upload.item.file;
                }
                break;
            case "url":
                return opt.value;
            case "user":
                try {
                    const user = await UserUtils.getUser(opt.value);
                    return user.getAvatarURL(noServerPfp ? void 0 : ctx.guild?.id, 2048).replace(/\?size=\d+$/, "?size=2048");
                } catch (err) {
                    console.error("[petpet] Failed to fetch user\n", err);
                    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
                    throw "Failed to fetch user. Check the console for more info.";
                }
        }
    }
    UploadManager.clearAll(ctx.channel.id, DraftType.SlashCommand);
    return null;
}

function rgb888_to_rgb565(r: number, g: number, b: number): number {
    return ((r << 8) & 0xf800) | ((g << 3) & 0x07e0) | (b >> 3);
}

function applyPaletteTransparent(data: Uint8Array | Uint8ClampedArray, palette: number[][], cache: number[], threshold: number): Uint8Array {
    const index = new Uint8Array(Math.floor(data.length / 4));

    for (let i = 0; i < index.length; i += 1) {
        const r = data[4 * i];
        const g = data[4 * i + 1];
        const b = data[4 * i + 2];
        const a = data[4 * i + 3];

        if (a < threshold) {
            index[i] = 255;
        } else {
            const key = rgb888_to_rgb565(r, g, b);
            index[i] = key in cache ? cache[key] : (cache[key] = nearestColorIndex(palette, [r, g, b]));
        }
    }
    return index;
}

migratePluginSettings("PetPet", "petpet");
export default definePlugin({
    name: "PetPet",
    performance: {
        impact: "low",
        description: "Generates and encodes an animated GIF only when the command is invoked."
    },
    description: "Adds a /petpet slash command to create headpet gifs from any image",
    dependencies: ["CommandsAPI"],
    tags: ["Fun", "Commands"],
    authors: [Devs.Ven, Devs.u32],
    start() { stopped = false; },
    stop() { stopped = true; generation++; },
    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "petpet",
            description: "Create a petpet gif. You can only specify one of the image options",
            options: [
                {
                    name: "delay",
                    description: "The delay between each frame in ms. Rounded to nearest 10ms. Defaults to the minimum value of 20.",
                    type: ApplicationCommandOptionType.INTEGER
                },
                {
                    name: "resolution",
                    description: "Output size in pixels, from 16 to 512. Defaults to 128.",
                    type: ApplicationCommandOptionType.INTEGER
                },
                {
                    name: "image",
                    description: "Image attachment to use",
                    type: ApplicationCommandOptionType.ATTACHMENT
                },
                {
                    name: "url",
                    description: "URL to fetch image from",
                    type: ApplicationCommandOptionType.STRING
                },
                {
                    name: "user",
                    description: "User whose avatar to use as image",
                    type: ApplicationCommandOptionType.USER
                },
                {
                    name: "no-server-pfp",
                    description: "Use the normal avatar instead of the server specific one when using the 'user' option",
                    type: ApplicationCommandOptionType.BOOLEAN
                }
            ],
            execute: async (opts, cmdCtx) => {
                const owner = generation;
                const userId = UserStore.getCurrentUser()?.id;
                const current = () => !stopped && generation === owner && UserStore.getCurrentUser()?.id === userId;
                if (!current()) return;
                const resolution = findOption(opts, "resolution", DEFAULT_RESOLUTION);
                if (!Number.isSafeInteger(resolution) || resolution < 16 || resolution > 512)
                    return sendBotMessage(cmdCtx.channel.id, { content: "Resolution must be a whole number from 16 to 512." });
                const delay = findOption(opts, "delay", DEFAULT_DELAY);
                if (!Number.isSafeInteger(delay) || delay < 20 || delay > 655350)
                    return sendBotMessage(cmdCtx.channel.id, { content: "Delay must be a whole number from 20 to 655350 milliseconds." });
                const frames = await getFrames();
                if (!current()) return;

                const noServerPfp = findOption(opts, "no-server-pfp", false);
                try {
                    var url = await resolveImage(opts, cmdCtx, noServerPfp);
                    if (!current()) return;
                    if (!url) throw "No Image specified!";
                } catch (err) {
                    UploadManager.clearAll(cmdCtx.channel.id, DraftType.SlashCommand);
                    sendBotMessage(cmdCtx.channel.id, {
                        content: String(err),
                    });
                    return;
                }

                const avatar = await loadImage(url);
                if (!current()) return;
                if (avatar.naturalWidth * avatar.naturalHeight > 4 * 1024 * 1024)
                    return sendBotMessage(cmdCtx.channel.id, { content: "Choose an image with at most 4 million pixels." });

                const gif = GIFEncoder();

                const paletteImageSize = Math.min(120, resolution);

                const canvas = document.createElement("canvas");
                canvas.width = resolution;
                // Ensure there is sufficient space for the palette generation image
                canvas.height = Math.max(resolution, 2 * paletteImageSize);

                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx) return;

                UploadManager.clearAll(cmdCtx.channel.id, DraftType.SlashCommand);

                // Generate palette from an image where hand and avatar are fully visible
                ctx.drawImage(avatar, 0, paletteImageSize, 0.8 * paletteImageSize, 0.8 * paletteImageSize);
                ctx.drawImage(frames[0], 0, 0, paletteImageSize, paletteImageSize);
                const { data } = ctx.getImageData(0, 0, paletteImageSize, 2 * paletteImageSize);
                const palette = quantize(data, 255);

                const cache = new Array(2 ** 16);

                for (let i = 0; i < FRAMES; i++) {
                    if (!current()) return;
                    ctx.clearRect(0, 0, canvas.width, canvas.height);

                    const j = i < FRAMES / 2 ? i : FRAMES - i;
                    const width = 0.8 + j * 0.02;
                    const height = 0.8 - j * 0.05;
                    const offsetX = (1 - width) * 0.5 + 0.1;
                    const offsetY = 1 - height - 0.08;

                    ctx.drawImage(avatar, offsetX * resolution, offsetY * resolution, width * resolution, height * resolution);
                    ctx.drawImage(frames[i], 0, 0, resolution, resolution);

                    const { data } = ctx.getImageData(0, 0, resolution, resolution);
                    const index = applyPaletteTransparent(data, palette, cache, 1);

                    gif.writeFrame(index, resolution, resolution, {
                        transparent: true,
                        transparentIndex: 255,
                        delay,
                        palette: i === 0 ? palette : undefined,
                    });
                    await sleep(0);
                }

                gif.finish();
                // usage adheres to mdn https://developer.mozilla.org/en-US/docs/Web/API/File/File#parameters
                const file = new File([new Uint8Array(gif.bytesView())], "petpet.gif", { type: "image/gif" });
                // Immediately after the command finishes, Discord clears all input, including pending attachments.
                // Thus, setTimeout is needed to make this execute after Discord cleared the input
                setTimeout(() => { if (current()) UploadHandler.promptToUpload([file], cmdCtx.channel, DraftType.ChannelMessage); }, 10);
            },
        },
    ]
});
