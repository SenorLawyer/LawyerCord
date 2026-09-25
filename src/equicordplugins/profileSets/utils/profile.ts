/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getUserSettingLazy } from "@api/UserSettings";
import { AvatarDecorationData, CustomStatus, DisplayNameStyles, Nameplate, ProfileEffect, ProfilePreset } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, GuildMemberStore, IconUtils, UserProfileStore, UserStore } from "@webpack/common";

const UserProfileSettingsStore = findStoreLazy("UserProfileSettingsStore");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CustomStatusSettings = getUserSettingLazy("status", "customStatus")!;

type PendingChanges = Record<string, unknown> & {
    pendingAvatar?: ImageInput;
    pendingBanner?: ImageInput;
    pendingAvatarDecoration?: AvatarDecorationLike | null;
    pendingProfileEffect?: ProfileEffect | null;
    pendingNameplate?: Nameplate | null;
    pendingDisplayNameStyles?: DisplayNameStyles | null;
    pendingAccentColor?: number | null;
    pendingThemeColors?: number[] | null;
    pendingBio?: string | null;
    pendingPronouns?: string | null;
    pendingNickname?: string | null;
    pendingGlobalName?: string | null;
    pendingPrimaryGuildId?: string | null;
};

type ImageInput = string | { imageUri: string; [key: string]: unknown; } | null | undefined;
type AvatarDecorationLike = AvatarDecorationData & {
    label?: string;
    type?: number;
};
type DisplayNameStylesLike = DisplayNameStyles & {
    fontId?: number;
    effectId?: number;
};

type CurrentProfileOptions = {
    isGuildProfile?: boolean;
};

type LoadPresetOptions = {
    isCurrent?: () => boolean;
    skipGlobalName?: boolean;
    skipBio?: boolean;
    skipPronouns?: boolean;
    isGuildProfile?: boolean;
};

function dispatch(type: string, payload: Record<string, unknown>) {
    FluxDispatcher.dispatch({ type, ...payload });
}

function setPendingChanges(payload: Record<string, unknown>, guildId?: string) {
    dispatch("USER_PROFILE_SETTINGS_SET_PENDING_CHANGES", guildId ? { guildId, ...payload } : payload);
}

function openProfileImagePreview(
    uploadType: "AVATAR" | "BANNER",
    image: Extract<ImageInput, { imageUri: string; }>,
    guildId?: string
) {
    dispatch("PROFILE_CUSTOMIZATION_OPEN_PREVIEW_MODAL", {
        pendingImage: image,
        file: { type: /^data:([^;,]+)/i.exec(image.imageUri)?.[1].toLowerCase() ?? "" },
        uploadType,
        guildId,
        analyticsSource: guildId ? "user settings guild profile" : "user settings user profile",
        isTryItOut: false
    });
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function hasImageInput(value: ImageInput): boolean {
    if (!value) return false;
    if (typeof value === "string") return value.length > 0;
    return typeof value === "object" && isNonEmptyString(value?.imageUri);
}

function hasAvatarDecoration(value: unknown): value is AvatarDecorationLike {
    return typeof value === "object"
        && value != null
        && "asset" in value
        && "skuId" in value
        && isNonEmptyString((value as { asset?: unknown; }).asset)
        && isNonEmptyString((value as { skuId?: unknown; }).skuId);
}

function normalizeDisplayNameStyles(value: DisplayNameStylesLike | null | undefined): DisplayNameStylesLike | null {
    if (!value) return null;
    const fontId = value.fontId ?? value.font_id;
    const effectId = value.effectId ?? value.effect_id;
    if (typeof fontId !== "number" || typeof effectId !== "number") return null;
    const colors = Array.isArray(value.colors) ? [...value.colors] : [];

    return {
        fontId,
        effectId,
        font_id: fontId,
        effect_id: effectId,
        colors
    };
}

export async function imageUrlToBase64(url: string): Promise<string | null> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
            await response.body?.cancel();
            return null;
        }
        if (!response.body) return null;
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_IMAGE_BYTES) {
                    await reader.cancel();
                    return null;
                }
                chunks.push(new Uint8Array(value));
            }
        } finally {
            reader.releaseLock();
        }
        const blob = new Blob(chunks, { type: response.headers.get("Content-Type") ?? "" });
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

function checkEmbeddedImageSize(image: string | null | undefined) {
    if (!image?.startsWith("data:")) return;
    const separator = image.indexOf(",");
    if (separator < 0) throw new Error("The profile image is invalid.");
    const payload = image.slice(separator + 1);
    let size: number;
    if (/;base64$/i.test(image.slice(0, separator).trimEnd())) {
        const encoded = decodeURIComponent(payload).replace(/[\t\n\f\r ]/g, "");
        size = Math.floor(encoded.replace(/=+$/, "").length * 3 / 4);
    } else {
        size = encodeURI(payload).replace(/%25(?=[\da-f]{2})/gi, "%").replace(/%[\da-f]{2}/gi, "x").length;
    }
    if (size > MAX_IMAGE_BYTES) throw new Error("The profile image exceeds 10 MiB.");
}

