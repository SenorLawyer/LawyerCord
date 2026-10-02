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

import { addMessagePreEditListener, addMessagePreSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Paragraph } from "@components/Paragraph";
import { readResponseBody } from "@equicordplugins/fileUpload/request";
import { convertApngToGif } from "@equicordplugins/fileUpload/utils/apngToGif";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { isObject } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Emoji, Message, RenderModalProps, Sticker } from "@vencord/discord-types";
import { StickerFormatType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findByPropsLazy, proxyLazyWebpack } from "@webpack";
import { ChannelStore, ConfirmModal, DraftType, EmojiStore, FluxDispatcher, GuildMemberStore, IconUtils, lodash, openModal, OverridePremiumTypeStore, Parser, PermissionsBits, PermissionStore, showToast, StickersStore, Toasts, UploadHandler, UserSettingsActionCreators, UserSettingsProtoStore,UserStore } from "@webpack/common";
import type { ReactElement, ReactNode } from "react";

const stickerJobs = new Set<AbortController>();
let stopped = false;

const BINARY_READ_OPTIONS = findByPropsLazy("readerFactory");

function searchProtoClassField(localName: string, protoClass: any) {
    const field = protoClass?.fields?.find((field: any) => field.localName === localName);
    if (!field) return;

    const fieldGetter = Object.values(field).find(value => typeof value === "function") as any;
    return fieldGetter?.();
}

const PreloadedUserSettingsActionCreators = proxyLazyWebpack(() => UserSettingsActionCreators.PreloadedUserSettingsActionCreators);
const AppearanceSettingsActionCreators = proxyLazyWebpack(() => searchProtoClassField("appearance", PreloadedUserSettingsActionCreators.ProtoClass));
const ClientThemeSettingsActionsCreators = proxyLazyWebpack(() => searchProtoClassField("clientThemeSettings", AppearanceSettingsActionCreators));

const isUnusableRoleSubscriptionEmoji = findByCodeLazy(".getUserIsAdmin(");

const enum EmojiIntentions {
    REACTION,
    STATUS,
    COMMUNITY_CONTENT,
    CHAT,
    GUILD_STICKER_RELATED_EMOJI,
    GUILD_ROLE_BENEFIT_EMOJI,
    COMMUNITY_CONTENT_ONLY,
    SOUNDBOARD,
    VOICE_CHANNEL_TOPIC,
    GIFT,
    AUTO_SUGGESTION,
    POLLS
}

const IS_BYPASSEABLE_INTENTION = `[${EmojiIntentions.CHAT},${EmojiIntentions.GUILD_STICKER_RELATED_EMOJI}].includes(fakeNitroIntention)`;

const enum FakeNoticeType {
    Sticker,
    Emoji
}

const fakeNitroEmojiRegex = /\/emojis\/(\d+?)\.(png|webp|gif)/;
const fakeNitroStickerRegex = /\/stickers\/(\d+?)\./;
const fakeNitroGifStickerRegex = /\/attachments\/\d+?\/\d+?\/(\d+?)\.gif/;
const hyperLinkRegex = /\[.+?\]\((https?:\/\/.+?)\)/;

