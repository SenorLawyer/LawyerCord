/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Card } from "@components/Card";
import { HeadphonesIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import { Button, useEffect, useState } from "@webpack/common";

import pl, { Native, settings, SongLinkResult } from ".";
import { Providers } from "./Providers";

const logger = new Logger("SongLink");

interface SongLinkerProps {
    url: string;
    onResolved?: (url: string, result: SongLinkResult) => void;
}

export default function SongLinker({ url, onResolved }: SongLinkerProps) {
    const [songData, setSongData] = useState<SongLinkResult>();
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setFailed(false);

        async function loadSongData() {
            const cached = pl.getFromCache(url);
            if (cached) {
                setSongData(cached);
                onResolved?.(url, cached);
                return;
            }

            setSongData(undefined);

            try {
                const sd = await Native.getTrackData(url);
                if (cancelled) return;

                pl.addToCache(url, sd);
                setSongData(sd);
                onResolved?.(url, sd);
            } catch (error) {
                if (!cancelled) {
                    logger.warn("Failed to fetch song link", error);
                    setFailed(true);
                }
            }
        }

        void loadSongData();

        return () => {
            cancelled = true;
        };
    }, [url, attempt]);

    if (failed) return <BaseText>Could not load this song link. <Button onClick={() => setAttempt(value => value + 1)}>Retry</Button></BaseText>;

    return <BaseText>
        {
            songData ? <Card style={{
                padding: "10px 15px"
            }}>
                <div>
                    <BaseText style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600, fontSize: "1.05rem" }}>
                        <HeadphonesIcon /> {songData.info?.title} - {songData.info?.artist}
                    </BaseText>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px", marginTop: "10px" }}>
                        {
                            Object.keys(songData.links).map(service => settings.store.servicesSettings[service]?.enabled && Providers[service] && <Button key={`${service}-${url}`} style={{
                                width: "20px !important"
                                // @ts-ignore
                            }} variant="secondary" onClick={() => {
                                // FIXME: fix type error
                                // @ts-expect-error ???
                                VencordNative.native.openExternal(settings.store.servicesSettings[service].openInNative && Providers[service].native ? songData.links[service].nativeUri : songData.links[service].url);
                            }}>
                                <img
                                    src={Providers[service].logo}
                                    alt={`${Providers[service].name} logo`}
                                    style={{ width: 16, height: 16, objectFit: "contain", display: "block" }}
                                />
                            </Button>)
                        }
                    </div>
                </div>
            </Card> : <BaseText>Loading song link...</BaseText>
        }
    </BaseText >;
}