async function processImage(imageData: ImageInput, userId: string, type: "avatar" | "banner", guildId?: string, useGuildPath?: boolean): Promise<string | null> {
    if (typeof imageData === "object" && imageData) imageData = imageData.imageUri;
    if (!imageData) return null;

    if (imageData.startsWith("data:")) {
        checkEmbeddedImageSize(imageData);
        return imageData;
    }
    if (/^(?:https?:\/\/|blob:)/.test(imageData)) {
        const image = await imageUrlToBase64(imageData);
        if (!image) throw new Error("Could not download the profile image.");
        return image;
    }

    let url: string | undefined;
    if (type === "banner") {
        const data = { id: userId, banner: imageData, canAnimate: true, size: 1024 };
        url = useGuildPath && guildId
            ? IconUtils.getGuildMemberBannerURL({ ...data, guildId })
            : IconUtils.getUserBannerURL(data);
    } else if (useGuildPath && guildId) {
        url = IconUtils.getGuildMemberAvatarURLSimple({ userId, guildId, avatar: imageData, canAnimate: true, size: 512 });
    } else {
        url = `https://cdn.discordapp.com/avatars/${userId}/${imageData}.${imageData.startsWith("a_") ? "gif" : "png"}?size=512`;
    }
    if (!url) throw new Error("Could not resolve the profile image.");
    const image = await imageUrlToBase64(url);
    if (!image) throw new Error("Could not download the profile image.");
    return image;
}

