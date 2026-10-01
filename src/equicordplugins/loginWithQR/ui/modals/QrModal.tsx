/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { QrCodeIcon } from "@components/Icons";
import { wrapTab } from "@components/settings";
import loginWithQR, { scans } from "@equicordplugins/loginWithQR";
import { images } from "@equicordplugins/loginWithQR/images";
import { Logger } from "@utils/Logger";
import { RestAPI, useEffect, useRef, UserStore, useState } from "@webpack/common";
import jsQR from "jsqr";
import type { CSSProperties } from "react";

import { cl, Spinner } from "..";
import openVerifyModal from "./VerifyModal";

interface Preview {
    url: string;
    size: { width: number; height: number; };
    crosses: { x: number; y: number; rot: number; size: number; }[];
}

interface Scan {
    controller: AbortController;
    accountId: string;
    url?: string;
    timeout?: ReturnType<typeof setTimeout>;
}

const tokenRegex = /^https:\/\/discord\.com\/ra\/([\w-]+)$/;
const logger = new Logger("LoginWithQR");

function cancelHandshake(handshake: string, accountId: string) {
    if (UserStore.getCurrentUser()?.id !== accountId) return;
    void RestAPI.post({
        url: "/users/@me/remote-auth/cancel",
        body: { handshake_token: handshake }
    }).catch(() => logger.warn("Could not cancel the QR login request."));
}

