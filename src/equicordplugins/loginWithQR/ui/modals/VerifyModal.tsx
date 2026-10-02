/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button, TextButton } from "@components/Button";
import { images } from "@equicordplugins/loginWithQR/images";
import { getIntlMessage } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import {
    Modal,
    openModal,
    RestAPI,
    useEffect,
    useRef,
    UserStore,
    useState } from "@webpack/common";

import { cl } from "..";

type VerifyState = "verifying" | "loggedIn" | "notFound";

function VerifyModal({
    token,
    onComplete,
    signal,
    accountId,
    ...props
}: {
    token: string | null;
    onComplete: (confirmed: boolean) => void;
    signal: AbortSignal;
    accountId: string;
} & RenderModalProps) {
    const [state, setState] = useState<VerifyState>(token ? "verifying" : "notFound");
    const [inProgress, setInProgress] = useState(false);
    const [holding, setHolding] = useState(false);
    const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const active = useRef(true);
    const submitted = useRef(false);
    const confirmed = useRef(false);
    const onClose = useRef(props.onClose);
    onClose.current = props.onClose;

    const isCurrent = () => active.current && !signal.aborted && UserStore.getCurrentUser()?.id === accountId;

    useEffect(() => {
        active.current = true;
        const abort = () => {
            active.current = false;
            clearTimeout(timeout.current);
            onClose.current();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        return () => {
            active.current = false;
            clearTimeout(timeout.current);
            signal.removeEventListener("abort", abort);
            onComplete(confirmed.current);
        };
    }, [onComplete, signal]);

    const startHold = () => {
        if (!isCurrent() || !token || state !== "verifying" || submitted.current || timeout.current !== undefined) return;
        setHolding(true);
        timeout.current = setTimeout(() => {
            timeout.current = undefined;
            if (!isCurrent()) return;
            submitted.current = true;
            setInProgress(true);
            RestAPI.post({
                url: "/users/@me/remote-auth/finish",
                body: {
                    handshake_token: token,
                },
            })
                .then(() => {
                    if (!isCurrent()) return;
                    confirmed.current = true;
                    setState("loggedIn");
                })
                .catch(() => {
                    if (isCurrent()) setState("notFound");
                })
                .finally(() => {
                    if (isCurrent()) setInProgress(false);
                });
        }, 1250);
    };

    const endInput = () => {
        clearTimeout(timeout.current);
        timeout.current = undefined;
        setHolding(false);
    };

    return (
        <Modal size="sm" {...props} title="Verify Login">
            <div className={cl("device-content")}>
                {state === "loggedIn" ? (
                    <>
                        <img
                            className={cl("device-image")}
                            src={images.deviceImage.success}
                            key="img-success"
                            draggable={false}
                        />
                        <BaseText
                            size="xl"
                            weight="bold"
                            color="text-strong"
                            tag="h1"
                            className={cl("device-header")}
                        >
                            {getIntlMessage("QR_CODE_LOGIN_SUCCESS")}
                        </BaseText>
                        <BaseText
                            size="md"
                            weight="semibold"
                            color="text-default"
                            style={{ width: "30rem", textAlign: "center" }}
                        >
                            {getIntlMessage("QR_CODE_LOGIN_SUCCESS_FLAVOR")}
                        </BaseText>
                    </>
                ) : state === "notFound" ? (
                    <>
                        <img
                            className={cl("device-image")}
                            src={images.deviceImage.notFound}
                            key="img-not_found"
                            draggable={false}
                        />
                        <BaseText
                            size="xl"
                            weight="bold"
                            color="text-strong"
                            tag="h1"
                            className={cl("device-header")}
                        >
                            {getIntlMessage("QR_CODE_NOT_FOUND")}
                        </BaseText>
                        <BaseText
                            size="md"
                            weight="semibold"
                            color="text-default"
                            style={{ width: "30rem" }}
                        >
                            {getIntlMessage("QR_CODE_NOT_FOUND_DESCRIPTION")}
                        </BaseText>
                    </>
                ) : (
                    <>
                        <img
                            className={cl("device-image")}
                            src={images.deviceImage.loading}
                            key="img-loaded"
                            draggable={false}
                        />
                        <BaseText
                            size="xl"
                            weight="bold"
                            color="text-strong"
                            tag="h1"
                            className={cl("device-header")}
                        >
                            {getIntlMessage("QR_CODE_LOGIN_CONFIRM")}
                        </BaseText>
                        <BaseText size="md" weight="semibold" color="text-danger">
                            Never scan a login QR code from another user or application.
                        </BaseText>
                        <Button
                            size="medium"
                            variant="dangerPrimary"
                            className={cl("device-confirm", holding && "device-confirm-holding")}
                            onPointerDown={event => {
                                if (event.button !== 0 || !event.isPrimary) return;
                                event.currentTarget.setPointerCapture(event.pointerId);
                                startHold();
                            }}
                            onPointerUp={endInput}
                            onPointerCancel={endInput}
                            onLostPointerCapture={endInput}
                            onBlur={endInput}
                            onKeyDown={event => {
                                if (event.key !== " " && event.key !== "Enter") return;
                                event.preventDefault();
                                if (!event.repeat) startHold();
                            }}
                            onKeyUp={event => {
                                if (event.key !== " " && event.key !== "Enter") return;
                                event.preventDefault();
                                endInput();
                            }}
                            disabled={inProgress}
                        >
                            Hold to confirm login
                        </Button>
                    </>
                )}
            </div>
            <div className={cl("device-footer")} style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                {state === "loggedIn" ? (
                    <Button onClick={props.onClose}>
                        {getIntlMessage("QR_CODE_LOGIN_FINISH_BUTTON")}
                    </Button>
                ) : (
                    <TextButton
                        variant="link"
                        onClick={props.onClose}
                    >
                        {state === "notFound"
                            ? getIntlMessage("CLOSE")
                            : getIntlMessage("CANCEL")}
                    </TextButton>
                )}
            </div>
        </Modal>
    );
}

export default function openVerifyModal(
    token: string | null,
    onComplete: (confirmed: boolean) => void,
    signal: AbortSignal,
    accountId: string,
) {
    return openModal(props => (
        <VerifyModal
            {...props}
            token={token}
            onComplete={onComplete}
            signal={signal}
            accountId={accountId}
        />
    ));
}
