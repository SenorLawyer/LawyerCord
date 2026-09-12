/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Paginator, requirePaginator } from "@plugins/reviewDB/components/ReviewModal";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import { Message } from "@vencord/discord-types";
import { findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { React, useRef, useState } from "@webpack/common";

const CloseButton = findComponentByCodeLazy("CLOSE_BUTTON_LABEL");
import { MutableRefObject } from "react";

import { jumper } from "./index";

const containerStyles = findCssClassesLazy("containerBottom", "containerTop");
const logger = new Logger("FindReply");

export default ErrorBoundary.wrap(function ReplyNavigator({ replies }: { replies: Message[]; }) {
    const [state, setState] = useState({ replies, page: 1, visible: true });
    if (state.replies !== replies) setState({ replies, page: 1, visible: true });
    const { page, visible } = state;
    const [paginatorReady] = useAwaiter(requirePaginator, {
        fallbackValue: false,
        deps: [replies],
        onError: () => logger.error("Could not load reply navigation.")
    });
    const ref: MutableRefObject<HTMLDivElement | null> = useRef(null);
    React.useEffect(() => {
        if (!visible || !paginatorReady) return;
        // https://stackoverflow.com/a/42234988
        function onMouseDown(event: MouseEvent) {
            if (ref.current && event.target instanceof Element && !ref.current.contains(event.target)) {
                setState(state => ({ ...state, visible: false }));
            }
        }

        document.addEventListener("mousedown", onMouseDown);
        return () => {
            document.removeEventListener("mousedown", onMouseDown);
        };
    }, [visible, paginatorReady]);
    if (!visible || !paginatorReady) return null;
    return (
        <div ref={ref} className={classes(containerStyles.containerBottom, "vc-findreply-div")}>
            <Paginator
                className={"vc-findreply-paginator"}
                currentPage={page}
                maxVisiblePages={5}
                pageSize={1}
                totalCount={replies.length}
                onPageChange={processPageChange}
            />
            <CloseButton className={"vc-findreply-close"} onClick={() => setState(state => ({ ...state, visible: false }))} />
        </div>
    );

    function processPageChange(page: number) {
        setState(state => ({ ...state, page }));
        jumper.jumpToMessage({
            channelId: replies[page - 1].channel_id,
            messageId: replies[page - 1].id,
            flash: true,
            jumpType: "INSTANT"
        });
    }
}, { noop: true });
