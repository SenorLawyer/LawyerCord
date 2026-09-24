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
        image,
        file: {},
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

async function processImage(imageData: ImageInput, userId: string, type: "avatar" | "banner", guildId?: string, useGuildPath?: boolean): Promise<string | null> {
    if (typeof imageData === "object" && imageData) imageData = imageData.imageUri;
    if (!imageData) return null;

    if (imageData.startsWith("data:")) return imageData;
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
    const userAny = currentUser;
    const guildMember = effectiveGuildId ? GuildMemberStore.getMember(effectiveGuildId, currentUser.id) : null;

    const pendingChangesDefault: PendingChanges = UserProfileSettingsStore.getPendingChanges() ?? {};
    const pendingChangesForGuild: PendingChanges = UserProfileSettingsStore.getPendingChanges(effectiveGuildId) ?? {};
    const pendingChanges: PendingChanges = isGuildProfile && Object.keys(pendingChangesForGuild).length > 0
        ? pendingChangesForGuild
        : pendingChangesDefault;
    const customStatusSetting = CustomStatusSettings.getSetting();
    const customStatus = isGuildProfile
        ? null
        : {
            text: customStatusSetting?.text ?? "",
            emojiId: customStatusSetting?.emojiId ?? "0",
            emojiName: customStatusSetting?.emojiName ?? "",
            expiresAtMs: customStatusSetting?.expiresAtMs ?? "0"
        };

    const avatarDecorationSource = pendingChanges.pendingAvatarDecoration
        ?? (isGuildProfile ? guildMember?.avatarDecoration : userAny.avatarDecorationData);
    const avatarDecoration = hasAvatarDecoration(avatarDecorationSource)
        ? {
            ...avatarDecorationSource,
            asset: avatarDecorationSource.asset,
            skuId: avatarDecorationSource.skuId
        }
        : null;

    let profileEffect: ProfileEffect | null = null;
    const effectToUse = pendingChanges.pendingProfileEffect ?? userProfile?.profileEffect;

    if (effectToUse) {
        if (effectToUse.skuId && effectToUse.effects) {
            profileEffect = {
                skuId: effectToUse.skuId,
                title: effectToUse.title,
                description: effectToUse.description,
                accessibilityLabel: effectToUse.accessibilityLabel,
                reducedMotionSrc: effectToUse.reducedMotionSrc,
                thumbnailPreviewSrc: effectToUse.thumbnailPreviewSrc,
                effects: effectToUse.effects,
                animationType: effectToUse.animationType,
                staticFrameSrc: effectToUse.staticFrameSrc,
                type: effectToUse.type || 1
            };
        } else if (effectToUse.skuId) {
            const collectibles = userProfile?.collectibles;
            const collectible = collectibles?.find(c => c?.skuId === effectToUse.skuId);
            if (collectible) {
                profileEffect = {
                    skuId: collectible.skuId,
                    title: collectible.title,
                    description: collectible.description,
                    accessibilityLabel: collectible.accessibilityLabel,
                    reducedMotionSrc: collectible.reducedMotionSrc,
                    thumbnailPreviewSrc: collectible.thumbnailPreviewSrc,
                    effects: collectible.effects,
                    animationType: collectible.animationType,
                    staticFrameSrc: collectible.staticFrameSrc,
                    type: collectible.type || 1
                };
            }
        }
    }

    const nameplateToUse = pendingChanges.pendingNameplate
        ?? (isGuildProfile ? guildMember?.collectibles?.nameplate : userAny.collectibles?.nameplate);
    const nameplate = nameplateToUse ? {
        skuId: nameplateToUse.skuId,
        asset: nameplateToUse.asset,
        label: nameplateToUse.label,
        palette: typeof nameplateToUse.palette === "string" ? nameplateToUse.palette : undefined,
        type: nameplateToUse.type || 2
    } : null;

    const savedDisplayNameStyles = isGuildProfile
        ? (guildMember?.displayNameStyles ?? userAny.displayNameStyles)
        : userAny.displayNameStyles;
    const displayNameStylesToUse = pendingChanges.pendingDisplayNameStyles ?? savedDisplayNameStyles;
    const displayNameStyles = normalizeDisplayNameStyles(displayNameStylesToUse);

    const { pendingAvatar } = pendingChanges;
    const avatarToUse: ImageInput = hasImageInput(pendingAvatar)
        ? pendingAvatar
        : (isGuildProfile ? (guildMember?.avatar ?? currentUser.avatar ?? null) : (currentUser.avatar ?? null));

    const useGuildAvatar = !!(effectiveGuildId && isGuildProfile && guildMember?.avatar && avatarToUse === guildMember.avatar);

    const avatarInput: ImageInput = hasImageInput(avatarToUse)
        ? avatarToUse
        : IconUtils.getUserAvatarURL(currentUser, true, 512);
    const avatarDataUrl = await processImage(avatarInput, currentUser.id, "avatar", effectiveGuildId, useGuildAvatar);
    const resolvedAvatarDataUrl = avatarDataUrl ?? IconUtils.getDefaultAvatarURL(currentUser.id);

    const { pendingBanner } = pendingChanges;
    const bannerToUse: ImageInput = hasImageInput(pendingBanner)
        ? pendingBanner
        : (isGuildProfile ? (guildProfile?.banner ?? baseProfile?.banner) : baseProfile?.banner);
    const useGuildBanner = !!(effectiveGuildId && isGuildProfile && guildProfile?.banner && bannerToUse === guildProfile?.banner);

    const bannerDataUrl = await processImage(bannerToUse, currentUser.id, "banner", effectiveGuildId, useGuildBanner);

    return {
        avatarDataUrl: resolvedAvatarDataUrl,
        bannerDataUrl,
        bio: pendingChanges.pendingBio ?? userProfile?.bio ?? null,
        accentColor: pendingChanges.pendingAccentColor ?? userProfile?.accentColor ?? null,
        themeColors: pendingChanges.pendingThemeColors ?? userProfile?.themeColors ?? null,
        globalName: isGuildProfile
            ? (pendingChanges.pendingNickname ?? guildMember?.nick ?? null)
            : (pendingChanges.pendingGlobalName ?? currentUser.globalName ?? null),
        pronouns: pendingChanges.pendingPronouns ?? userProfile?.pronouns ?? null,
        avatarDecoration,
        profileEffect,
        nameplate,
        primaryGuildId: isGuildProfile
            ? null
            : (pendingChanges.pendingPrimaryGuildId ?? userAny.primaryGuild?.identityGuildId ?? null),
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
    const current = await getCurrentProfile(guildId, {
        isGuildProfile: isGuild
    });
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

    if (preset.displayNameStyles) {
        const presetDisplayNameStyles = normalizeDisplayNameStyles(preset.displayNameStyles);
        if (!jsonEq(presetDisplayNameStyles, current.displayNameStyles)) {
            setPending({ pendingDisplayNameStyles: presetDisplayNameStyles });
        }
    }

    if (preset.themeColors && !jsonEq(preset.themeColors, current.themeColors)) {
        setPending({ pendingThemeColors: preset.themeColors });
    }

    if (preset.primaryGuildId && !isGuild && preset.primaryGuildId !== current.primaryGuildId) {
        setPending({ pendingPrimaryGuildId: preset.primaryGuildId });
    }

    if (preset.customStatus && !isGuild && !customStatusEq(preset.customStatus, current.customStatus)) {
        return CustomStatusSettings.updateSetting({
            text: preset.customStatus?.text ?? "",
            expiresAtMs: preset.customStatus?.expiresAtMs ?? "0",
            emojiId: preset.customStatus?.emojiId ?? "0",
            emojiName: preset.customStatus?.emojiName ?? ""
        });
    }
}