export async function getCurrentProfile(guildId?: string, options: CurrentProfileOptions = {}): Promise<Omit<ProfilePreset, "name" | "timestamp">> {
    const currentUser = UserStore.getCurrentUser();
    const baseProfile = UserProfileStore.getUserProfile(currentUser.id);
    const isGuildProfile = options.isGuildProfile ?? Boolean(guildId);
    const effectiveGuildId = isGuildProfile ? guildId : undefined;
    const guildProfile = effectiveGuildId ? UserProfileStore.getGuildMemberProfile(currentUser.id, effectiveGuildId) : null;
    const userProfile = guildProfile ?? baseProfile;
    const guildMember = effectiveGuildId ? GuildMemberStore.getMember(effectiveGuildId, currentUser.id) : null;

    const pendingChanges: PendingChanges = UserProfileSettingsStore.getPendingChanges(effectiveGuildId) ?? {};
    const customStatusSetting = isGuildProfile ? null : CustomStatusSettings.getSetting();
    const customStatus = isGuildProfile
        ? null
        : {
            text: customStatusSetting?.text ?? "",
            emojiId: customStatusSetting?.emojiId ?? "0",
            emojiName: customStatusSetting?.emojiName ?? "",
            expiresAtMs: customStatusSetting?.expiresAtMs ?? "0"
        };

    const avatarDecorationSource = pendingChanges.pendingAvatarDecoration !== undefined
        ? pendingChanges.pendingAvatarDecoration
        : (isGuildProfile ? guildMember?.avatarDecoration : currentUser.avatarDecorationData);
    const avatarDecoration = hasAvatarDecoration(avatarDecorationSource)
        ? {
            ...avatarDecorationSource,
            asset: avatarDecorationSource.asset,
            skuId: avatarDecorationSource.skuId
        }
        : null;

    const effectToUse = pendingChanges.pendingProfileEffect !== undefined ? pendingChanges.pendingProfileEffect : userProfile?.profileEffect;
    const resolvedEffect = effectToUse?.skuId
        ? (effectToUse.effects ? effectToUse : userProfile?.collectibles?.find(c => c?.skuId === effectToUse.skuId))
        : null;
    const profileEffect: ProfileEffect | null = resolvedEffect ? {
        skuId: resolvedEffect.skuId,
        title: resolvedEffect.title,
        description: resolvedEffect.description,
        accessibilityLabel: resolvedEffect.accessibilityLabel,
        reducedMotionSrc: resolvedEffect.reducedMotionSrc,
        thumbnailPreviewSrc: resolvedEffect.thumbnailPreviewSrc,
        effects: resolvedEffect.effects,
        animationType: resolvedEffect.animationType,
        staticFrameSrc: resolvedEffect.staticFrameSrc,
        type: resolvedEffect.type || 1
    } : null;

    const nameplateToUse = pendingChanges.pendingNameplate !== undefined
        ? pendingChanges.pendingNameplate
        : (isGuildProfile ? guildMember?.collectibles?.nameplate : currentUser.collectibles?.nameplate);
    const nameplate = nameplateToUse ? {
        skuId: nameplateToUse.skuId,
        asset: nameplateToUse.asset,
        label: nameplateToUse.label,
        palette: typeof nameplateToUse.palette === "string" ? nameplateToUse.palette : undefined,
        type: nameplateToUse.type || 2
    } : null;

    const savedDisplayNameStyles = isGuildProfile
        ? (guildMember?.displayNameStyles ?? currentUser.displayNameStyles)
        : currentUser.displayNameStyles;
    const displayNameStylesToUse = pendingChanges.pendingDisplayNameStyles !== undefined ? pendingChanges.pendingDisplayNameStyles : savedDisplayNameStyles;
    const displayNameStyles = normalizeDisplayNameStyles(displayNameStylesToUse);

    const { pendingAvatar } = pendingChanges;
    const avatarToUse: ImageInput = pendingAvatar !== undefined
        ? pendingAvatar
        : (isGuildProfile ? (guildMember?.avatar ?? currentUser.avatar ?? null) : (currentUser.avatar ?? null));

    const useGuildAvatar = !!(effectiveGuildId && isGuildProfile && guildMember?.avatar && avatarToUse === guildMember.avatar);

    const avatarInput: ImageInput = pendingAvatar === null || hasImageInput(avatarToUse)
        ? avatarToUse
        : IconUtils.getUserAvatarURL(currentUser, true, 512);
    const avatarDataUrl = await processImage(avatarInput, currentUser.id, "avatar", effectiveGuildId, useGuildAvatar);
    const resolvedAvatarDataUrl = pendingAvatar === null ? null : avatarDataUrl ?? IconUtils.getDefaultAvatarURL(currentUser.id);

    const { pendingBanner } = pendingChanges;
    const bannerToUse: ImageInput = pendingBanner !== undefined
        ? pendingBanner
        : (isGuildProfile ? (guildProfile?.banner ?? baseProfile?.banner) : baseProfile?.banner);
    const useGuildBanner = !!(effectiveGuildId && isGuildProfile && guildProfile?.banner && bannerToUse === guildProfile?.banner);

    const bannerDataUrl = await processImage(bannerToUse, currentUser.id, "banner", effectiveGuildId, useGuildBanner);

    return {
        avatarDataUrl: resolvedAvatarDataUrl,
        bannerDataUrl,
        bio: pendingChanges.pendingBio !== undefined ? pendingChanges.pendingBio : userProfile?.bio ?? null,
        accentColor: pendingChanges.pendingAccentColor !== undefined ? pendingChanges.pendingAccentColor : userProfile?.accentColor ?? null,
        themeColors: pendingChanges.pendingThemeColors !== undefined ? pendingChanges.pendingThemeColors : userProfile?.themeColors ?? null,
        globalName: isGuildProfile
            ? (pendingChanges.pendingNickname !== undefined ? pendingChanges.pendingNickname : guildMember?.nick ?? null)
            : (pendingChanges.pendingGlobalName !== undefined ? pendingChanges.pendingGlobalName : currentUser.globalName ?? null),
        pronouns: pendingChanges.pendingPronouns !== undefined ? pendingChanges.pendingPronouns : userProfile?.pronouns ?? null,
        avatarDecoration,
        profileEffect,
        nameplate,
        primaryGuildId: isGuildProfile
            ? null
            : (pendingChanges.pendingPrimaryGuildId !== undefined ? pendingChanges.pendingPrimaryGuildId : currentUser.primaryGuild?.identityGuildId ?? null),
        customStatus,
        displayNameStyles
    };
}

function jsonEq(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    return JSON.stringify(a) === JSON.stringify(b);
}

function customStatusEq(a: CustomStatus | null | undefined, b: CustomStatus | null | undefined): boolean {
    if (a == null || b == null) return a == null && b == null;
    return a.text === b.text
        && String(a.emojiId ?? "") === String(b.emojiId ?? "")
        && a.emojiName === b.emojiName
        && String(a.expiresAtMs ?? "0") === String(b.expiresAtMs ?? "0");
}

function collectibleEqBySku(a: { skuId?: string | number | null; } | null | undefined, b: { skuId?: string | number | null; } | null | undefined): boolean {
    if (a == null || b == null) return a == null && b == null;
    return String(a.skuId ?? "") === String(b.skuId ?? "");
}