const settings = definePluginSettings({
    enableEmojiBypass: {
        description: "Allows sending fake emojis (also bypasses missing permission to use custom emojis)",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    emojiSize: {
        description: "Size of the emojis when sending",
        type: OptionType.SLIDER,
        default: 48,
        markers: [32, 48, 56, 64, 96, 128, 160, 256, 512]
    },
    transformEmojis: {
        description: "Whether to transform fake emojis into real ones",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    enableStickerBypass: {
        description: "Allows sending fake stickers (also bypasses missing permission to use stickers)",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    stickerSize: {
        description: "Size of the stickers when sending",
        type: OptionType.SLIDER,
        default: 160,
        markers: [32, 64, 128, 160, 256, 512]
    },
    transformStickers: {
        description: "Whether to transform fake stickers into real ones",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    transformCompoundSentence: {
        description: "Whether to transform fake stickers and emojis in compound sentences (sentences with more content than just the fake emoji or sticker link)",
        type: OptionType.BOOLEAN,
        default: false
    },
    enableStreamQualityBypass: {
        description: "Allow streaming in nitro quality",
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    useStickerHyperLinks: {
        description: "Whether to use hyperlinks when sending fake stickers",
        type: OptionType.BOOLEAN,
        default: true
    },
    useEmojiHyperLinks: {
        description: "Whether to use hyperlinks when sending fake emojis",
        type: OptionType.BOOLEAN,
        default: true
    },
    hyperLinkText: {
        description: "What text the hyperlink should use. {{NAME}} will be replaced with the emoji/sticker name.",
        type: OptionType.STRING,
        default: "{{NAME}}"
    },
    disableEmbedPermissionCheck: {
        description: "Whether to disable the embed permission check when sending fake emojis and stickers",
        type: OptionType.BOOLEAN,
        default: false
    },
});

function hasPermission(channelId: string, permission: bigint) {
    const channel = ChannelStore.getChannel(channelId);

    if (!channel || channel.isPrivate()) return true;

    return PermissionStore.can(permission, channel);
}

const hasExternalEmojiPerms = (channelId: string) => hasPermission(channelId, PermissionsBits.USE_EXTERNAL_EMOJIS);
const hasExternalStickerPerms = (channelId: string) => hasPermission(channelId, PermissionsBits.USE_EXTERNAL_STICKERS);
const hasEmbedPerms = (channelId: string) => hasPermission(channelId, PermissionsBits.EMBED_LINKS);
const hasAttachmentPerms = (channelId: string) => hasPermission(channelId, PermissionsBits.ATTACH_FILES);

function getWordBoundary(origStr: string, offset: number) {
    return (!origStr[offset] || /\s/.test(origStr[offset])) ? "" : " ";
}

function CannotEmbedNoticeModal({ modalProps, resolve }: { modalProps: RenderModalProps; resolve: (value: boolean) => void; }) {
    const s = settings.use(["disableEmbedPermissionCheck"]);
    return (
        <ConfirmModal
            {...modalProps}
            title="Hold on!"
            subtitle="You are trying to send/edit a message that contains a FakeNitro emoji or sticker, however you do not have permissions to embed links in the current channel. Are you sure you want to send this message? Your FakeNitro items will appear as a link only."
            confirmText="Send Anyway"
            cancelText="Cancel"
            onConfirm={() => resolve(true)}
            onCloseCallback={() => setImmediate(() => resolve(false))}
            checkboxProps={{
                checked: s.disableEmbedPermissionCheck === true,
                onChange: checked => s.disableEmbedPermissionCheck = checked
            }}
        />
    );
}

function showCannotEmbedNotice() {
    return new Promise<boolean>(resolve => {
        openModal(props => <CannotEmbedNoticeModal modalProps={props} resolve={resolve} />);
    });
}

export default definePlugin({
    name: "FakeNitro",
    performance: {
        impact: "medium",
        description: "Checks rendered messages for emoji and sticker links and converts media when sending."
    },
    authors: [Devs.Arjix, Devs.D3SOX, Devs.Ven, Devs.fawn, Devs.captain, Devs.Nuckyz, Devs.AutumnVN, Devs.sadan],
    description: "Allows you to send fake emojis/stickers, use nitro themes, and stream in nitro quality",
    tags: ["Emotes", "Appearance", "Customisation", "Chat"],
    dependencies: ["MessageEventsAPI"],

    settings,

    patches: [
        {
            find: "canUseCustomStickersEverywhere:",
            replacement: [
                {
                    match: /(?<=canUseCustomStickersEverywhere:function\(\i\)\{)/,
                    replace: "return true;",
                    predicate: () => settings.store.enableStickerBypass
                },
                {
                    match: /(?<=canUseHighVideoUploadQuality:function\(\i\)\{)/,
                    replace: "return true;",
                    predicate: () => settings.store.enableStreamQualityBypass
                },
                {
                    match: /(?<=canStreamQuality:function\(\i,\i\)\{)/,
                    replace: "return true;",
                    predicate: () => settings.store.enableStreamQualityBypass
                },
                {
                    match: /(?<=canUseClientThemes:function\(\i\)\{)/,
                    replace: "return true;"
                },
                {
                    match: /(?<=canUsePremiumAppIcons:function\(\i\)\{)/,
                    replace: "return true;"
                }
            ],
        },
        // Patch the emoji picker in voice calls to not be bypassed by fake nitro
        {
            find: '.getByName("fork_and_knife")',
            predicate: () => settings.store.enableEmojiBypass,
            replacement: {
                match: ".CHAT",
                replace: ".STATUS"
            }
        },
        {
            find: ".GUILD_SUBSCRIPTION_UNAVAILABLE;",
            group: true,
            predicate: () => settings.store.enableEmojiBypass,
            replacement: [
                {
                    // Create a variable for the intention of using the emoji
                    match: /(?<=\.USE_EXTERNAL_EMOJIS,\i\);)(?=if\((\i)===\i\.EmojiIntention\.COMMUNITY_CONTENT\))/,
                    replace: "const fakeNitroIntention=$1;"
                },
                {
                    // Disallow the emoji for external if the intention doesn't allow it
                    match: /&&!\i&&!\i(?=\)return \i\.\i\.DISALLOW_EXTERNAL;)/,
                    replace: m => `${m}&&!${IS_BYPASSEABLE_INTENTION}`
                },
                {
                    // Disallow the emoji for unavailable if the intention doesn't allow it
                    match: /!\i\.available(?=\)return \i\.\i\.GUILD_SUBSCRIPTION_UNAVAILABLE;)/,
                    replace: m => `${m}&&!${IS_BYPASSEABLE_INTENTION}`
                },
                {
                    // Disallow the emoji for premium locked if the intention doesn't allow it
                    match: /(?<=!\(\i\|\|)\i\.\i\.canUseEmojisEverywhere\(\i\)/,
                    replace: check => `(${check}||${IS_BYPASSEABLE_INTENTION})`
                },
                {
                    // Allow animated emojis to be used if the intention allows it
                    match: /(?<=\|\|)\i\.\i\.canUseAnimatedEmojis\(\i\)/,
                    replace: m => `(${m}||${IS_BYPASSEABLE_INTENTION})`
                }
            ]
        },
        // Allows the usage of subscription-locked emojis
        {
            find: ".getUserIsAdmin(",
            replacement: {
                match: /(function \i\(\i,\i)\)\{(?=[^}]{0,250}\.getUserIsAdmin\()/,
                replace: "$1,fakeNitroOriginal){if(!fakeNitroOriginal)return false;"
            }
        },
        // Make stickers always available
        {
            find: '"SENDABLE"',
            predicate: () => settings.store.enableStickerBypass,
            replacement: {
                match: /\i\.available\?/,
                replace: "true?"
            }
        },
        // Remove boost requirements to stream with high quality
        {
            find: "#{intl::STREAM_FPS_OPTION}",
            predicate: () => settings.store.enableStreamQualityBypass,
            replacement: {
                match: /guildPremiumTier:\i\.\i\.TIER_\d,?/g,
                replace: ""
            }
        },
        {
            find: '"UserSettingsProtoStore"',
            replacement: [
                {
                    // Overwrite incoming connection settings proto with our local settings
                    match: /(?<=CONNECTION_OPEN:function\((\i)\){)/,
                    replace: (_, props) => `$self.handleProtoChange(${props}.userSettingsProto,${props}.user);`
                },
                {
                    // Overwrite non local proto changes with our local settings
                    match: /let{settings:/,
                    replace: "arguments[0].local||$self.handleProtoChange(arguments[0].settings.proto);$&"
                }
            ]
        },
        // Call our function to handle changing the gradient theme when selecting a new one
        {
            find: ",updateTheme(",
            replacement: {
                match: /\i\.\i\.updateAsync\("appearance",\i=>\{\i\.theme=(\i\(\i\)),\i\.clientThemeSettings=\i\(\{(?=[^{}]{0,150}?backgroundGradientPresetId:(\i)(?:,|}))[^{}]{0,150}\}\)\},\i\)/,
                replace: "$self.handleGradientThemeSelect($2,$1,()=>$&);"
            }
        },
        // Allow users to use custom client themes
        {
            find: ".CLIENT_THEMES_EDITOR?",
            replacement: {
                match: /(?<=\i=)\(0,\i\.\i\)\(\i\.\i\.TIER_2\)(?=,|;)/g,
                replace: "true"
            }
        },
        {
            find: '["strong","em","u","text","inlineCode","s","spoiler"]',
            replacement: [
                {
                    // Call our function to decide whether the emoji link should be kept or not
                    predicate: () => settings.store.transformEmojis,
                    match: /1!==(\i)\.length\|\|1!==\i\.length/,
                    replace: (m, content) => `${m}||$self.shouldKeepEmojiLink(${content}[0])`
                },
                {
                    // Patch the rendered message content to add fake nitro emojis or remove sticker links
                    predicate: () => settings.store.transformEmojis || settings.store.transformStickers,
                    match: /(?=return{hasSpoilerEmbeds:\i,hasBailedAst:\i,content:(\i))/,
                    replace: (_, content) => `${content}=$self.patchFakeNitroEmojisOrRemoveStickersLinks(${content},arguments[2]?.formatInline);`
                }
            ]
        },
        {
            find: "}renderStickersAccessories(",
            replacement: [
                {
                    // Call our function to decide whether the embed should be ignored or not
                    predicate: () => settings.store.transformEmojis || settings.store.transformStickers,
                    match: /(renderEmbeds\((\i)\){)(.{0,150}?embeds\.map\(\((\i),\i\)?=>{)/,
                    replace: "$1const fakeNitroMessage=$2;$3if($self.shouldIgnoreEmbed($4,fakeNitroMessage))return null;"
                },
                {
                    // Patch the stickers array to add fake nitro stickers
                    predicate: () => settings.store.transformStickers,
                    match: /renderStickersAccessories\((\i)\){let (\i)=\(0,\i\.\i\)\(\i\)[^;]{0,100};/,
                    replace: "$&$2=$self.patchFakeNitroStickers($2,$1);"
                },
                {
                    // Filter attachments to remove fake nitro stickers or emojis
                    predicate: () => settings.store.transformStickers,
                    match: /renderAttachments\(\i\){[^;]{0,200}{attachments:(\i)[^;]{0,50};/,
                    replace: "$&$1=$self.filterAttachments($1);"
                }
            ]
        },
        {
            find: "#{intl::STICKER_POPOUT_UNJOINED_PRIVATE_GUILD_DESCRIPTION}",
            group: true,
            predicate: () => settings.store.transformStickers,
            replacement: [
                {
                    // Export the renderable sticker to be used in the fake nitro sticker notice
                    match: /let{renderableSticker:(\i).{0,270}sticker:\i,channel:\i,/,
                    replace: "$&fakeNitroRenderableSticker:$1,"
                },
                {
                    match: /(?<=let \i,\{)(?=[^{}]{0,150}sticker:\i(?:,|}))(?=[^{}]{0,150}closePopout:\i(?:,|}))/,
                    replace: "fakeNitroRenderableSticker,"
                },
                {
                    // Add the fake nitro sticker notice
                    match: /(?<=description:)\i(?=,sticker:\i)/,
                    replace: `$self.addFakeNotice(${FakeNoticeType.Sticker},$&,!!fakeNitroRenderableSticker?.fake)`
                }
            ]
        },
        {
            find: ".EMOJI_UPSELL_POPOUT_MORE_EMOJIS_OPENED,",
            predicate: () => settings.store.transformEmojis,
            replacement: {
                // Export the emoji node to be used in the fake nitro emoji notice
                match: /shouldHideRoleSubscriptionCTA:\i(?=,|})/,
                replace: "$&,fakeNitroNode:arguments[0].node"
            }
        },
        {
            find: "#{intl::EMOJI_POPOUT_UNJOINED_DISCOVERABLE_GUILD_DESCRIPTION}",
            predicate: () => settings.store.transformEmojis,
            replacement: {
                // Add the fake nitro emoji notice
                match: /(?<=emojiDescription:)\i(?=,|})/,
                replace: `$self.addFakeNotice(${FakeNoticeType.Emoji},$&,!!arguments[0]?.fakeNitroNode?.fake)`
            }
        },
        // Separate patch for allowing using custom app icons
        {
            find: "getCurrentDesktopIcon(),",
            replacement: {
                match: /\i\.\i\.isPremium\(\i\.\i\.getCurrentUser\(\)\)/,
                replace: "true"
            }
        },
        // Make all Soundboard sounds available
        {
            find: 'type:"GUILD_SOUNDBOARD_SOUND_CREATE"',
            replacement: {
                match: /(?<=type:"(?:SOUNDBOARD_SOUNDS_RECEIVED|GUILD_SOUNDBOARD_SOUND_CREATE|GUILD_SOUNDBOARD_SOUND_UPDATE|GUILD_SOUNDBOARD_SOUNDS_UPDATE)".{0,250}?available:)\i\.available/g,
                replace: "true"
            }
        },
    ],

    get canUseEmotes() {
        return (OverridePremiumTypeStore.getState().premiumTypeActual ?? 0) > 0;
    },

    get canUseStickers() {
        return (OverridePremiumTypeStore.getState().premiumTypeActual ?? 0) > 1;
    },

    handleProtoChange(proto: any, user: any) {
        try {
            if (proto == null || typeof proto === "string") return;
            const premiumType = OverridePremiumTypeStore.getState().premiumTypeActual ?? 0;

            if (premiumType !== 2) {
                proto.appearance ??= AppearanceSettingsActionCreators.create();

                const protoStoreAppearenceSettings = UserSettingsProtoStore.settings.appearance;

                const appearanceSettingsOverwrite = AppearanceSettingsActionCreators.create({
                    ...proto.appearance,
                    theme: protoStoreAppearenceSettings?.theme,
                    clientThemeSettings: protoStoreAppearenceSettings?.clientThemeSettings
                });

                proto.appearance = appearanceSettingsOverwrite;
            }
        } catch (err) {
            new Logger("FakeNitro").error(err);
        }
    },

    handleGradientThemeSelect(backgroundGradientPresetId: number | undefined, theme: number, original: () => void) {
        const premiumType = OverridePremiumTypeStore.getState().premiumTypeActual ?? 0;
        if (premiumType === 2 || backgroundGradientPresetId == null) return original();

        if (!PreloadedUserSettingsActionCreators || !AppearanceSettingsActionCreators || !ClientThemeSettingsActionsCreators || !BINARY_READ_OPTIONS) return;

        const currentAppearanceSettings = PreloadedUserSettingsActionCreators.getCurrentValue().appearance;

        const newAppearanceProto = currentAppearanceSettings != null
            ? AppearanceSettingsActionCreators.fromBinary(AppearanceSettingsActionCreators.toBinary(currentAppearanceSettings), BINARY_READ_OPTIONS)
            : AppearanceSettingsActionCreators.create();

        newAppearanceProto.theme = theme;

        const clientThemeSettingsDummy = ClientThemeSettingsActionsCreators.create({
            backgroundGradientPresetId: {
                value: backgroundGradientPresetId
            }
        });

        newAppearanceProto.clientThemeSettings ??= clientThemeSettingsDummy;
        newAppearanceProto.clientThemeSettings.backgroundGradientPresetId = clientThemeSettingsDummy.backgroundGradientPresetId;

        const proto = PreloadedUserSettingsActionCreators.ProtoClass.create();
        proto.appearance = newAppearanceProto;

        FluxDispatcher.dispatch({
            type: "USER_SETTINGS_PROTO_UPDATE",
            local: true,
            partial: true,
            settings: {
                type: 1,
                proto
            }
        });
    },

    trimContent(content: Array<any>) {
        const firstContent = content[0];
        if (typeof firstContent === "string") {
            content[0] = firstContent.trimStart();
            content[0] || content.shift();
        } else if (typeof firstContent?.props?.children === "string") {
            firstContent.props.children = firstContent.props.children.trimStart();
            firstContent.props.children || content.shift();
        }

        const lastIndex = content.length - 1;
        const lastContent = content[lastIndex];
        if (typeof lastContent === "string") {
            content[lastIndex] = lastContent.trimEnd();
            content[lastIndex] || content.pop();
        } else if (typeof lastContent?.props?.children === "string") {
            lastContent.props.children = lastContent.props.children.trimEnd();
            lastContent.props.children || content.pop();
        }
    },

    clearEmptyArrayItems(array: Array<any>) {
        return array.filter(item => item != null);
    },

    ensureChildrenIsArray(child: ReactElement<any>) {
        if (!Array.isArray(child.props.children)) child.props.children = [child.props.children];
    },

    patchFakeNitroEmojisOrRemoveStickersLinks(content: Array<any>, inline: boolean) {
        // If content has more than one child or it's a single ReactElement like a header, list or span
        if ((content.length > 1 || typeof content[0]?.type === "string") && !settings.store.transformCompoundSentence) return content;

        const { transformEmojis, transformStickers } = settings.store;
        const hasTransformableLink = (node: unknown): boolean => {
            if (Array.isArray(node)) return node.some(hasTransformableLink);
            if (!isObject(node) || !("props" in node) || !isObject(node.props)) return false;
            const { props } = node;
            if ("trusted" in props && props.trusted != null) {
                if (!("href" in props) || typeof props.href !== "string") return false;
                if (transformEmojis && fakeNitroEmojiRegex.test(props.href)) return true;
                if (!transformStickers) return false;
                if (fakeNitroStickerRegex.test(props.href)) return true;
                const gifMatch = props.href.match(fakeNitroGifStickerRegex);
                return !!gifMatch && !!StickersStore.getStickerById(gifMatch[1]);
            }
            return "children" in props && hasTransformableLink(props.children);
        };
        if (!hasTransformableLink(content)) return content;

        let nextIndex = content.length;

        const transformLinkChild = (child: ReactElement<any>) => {
            if (settings.store.transformEmojis) {
                const fakeNitroMatch = child.props.href.match(fakeNitroEmojiRegex);
                if (fakeNitroMatch) {
                    let url: URL | null = null;
                    try {
                        url = new URL(child.props.href);
                    } catch { }

                    const emojiName = EmojiStore.getCustomEmojiById(fakeNitroMatch[1])?.name ?? url?.searchParams.get("name") ?? "FakeNitroEmoji";
                    const isAnimated = fakeNitroMatch[2] === "gif" || url?.searchParams.get("animated") === "true";

                    return Parser.defaultRules.customEmoji.react({
                        jumboable: !inline && content.length === 1 && typeof content[0].type !== "string",
                        animated: isAnimated,
                        emojiId: fakeNitroMatch[1],
                        name: emojiName,
                        fake: true
                    }, void 0, { key: String(nextIndex++) });
                }
            }

            if (settings.store.transformStickers) {
                if (fakeNitroStickerRegex.test(child.props.href)) return null;

                const gifMatch = child.props.href.match(fakeNitroGifStickerRegex);
                if (gifMatch) {
                    // There is no way to differentiate a regular gif attachment from a fake nitro animated sticker, so we check if the StickersStore contains the id of the fake sticker
                    if (StickersStore.getStickerById(gifMatch[1])) return null;
                }
            }

            return child;
        };

        const transformChild = (child: ReactElement<any>) => {
            if (child?.props?.trusted != null) return transformLinkChild(child);
            if (child?.props?.children != null) {
                if (!Array.isArray(child.props.children)) {
                    child.props.children = modifyChild(child.props.children);
                    return child;
                }

                child.props.children = modifyChildren(child.props.children);
                if (child.props.children.length === 0) return null;
                return child;
            }

            return child;
        };

        const modifyChild = (child: ReactElement<any>) => {
            const newChild = transformChild(child);

            if (newChild?.type === "ul" || newChild?.type === "ol") {
                this.ensureChildrenIsArray(newChild);
                if (newChild.props.children.length === 0) return null;

                let listHasAnItem = false;
                for (const [index, child] of newChild.props.children.entries()) {
                    if (child == null) {
                        delete newChild.props.children[index];
                        continue;
                    }

                    this.ensureChildrenIsArray(child);
                    if (child.props.children.length > 0) listHasAnItem = true;
                    else delete newChild.props.children[index];
                }

                if (!listHasAnItem) return null;

                newChild.props.children = this.clearEmptyArrayItems(newChild.props.children);
            }

            return newChild;
        };

        const modifyChildren = (children: Array<ReactElement<any>>) => {
            for (const [index, child] of children.entries()) children[index] = modifyChild(child);

            children = this.clearEmptyArrayItems(children);

            return children;
        };

        try {
            const newContent = modifyChildren(lodash.cloneDeep(content));
            this.trimContent(newContent);

            return newContent;
        } catch (err) {
            new Logger("FakeNitro").error(err);
            return content;
        }
    },

    patchFakeNitroStickers(stickers: Array<any>, message: Message) {
        const itemsToMaybePush: Array<string> = [];

        const contentItems = message.content.split(/\s/);
        if (settings.store.transformCompoundSentence) {
            for (const contentItem of contentItems) {
                itemsToMaybePush.push(contentItem);
            }
        }
        else if (contentItems.length === 1) itemsToMaybePush.push(contentItems[0]);

        for (const attachment of message.attachments) {
            if (attachment.content_type === "image/gif") itemsToMaybePush.push(attachment.url);
        }

        for (const item of itemsToMaybePush) {
            if (!settings.store.transformCompoundSentence && !item.startsWith("http") && !hyperLinkRegex.test(item)) continue;

            const imgMatch = item.match(fakeNitroStickerRegex);
            if (imgMatch) {
                let url: URL | null = null;
                try {
                    url = new URL(item);
                } catch { }

                const stickerName = StickersStore.getStickerById(imgMatch[1])?.name ?? url?.searchParams.get("name") ?? "FakeNitroSticker";
                stickers.push({
                    format_type: 1,
                    id: imgMatch[1],
                    name: stickerName,
                    fake: true
                });

                continue;
            }

            const gifMatch = item.match(fakeNitroGifStickerRegex);
            if (gifMatch) {
                if (!StickersStore.getStickerById(gifMatch[1])) continue;

                const stickerName = StickersStore.getStickerById(gifMatch[1])?.name ?? "FakeNitroSticker";
                stickers.push({
                    format_type: 2,
                    id: gifMatch[1],
                    name: stickerName,
                    fake: true
                });
            }
        }

        return stickers;
    },

    shouldIgnoreEmbed(embed: Message["embeds"][number], message: Message) {
        try {
            const contentItems = message.content.split(/\s/);
            if (contentItems.length > 1 && !settings.store.transformCompoundSentence) return false;

            switch (embed.type) {
                case "image": {
                    const url = embed.url ?? embed.image?.url;
                    if (!url) return false;
                    if (
                        !settings.store.transformCompoundSentence
                        && !contentItems.some(item => item === url || item.match(hyperLinkRegex)?.[1] === url)
                    ) return false;

                    if (settings.store.transformEmojis) {
                        if (fakeNitroEmojiRegex.test(url)) return true;
                    }

                    if (settings.store.transformStickers) {
                        if (fakeNitroStickerRegex.test(url)) return true;

                        const gifMatch = url.match(fakeNitroGifStickerRegex);
                        if (gifMatch) {
                            // There is no way to differentiate a regular gif attachment from a fake nitro animated sticker, so we check if the StickersStore contains the id of the fake sticker
                            if (StickersStore.getStickerById(gifMatch[1])) return true;
                        }
                    }

                    break;
                }
            }
        } catch (e) {
            new Logger("FakeNitro").error("Error in shouldIgnoreEmbed:", e);
        }

        return false;
    },

    filterAttachments(attachments: Message["attachments"]) {
        return attachments.filter(attachment => {
            if (attachment.content_type !== "image/gif") return true;

            const match = attachment.url.match(fakeNitroGifStickerRegex);
            if (match) {
                // There is no way to differentiate a regular gif attachment from a fake nitro animated sticker, so we check if the StickersStore contains the id of the fake sticker
                if (StickersStore.getStickerById(match[1])) return false;
            }

            return true;
        });
    },

    shouldKeepEmojiLink(link: any) {
        return link.target && fakeNitroEmojiRegex.test(link.target);
    },

    addFakeNotice(type: FakeNoticeType, node: Array<ReactNode>, fake: boolean) {
        if (!fake) return node;

        node = Array.isArray(node) ? node : [node];

        switch (type) {
            case FakeNoticeType.Sticker: {
                node.push(" This is a FakeNitro sticker and renders like a real sticker only for you. Appears as a link to non-plugin users.");

                return node;
            }
            case FakeNoticeType.Emoji: {
                node.push(" This is a FakeNitro emoji and renders like a real emoji only for you. Appears as a link to non-plugin users.");

                return node;
            }
        }
    },

    getStickerLink({ format_type, id }: Sticker) {
        const ext = format_type === StickerFormatType.GIF ? "gif" : "png";
        return `https://media.discordapp.net/stickers/${id}.${ext}?size=${settings.store.stickerSize}`;
    },

    async sendAnimatedSticker(stickerLink: string, stickerId: string, channelId: string) {
        if (stopped) return;
        if (stickerJobs.size) {
            showToast("A sticker is already being converted. Try again when it finishes.", Toasts.Type.FAILURE);
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        const userId = UserStore.getCurrentUser()?.id;
        stickerJobs.add(controller);
        const timeout = setTimeout(() => {
            showToast("Sticker conversion took too long. Try a smaller sticker.", Toasts.Type.FAILURE);
            controller.abort();
        }, 120_000);
        try {
            const url = new URL(stickerLink);
            if (url.protocol !== "https:" || url.hostname !== "media.discordapp.net" || url.port || url.username || url.password)
                throw new Error("Invalid sticker URL.");
            const response = await fetch(url, { signal, redirect: "error" });
            if (!response.ok) throw new Error("Could not download the sticker.");
            const input = await readResponseBody(response, 50 * 1024 * 1024, signal);
            const output = await convertApngToGif(input, signal, settings.store.stickerSize);
            if (signal.aborted || stopped || UserStore.getCurrentUser()?.id !== userId) return;
            if (!output) throw new Error("Could not convert the sticker. Try a smaller sticker size.");
            const channel = ChannelStore.getChannel(channelId);
            if (channel) UploadHandler.promptToUpload([new File([output], `${stickerId}.gif`, { type: "image/gif" })], channel, DraftType.ChannelMessage);
        } catch (error) {
            if (!signal.aborted) showToast(error instanceof Error ? error.message : "Could not convert the sticker.", Toasts.Type.FAILURE);
        } finally {
            clearTimeout(timeout);
            stickerJobs.delete(controller);
        }
    },

    flux: {
        CONNECTION_OPEN() { for (const job of stickerJobs) job.abort(); },
        LOGOUT() { for (const job of stickerJobs) job.abort(); }
    },

    canUseEmote(e: Emoji, channelId: string) {
        if (e.type === 0) return true;
        if (e.available === false) return false;

        const guildId = ChannelStore.getChannel(channelId)?.guild_id;
        if (isUnusableRoleSubscriptionEmoji(e, guildId, true)) return false;

        let isUsableTwitchSubEmote = false;
        if (e.managed && e.guildId) {
            const myRoles = GuildMemberStore.getSelfMember(e.guildId)?.roles ?? [];
            isUsableTwitchSubEmote = e.roles.some(r => myRoles.includes(r));
        }

        if (this.canUseEmotes || isUsableTwitchSubEmote)
            return e.guildId === guildId || hasExternalEmojiPerms(channelId);
        else
            return !e.animated && e.guildId === guildId;
    },

    start() {
        stopped = false;
        const s = settings.store;

        if (!s.enableEmojiBypass && !s.enableStickerBypass) {
            return;
        }

        this.preSend = addMessagePreSendListener(async (channelId, messageObj, options) => {
            const guildId = ChannelStore.getChannel(channelId)?.guild_id;

            let hasBypass = false;

            stickerBypass: {
                if (!s.enableStickerBypass)
                    break stickerBypass;

                const sticker = StickersStore.getStickerById(options.stickerIds?.[0]!);
                if (!sticker)
                    break stickerBypass;

                // Discord Stickers are now free yayyy!! :D
                if ("pack_id" in sticker)
                    break stickerBypass;

                const canUseStickers = this.canUseStickers && hasExternalStickerPerms(channelId);
                if (sticker.available !== false && (canUseStickers || sticker.guild_id === guildId))
                    break stickerBypass;

                const link = this.getStickerLink(sticker);

                if (sticker.format_type === StickerFormatType.APNG) {
                    if (!hasAttachmentPerms(channelId)) {
                        openModal(props => (
                            <ConfirmModal
                                {...props}
                                title="Hold on!"
                                confirmText="OK"
                                variant="primary"
                            >
                                <div>
                                    <Paragraph>
                                        You cannot send this message because it contains an animated FakeNitro sticker,
                                        and you do not have permissions to attach files in the current channel. Please remove the sticker to proceed.
                                    </Paragraph>
                                </div>
                            </ConfirmModal>
                        ));
                    } else {
                        this.sendAnimatedSticker(link, sticker.id, channelId);
                    }

                    return { cancel: true };
                } else {
                    hasBypass = true;

                    const url = new URL(link);
                    url.searchParams.set("name", sticker.name);
                    url.searchParams.set("lossless", "true");

                    const linkText = s.hyperLinkText.replaceAll("{{NAME}}", sticker.name);

                    messageObj.content += `${getWordBoundary(messageObj.content, messageObj.content.length - 1)}${s.useStickerHyperLinks ? `[${linkText}](${url})` : url}`;
                    options.stickerIds!.length = 0;
                }
            }

            if (s.enableEmojiBypass) {
                for (const emoji of messageObj.validNonShortcutEmojis) {
                    if (this.canUseEmote(emoji, channelId)) continue;

                    hasBypass = true;

                    const emojiString = `<${emoji.animated ? "a" : ""}:${emoji.originalName || emoji.name}:${emoji.id}>`;

                    const url = new URL(IconUtils.getEmojiURL({ id: emoji.id, animated: emoji.animated, size: s.emojiSize }));
                    url.searchParams.set("size", s.emojiSize.toString());
                    url.searchParams.set("name", emoji.name);
                    url.searchParams.set("lossless", "true");

                    if (emoji.animated) url.pathname = url.pathname.replace(".webp", ".gif");

                    const linkText = s.hyperLinkText.replaceAll("{{NAME}}", emoji.name);

                    messageObj.content = messageObj.content.replace(emojiString, (match, offset, origStr) => {
                        return `${getWordBoundary(origStr, offset - 1)}${s.useEmojiHyperLinks ? `[${linkText}](${url})` : url}${getWordBoundary(origStr, offset + match.length)}`;
                    });
                }
            }

            if (hasBypass && !s.disableEmbedPermissionCheck && !hasEmbedPerms(channelId)) {
                if (!await showCannotEmbedNotice()) {
                    return { cancel: true };
                }
            }

            return { cancel: false };
        });

        this.preEdit = addMessagePreEditListener(async (channelId, __, messageObj) => {
            if (!s.enableEmojiBypass) return;

            let hasBypass = false;

            messageObj.content = messageObj.content.replace(/(?<!\\)<a?:(?:\w+):(\d+)>/ig, (emojiStr, emojiId, offset, origStr) => {
                const emoji = EmojiStore.getCustomEmojiById(emojiId);
                if (emoji == null) return emojiStr;
                if (this.canUseEmote(emoji, channelId)) return emojiStr;

                hasBypass = true;

                const url = new URL(IconUtils.getEmojiURL({ id: emoji.id, animated: emoji.animated, size: s.emojiSize }));
                url.searchParams.set("size", s.emojiSize.toString());
                url.searchParams.set("name", emoji.name);
                url.searchParams.set("lossless", "true");

                const linkText = s.hyperLinkText.replaceAll("{{NAME}}", emoji.name);

                return `${getWordBoundary(origStr, offset - 1)}${s.useEmojiHyperLinks ? `[${linkText}](${url})` : url}${getWordBoundary(origStr, offset + emojiStr.length)}`;
            });

            if (hasBypass && !s.disableEmbedPermissionCheck && !hasEmbedPerms(channelId)) {
                if (!await showCannotEmbedNotice()) {
                    return { cancel: true };
                }
            }

            return { cancel: false };
        });
    },

    stop() {
        stopped = true;
        for (const job of stickerJobs) job.abort();
        stickerJobs.clear();
        removeMessagePreSendListener(this.preSend);
        removeMessagePreEditListener(this.preEdit);
    }
});