function QrModal() {
    const [loading, setLoading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const active = useRef(false);
    const scanRef = useRef<Scan | null>(null);

    const isCurrent = (scan: Scan) => active.current && scanRef.current === scan
        && !scan.controller.signal.aborted && UserStore.getCurrentUser()?.id === scan.accountId;

    const exit = (scan: Scan, message: string | null = null) => {
        if (scanRef.current !== scan) return;
        scanRef.current = null;
        clearTimeout(scan.timeout);
        if (scan.url) URL.revokeObjectURL(scan.url);
        scans.delete(scan.controller);
        scan.controller.abort();
        if (active.current) {
            setError(message);
            setLoading(false);
            setPreview(null);
        }
    };

    const begin = () => {
        const accountId = UserStore.getCurrentUser()?.id;
        if (!active.current || !loginWithQR.started || scanRef.current || !accountId) return;
        const scan: Scan = { controller: new AbortController(), accountId };
        scanRef.current = scan;
        scans.add(scan.controller);
        scan.controller.signal.addEventListener("abort", () => exit(scan), { once: true });
        setError(null);
        setLoading(true);
        return scan;
    };

    const verify = async (token: string, scan: Scan) => {
        if (!isCurrent(scan)) return;
        try {
            const res = await RestAPI.post({
                url: "/users/@me/remote-auth",
                body: { fingerprint: token }
            });
            const handshake = res.ok && res.status === 200 && typeof res.body?.handshake_token === "string"
                && res.body.handshake_token.length > 0 ? res.body.handshake_token : null;
            if (!isCurrent(scan)) {
                if (handshake) cancelHandshake(handshake, scan.accountId);
                return;
            }
            setPreview(null);
            if (scan.url) {
                URL.revokeObjectURL(scan.url);
                scan.url = undefined;
            }
            openVerifyModal(handshake, confirmed => {
                if (!confirmed && handshake) cancelHandshake(handshake, scan.accountId);
                exit(scan);
            }, scan.controller.signal, scan.accountId);
        } catch {
            if (isCurrent(scan)) exit(scan, "Could not verify the QR code. Try again.");
        }
    };

    const processImage = async (file: File) => {
        const scan = begin();
        if (!scan) return;
        try {
            const img = new Image();
            scan.url = URL.createObjectURL(file);
            await new Promise<void>((resolve, reject) => {
                const { signal } = scan.controller;
                const finish = (failed: boolean) => {
                    img.onload = img.onerror = null;
                    signal.removeEventListener("abort", abort);
                    if (failed) reject(new Error("Could not read the image. Try another image."));
                    else resolve();
                };
                const abort = () => { img.src = ""; finish(true); };
                img.onload = () => finish(false);
                img.onerror = () => finish(true);
                signal.addEventListener("abort", abort, { once: true });
                img.src = scan.url ?? "";
            });
            if (!isCurrent(scan)) return;
            const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Could not read the image. Try another image.");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(data, width, height);
            canvas.width = canvas.height = 0;
            const token = code?.data.match(tokenRegex)?.[1];
            if (!token || !code) return exit(scan);

            const { location } = code;
            const size = width > height
                ? { width: 34, height: height / width * 34 }
                : { width: width / height * 34, height: 34 };
            const crossSize = (Math.hypot(location.topLeftCorner.x - location.topRightCorner.x, location.topLeftCorner.y - location.topRightCorner.y)
                + Math.hypot(location.topRightCorner.x - location.bottomRightCorner.x, location.topRightCorner.y - location.bottomRightCorner.y)) / 3 / height;
            const crosses: NonNullable<Preview["crosses"]> = [];
            for (const [first, second] of [
                [location.topLeftCorner, location.bottomRightCorner],
                [location.topRightCorner, location.bottomLeftCorner]
            ]) {
                for (const [current, opposite] of [[first, second], [second, first]]) {
                    crosses.push({
                        x: current.x / width * 100,
                        y: current.y / height * 100,
                        rot: (Math.atan2(opposite.y - current.y, opposite.x - current.x) - Math.PI / 4) * 180 / Math.PI,
                        size: Math.min(crossSize * size.height, 7)
                    });
                }
            }
            setPreview({ url: scan.url ?? "", size, crosses });
            scan.timeout = setTimeout(() => { void verify(token, scan); }, 1100);
        } catch (err) {
            if (isCurrent(scan)) exit(scan, err instanceof Error ? err.message : "Could not read the image. Try another image.");
        }
    };

    useEffect(() => {
        active.current = true;
        loginWithQR.qrModalOpen = true;
        return () => {
            active.current = false;
            loginWithQR.qrModalOpen = false;
            if (scanRef.current) exit(scanRef.current);
        };
    }, []);

    useEffect(() => {
        const callback = (event: ClipboardEvent) => {
            if (!loginWithQR.started || !event.clipboardData || scanRef.current) return;
            for (const item of event.clipboardData.items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                    const file = item.getAsFile();
                    if (file) { event.preventDefault(); void processImage(file); }
                    break;
                }
                if (item.kind === "string" && item.type === "text/plain") {
                    const scan = begin();
                    if (!scan) return;
                    event.preventDefault();
                    item.getAsString(text => {
                        if (!isCurrent(scan)) return;
                        const token = text.match(tokenRegex)?.[1];
                        if (token) void verify(token, scan);
                        else exit(scan);
                    });
                    break;
                }
            }
        };
        document.addEventListener("paste", callback);
        return () => document.removeEventListener("paste", callback);
    }, []);

    return (
        <div className={cl("modal-container")}>
            <div
                className={cl(
                    "modal-filepaste",
                    preview?.url && "modal-filepaste-preview",
                    dragging && "modal-filepaste-drop"
                )}
                onClick={() =>
                    !loading && inputRef.current?.click()
                }
                onDragEnter={() => setDragging(true)}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                    e.preventDefault();
                    setDragging(false);

                    if (loading) return;

                    for (const item of e.dataTransfer.files) {
                        if (item.type.startsWith("image/")) {
                            void processImage(item);
                            break;
                        }
                    }
                }}
                role="button"
                tabIndex={0}
                aria-disabled={loading}
                onKeyDown={event => {
                    if (!loading && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        inputRef.current?.click();
                    }
                }}
                onDragOver={event => event.preventDefault()}
                style={
                    preview
                        ? {
                            width: `${preview.size.width}rem`,
                            height: `${preview.size.height}rem`,
                        }
                        : undefined
                }
            >
                {preview?.url ? (
                    <div
                        style={{
                            "--scale": Math.max(preview.crosses[0].size * 0.9, 1),
                            "--offset-x": `${50 - preview.crosses.reduce((sum, { x }) => sum + x, 0) / preview.crosses.length}%`,
                            "--offset-y": `${50 - preview.crosses.reduce((sum, { y }) => sum + y, 0) / preview.crosses.length}%`,
                        } as CSSProperties}
                        className={cl("preview-crosses")}
                    >
                        <img src={preview.url} className={cl("preview-image")} alt="Scanned QR code" />
                        {preview.crosses.map(({ x, y, rot, size }) => (
                            <span
                                key={`${x}:${y}`}
                                className={cl("preview-cross")}
                                style={{
                                    left: `${x}%`,
                                    top: `${y}%`,
                                    "--size": `${size}rem`,
                                    "--rot": `${rot}deg`,
                                } as CSSProperties}
                            >
                                <img src={images.cross} draggable={false} />
                            </span>
                        ))}
                    </div>
                ) : loading ? (
                    <Spinner type="wanderingCubes" />
                ) : error ? (
                    <BaseText size="md" weight="semibold" color="text-danger">
                        {error}
                    </BaseText>
                ) : (
                    <>
                        <BaseText size="md" weight="semibold" color="text-strong">
                            Drag and drop an image here, or click to select an image
                        </BaseText>
                        <BaseText size="sm" weight="medium" color="text-muted">
                            Or paste an image from your clipboard!
                        </BaseText>
                        <br />
                        <QrCodeIcon />
                    </>
                )}
            </div>
            <input
                type="file"
                accept="image/*"
                onChange={e => {
                    if (!e.target.files || loading) return;

                    for (const item of e.target.files) {
                        if (item.type.startsWith("image/")) {
                            void processImage(item);
                            break;
                        }
                    }
                    e.target.value = "";
                }}
                ref={inputRef}
                style={{ display: "none" }}
            />
        </div>
    );
}

export default wrapTab(QrModal, "Scan QR Code");
