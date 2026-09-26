/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Margins } from "@components/margins";
import type { Theme, ThemeLikeProps } from "@equicordplugins/themeLibrary/types";
import { getThemeLibraryToken, isAuthorized } from "@equicordplugins/themeLibrary/utils/auth";
import { LikeIcon } from "@equicordplugins/themeLibrary/utils/Icons";
import { useEffect, useRef, useState } from "@webpack/common";

import { logger, themeRequest } from "./ThemeTab";

export const LikesComponent = ({ themeId, likedThemes: initialLikedThemes }: { themeId: Theme["id"], likedThemes: ThemeLikeProps | undefined; }) => {
    const [likesCount, setLikesCount] = useState(0);
    const [likedThemes, setLikedThemes] = useState(initialLikedThemes);
    const debounce = useRef(false);

    useEffect(() => {
        const likes = getThemeLikes(themeId);
        setLikesCount(likes);
    }, [likedThemes, themeId]);

    function getThemeLikes(themeId: Theme["id"]): number {
        const themeLike = likedThemes?.likes.find(like => like.themeId === themeId);
        return themeLike ? themeLike.likes : 0;
    }

    const handleLikeClick = async (themeId: Theme["id"]) => {
        if (debounce.current) return;
        debounce.current = true;

        try {
            if (!await isAuthorized()) return;
            const theme = likedThemes?.likes.find(like => like.themeId === themeId);
            const hasLiked: boolean = theme?.hasLiked ?? false;
            const endpoint = hasLiked ? "/likes/remove" : "/likes/add";
            const token = await getThemeLibraryToken();
            if (!token) return;

            // doing this so the delay is not visible to the user
            setLikesCount(likesCount + (hasLiked ? -1 : 1));

            const response = await themeRequest(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`,
                },
                body: JSON.stringify({
                    themeId: themeId,
                }),
            });

            if (!response.ok) {
                setLikesCount(likesCount);
                return logger.error("Couldnt update likes, response not ok");
            }

            const fetchLikes = async () => {
                try {
                    const response = await themeRequest("/likes/get", {
                        headers: {
                            "Authorization": `Bearer ${token}`,
                        },
                    });
                    const data = await response.json();
                    setLikedThemes(data);
                } catch (err) {
                    logger.error(err);
                }
            };

            await fetchLikes();
        } catch (err) {
            setLikesCount(likesCount);
            logger.error(err);
        } finally {
            debounce.current = false;
        }
    };

    const hasLiked = likedThemes?.likes.some(like => like.themeId === themeId && like?.hasLiked === true) ?? false;

    return (
        <Button onClick={() => handleLikeClick(themeId)}
            variant="secondary"
            size="medium"
            disabled={themeId === "preview"}
            className={Margins.right8}
        >
            {LikeIcon(hasLiked || themeId === "preview")} {themeId === "preview" ? 143 : likesCount}
        </Button>
    );
};