function collectibleEqByAsset(a: { skuId?: string | number | null; asset?: string | null; } | null | undefined, b: { skuId?: string | number | null; asset?: string | null; } | null | undefined): boolean {
    if (a == null || b == null) return a == null && b == null;
    return String(a.skuId ?? "") === String(b.skuId ?? "") && String(a.asset ?? "") === String(b.asset ?? "");
}

export async function loadPresetAsPending(preset: ProfilePreset, guildId?: string, options: LoadPresetOptions = {}) {
    const isGuild = options.isGuildProfile ?? Boolean(guildId);
    if (isGuild && !guildId) return;
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) throw new Error("No account is signed in.");
    checkEmbeddedImageSize(preset.avatarDataUrl);
    checkEmbeddedImageSize(preset.bannerDataUrl);
    const current = await getCurrentProfile(guildId, {
        isGuildProfile: isGuild
    });
    if (options.isCurrent && !options.isCurrent()) return;
    if (UserStore.getCurrentUser()?.id !== userId) throw new Error("The account changed while loading the profile preset.");
    const setPending = (payload: Record<string, unknown>) => {
        const cleanPayload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
        if (!Object.keys(cleanPayload).length) return;
        setPendingChanges(cleanPayload, isGuild ? guildId : undefined);
    };

    if ("avatarDataUrl" in preset) {
        const avatarValue = preset.avatarDataUrl;
        if ((avatarValue ?? null) !== (current.avatarDataUrl ?? null)) {
            if (avatarValue?.startsWith("data:")) {
                openProfileImagePreview("AVATAR", {
                    assetOrigin: "NEW_ASSET",
                    imageUri: avatarValue,
                    description: `profilesets-${preset.name ?? "preset"}`
                }, guildId);
            } else {
                setPending({ pendingAvatar: avatarValue });
            }
        }
    }

    if ("bannerDataUrl" in preset && preset.bannerDataUrl !== current.bannerDataUrl) {
        if (preset.bannerDataUrl?.startsWith("data:")) {
            openProfileImagePreview("BANNER", {
                assetOrigin: "NEW_ASSET",
                imageUri: preset.bannerDataUrl,
                description: `profilesets-${preset.name ?? "preset"}`
            }, guildId);
        } else {
            setPending({ pendingBanner: preset.bannerDataUrl });
        }
    }

    if (!options.skipBio && preset.bio !== undefined && preset.bio !== current.bio) {
        setPending({ pendingBio: preset.bio ?? "" });
    }

    if (!options.skipPronouns && preset.pronouns !== undefined && preset.pronouns !== current.pronouns) {
        setPending({ pendingPronouns: preset.pronouns ?? "" });
    }

    if (!options.skipGlobalName && preset.globalName !== undefined && preset.globalName !== current.globalName) {
        setPending(isGuild ? { pendingNickname: preset.globalName } : { pendingGlobalName: preset.globalName });
    }

    if (preset.accentColor !== undefined && preset.accentColor !== current.accentColor) {
        setPending({ pendingAccentColor: preset.accentColor });
    }

    if (preset.avatarDecoration !== undefined && !collectibleEqByAsset(preset.avatarDecoration, current.avatarDecoration)) {
        setPending({
            pendingAvatarDecoration: preset.avatarDecoration
        });
    }

    if (preset.profileEffect !== undefined && !collectibleEqBySku(preset.profileEffect, current.profileEffect)) {
        setPending({
            pendingProfileEffect: preset.profileEffect
        });
    }

    if (preset.nameplate !== undefined && !collectibleEqByAsset(preset.nameplate, current.nameplate)) {
        setPending({
            pendingNameplate: preset.nameplate
        });
    }

    if (preset.displayNameStyles !== undefined) {
        const presetDisplayNameStyles = normalizeDisplayNameStyles(preset.displayNameStyles);
        if (!jsonEq(presetDisplayNameStyles, current.displayNameStyles)) {
            setPending({ pendingDisplayNameStyles: presetDisplayNameStyles });
        }
    }

    if (preset.themeColors !== undefined && !jsonEq(preset.themeColors, current.themeColors)) {
        setPending({ pendingThemeColors: preset.themeColors });
    }

    if (preset.primaryGuildId !== undefined && !isGuild && preset.primaryGuildId !== current.primaryGuildId) {
        setPending({ pendingPrimaryGuildId: preset.primaryGuildId });
    }

    if (preset.customStatus !== undefined && !isGuild && !customStatusEq(preset.customStatus, current.customStatus)) {
        return CustomStatusSettings.updateSetting({
            text: preset.customStatus?.text ?? "",
            expiresAtMs: preset.customStatus?.expiresAtMs ?? "0",
            emojiId: preset.customStatus?.emojiId ?? "0",
            emojiName: preset.customStatus?.emojiName ?? ""
        });
    }
}
