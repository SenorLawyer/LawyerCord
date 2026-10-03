/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PickerContent, PickerContentHeader, PickerContentRow, PickerContentRowGrid, PickerHeaderProps, SidebarProps, Sticker, StickerCategoryType } from "@equicordplugins/moreStickers/types";
import { sendSticker } from "@equicordplugins/moreStickers/upload";
import { clPicker } from "@equicordplugins/moreStickers/utils";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import { Modal,openModal, React, showToast, TextInput, Toasts } from "@webpack/common";
import { JSX } from "react";

import { CategoryImage, CategoryScroller, CategoryWrapper, StickerCategory } from "./categories";
import { CancelIcon, CogIcon, IconContainer, RecentlyUsedIcon, SearchIcon } from "./icons";
import { addRecentSticker, getRecentStickers, Header, Packs, RECENT_STICKERS_ID, RECENT_STICKERS_TITLE } from "./misc";

const EMPTY_STICKERS: Sticker[] = [];

export const RecentPack = {
    id: RECENT_STICKERS_ID,
    name: RECENT_STICKERS_TITLE,
} as StickerCategoryType;

export const PickerSidebar = ({ packMetas, onPackSelect }: SidebarProps) => {
    const [activePack, setActivePack] = React.useState<StickerCategoryType>(RecentPack);

    return (
        <CategoryWrapper>
            <CategoryScroller categoryLength={packMetas.length}>
                <StickerCategory
                    style={{ padding: "4px", boxSizing: "border-box", width: "32px" }}
                    isActive={activePack === RecentPack}
                    onClick={() => {
                        if (activePack === RecentPack) return;

                        onPackSelect(RecentPack);
                        setActivePack(RecentPack);
                    }}
                >
                    <RecentlyUsedIcon width={24} height={24} color={
                        activePack === RecentPack ? " var(--interactive-icon-active)" : "var(--interactive-icon-default)"
                    } />
                </StickerCategory>
                {
                    ...packMetas.map(pack => {
                        return (
                            <StickerCategory
                                key={pack.id}
                                onClick={() => {
                                    if (activePack?.id === pack.id) return;

                                    onPackSelect(pack);
                                    setActivePack(pack);
                                }}
                                isActive={activePack?.id === pack.id}
                            >
                                <CategoryImage src={pack.iconUrl!} alt={pack.name} isActive={activePack?.id === pack.id} />
                            </StickerCategory>
                        );
                    })
                }
            </CategoryScroller>
            <div className={clPicker("settings-cog-container")}>
                <button
                    className={clPicker("settings-cog")}
                    aria-label="Sticker pack settings"
                    onClick={() => {
                        openModal(modalProps => {
                            return (
                                <Modal size="lg" title="Stickers+" {...modalProps}>
                                    <Packs />
                                </Modal>
                            );
                        });
                    }}
                >
                    <CogIcon width={20} height={20} />
                </button>
            </div>
        </CategoryWrapper>
    );
};

function PickerContentRowGrid({
    rowIndex,
    colIndex,
    sticker,
    onHover,
    channelId,
    onSend = () => { },
    selection
}: PickerContentRowGrid) {
    return (
        <div
            role="gridcell"
            aria-rowindex={rowIndex}
            aria-colindex={colIndex}
            id={clPicker(`content-row-grid-${rowIndex}-${colIndex}`)}
            onMouseEnter={() => onHover(sticker)}
            onClick={e => {
                if (!channelId) return;

                sendSticker({ channelId, sticker, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
                addRecentSticker(sticker);
                onSend(sticker, e.ctrlKey);
            }}
        >
            <div
                className={clPicker("content-row-grid-sticker")}
            >
                <span className={clPicker("content-row-grid-hidden-visually")}>{sticker.title}</span>
                <div aria-hidden="true">
                    <SelectionIndicator selection={selection} stickerId={sticker.id} />
                    <div className={clPicker("content-row-grid-sticker-node")}>
                        <div className={clPicker("content-row-grid-asset-wrapper")} style={{
                            height: "96px",
                            width: "96px"
                        }}>
                            <img
                                alt={sticker.title}
                                src={sticker.image}
                                draggable="false"
                                data-id={sticker.id}
                                className={clPicker("content-row-grid-img")}
                                loading="lazy"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SelectionIndicator({ selection, stickerId }: { selection: React.Context<string | undefined>; stickerId: string; }) {
    const selectedId = React.useContext(selection);
    return <div className={classes(clPicker("content-row-grid-inspected-indicator"), selectedId === stickerId && "inspected")} />;
}

function PickerContentRow({ rowIndex, grid1, grid2, grid3, channelId }: PickerContentRow) {
    return (
        <div className={clPicker("content-row")}
            role="row"
            aria-rowindex={rowIndex}
        >
            <PickerContentRowGrid {...grid1} rowIndex={rowIndex} colIndex={1} channelId={channelId} />
            {grid2 && <PickerContentRowGrid {...grid2} rowIndex={rowIndex} colIndex={2} channelId={channelId} />}
            {grid3 && <PickerContentRowGrid {...grid3} rowIndex={rowIndex} colIndex={3} channelId={channelId} />}
        </div>
    );
}

function HeaderCollapseIcon({ isExpanded }: { isExpanded: boolean; }) {
    return (
        <svg
            className={clPicker("content-header-collapse-icon")}
            width={16} height={16} viewBox="0 0 24 24"
            style={{
                transform: `rotate(${isExpanded ? "0" : "-90deg"})`
            }}
        >
            <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M16.59 8.59004L12 13.17L7.41 8.59004L6 10L12 16L18 10L16.59 8.59004Z"></path>
        </svg>
    );
}

export function PickerContentHeader({
    image,
    title,
    children,
    isSelected = false,
    afterScroll = () => { },
    beforeScroll = () => { }
}: PickerContentHeader) {

    const [isExpand, setIsExpand] = React.useState(true);
    const headerElem = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (isSelected && headerElem.current) {
            beforeScroll();

            headerElem.current.scrollIntoView({
                behavior: "smooth",
                block: "start",
            });

            afterScroll();
        }
    }, [isSelected]);

    return (
        <span>
            <div className={clPicker("content-header-wrapper")}>
                <div className={clPicker("content-header-header")} ref={headerElem}
                    aria-expanded={isExpand}
                    aria-label={`Category, ${title}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                        setIsExpand(e => !e);
                    }}
                >
                    <div className={clPicker("content-header-header-icon")}>
                        <div>
                            {typeof image === "string" ? <svg
                                className={clPicker("content-header-svg")}
                                width={16} height={16} viewBox="0 0 16 16"
                            >
                                <foreignObject
                                    x={0} y={0} width={16} height={16}
                                    overflow="visible" mask="url(#svg-mask-squircle)"
                                >
                                    <img
                                        alt={title}
                                        src={image}
                                        className={clPicker("content-header-guild-icon")}
                                        loading="lazy"
                                    ></img>
                                </foreignObject>
                            </svg>
                                : image}
                        </div>
                    </div>
                    <span
                        className={clPicker("content-header-header-label")}
                    >
                        {title}
                    </span>
                    <HeaderCollapseIcon isExpanded={isExpand} />
                </div>
            </div>
            {isExpand ? children : null}
        </span>
    );
}

export function PickerContent({ stickerPacks, selectedStickerPackId, setSelectedStickerPackId, channelId, closePopout, query }: PickerContent) {
    const selection = React.useMemo(() => React.createContext<string | undefined>(undefined), []);
    const [currentSticker, setCurrentSticker] = (
        React.useState<Sticker | null>((
            stickerPacks.length && stickerPacks[0].stickers.length) ?
            stickerPacks[0].stickers[0] :
            null
        )
    );

    const currentStickerPack = stickerPacks.find(pack => pack.id === currentSticker?.stickerPackId);
    const [loadedRecents] = useAwaiter(getRecentStickers, {
        fallbackValue: EMPTY_STICKERS,
        onError: () => showToast("Could not load recent stickers.", Toasts.Type.FAILURE)
    });
    const recentStickers = loadedRecents ?? EMPTY_STICKERS;

    const stickerPacksElemRef = React.useRef<HTMLDivElement>(null);
    const scrollerRef = React.useRef<HTMLDivElement>(null);

    const rows = React.useMemo(() => {
        const normalizedQuery = query?.toLowerCase();
        function queryFilter(stickers: Sticker[]): Sticker[] {
            if (!normalizedQuery) return stickers;
            return stickers.filter(sticker => sticker.title.toLowerCase().includes(normalizedQuery));
        }

        const stickersToRows = (stickers: Sticker[]): JSX.Element[] => stickers
            .reduce((acc, sticker, i) => {
                if (i % 3 === 0) {
                    acc.push([]);
                }
                acc[acc.length - 1].push(sticker);
                return acc;
            }, [] as Sticker[][])
            .map((stickers, i) => (
                <PickerContentRow
                    key={stickers[0].id}
                    rowIndex={i}
                    channelId={channelId}
                    grid1={{
                        rowIndex: i,
                        colIndex: 1,
                        sticker: stickers[0],
                        onHover: setCurrentSticker,
                        onSend: (_, s) => { !s && closePopout(); },
                        selection
                    }}
                    grid2={
                        stickers.length > 1 ? {
                            rowIndex: i,
                            colIndex: 2,
                            sticker: stickers[1],
                            onHover: setCurrentSticker,
                            onSend: (_, s) => { !s && closePopout(); },
                            selection
                        } : undefined
                    }
                    grid3={
                        stickers.length > 2 ? {
                            rowIndex: i,
                            colIndex: 3,
                            sticker: stickers[2],
                            onHover: setCurrentSticker,
                            onSend: (_, s) => { !s && closePopout(); },
                            selection
                        } : undefined
                    }
                />
            ));
        return [stickersToRows(queryFilter(recentStickers)), ...stickerPacks.map(pack => stickersToRows(queryFilter(pack.stickers)))];
    }, [stickerPacks, recentStickers, query, channelId, closePopout, selection]);

    return (
        <selection.Provider value={currentSticker?.id}>
            <div className={clPicker("content-list-wrapper")}>
                <div className={clPicker("content-wrapper")}>
                    <div className={clPicker("content-scroller")} ref={scrollerRef}>
                        <div className={clPicker("content-list-items")} role="none presentation">
                            <div ref={stickerPacksElemRef}>
                                <PickerContentHeader
                                    image={
                                        <RecentlyUsedIcon width={16} height={16} color="currentColor" />
                                    }
                                    title={RECENT_STICKERS_TITLE}
                                    isSelected={RECENT_STICKERS_ID === selectedStickerPackId}
                                    beforeScroll={() => {
                                        scrollerRef.current?.scrollTo({
                                            top: 0,
                                        });
                                    }}
                                    afterScroll={() => { setSelectedStickerPackId(null); }}
                                >
                                    {
                                        ...rows[0]
                                    }
                                </PickerContentHeader>
                                {
                                    stickerPacks.map((sp, index) => {
                                        return (
                                            <PickerContentHeader
                                                key={sp.id}
                                                image={sp.logo.image}
                                                title={sp.title}
                                                isSelected={sp.id === selectedStickerPackId}
                                                beforeScroll={() => {
                                                    scrollerRef.current?.scrollTo({
                                                        top: 0,
                                                    });
                                                }}
                                                afterScroll={() => { setSelectedStickerPackId(null); }}
                                            >
                                                {...rows[index + 1]}
                                            </PickerContentHeader>
                                        );
                                    })
                                }
                            </div>
                        </div>
                        <div style={{
                            height: `${stickerPacksElemRef.current?.clientHeight ?? 0}px`
                        }}></div>
                    </div>
                    <div
                        className={clPicker("content-inspector")}
                        style={{
                            visibility: !currentSticker ? "hidden" : "visible",
                            ...(!currentSticker ? {
                                height: "0"
                            } : {})
                        }}
                    >
                        <div className={clPicker("content-inspector-graphic-primary")} aria-hidden="true">
                            <div>
                                <div className={clPicker("content-row-grid-asset-wrapper")} style={{
                                    height: "28px",
                                    width: "28px"
                                }}>
                                    <img
                                        alt={currentSticker?.title ?? ""}
                                        src={currentSticker?.image}
                                        draggable="false"
                                        data-id={currentSticker?.id ?? ""}
                                        className={clPicker("content-inspector-img")}
                                    />
                                </div>
                            </div>
                        </div>
                        <div className={clPicker("content-inspector-text-wrapper")}>
                            <div className={clPicker("content-inspector-title-primary")} data-text-variant="text-md/semibold">{currentSticker?.title ?? ""}</div>
                            <div className={clPicker("content-inspector-title-secondary")} data-text-variant="text-md/semibold">
                                {currentStickerPack?.title ? "from " : ""}
                                <strong>{currentStickerPack?.title ?? ""}</strong>
                            </div>
                        </div>
                        <div className={clPicker("content-inspector-graphic-secondary")} aria-hidden="true">
                            <div>
                                <svg width={32} height={32} viewBox="0 0 32 32">
                                    <foreignObject x={0} y={0} width={32} height={32} overflow="visible" mask="url(#svg-mask-squircle)">
                                        <img
                                            alt={currentStickerPack?.title ?? ""}
                                            src={currentStickerPack?.logo?.image}
                                        ></img>
                                    </foreignObject>
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </selection.Provider>
    );
}

export const PickerHeader = ({ query, onQueryChange }: PickerHeaderProps) => {

    return (
        <Header>
            <div className={clPicker("container")}>
                <div>
                    <div className={clPicker("search-box")}>
                        <TextInput
                            style={{ height: "30px", border: "none" }}

                            placeholder="Search stickers"
                            autoFocus={true}
                            value={query}

                            onChange={onQueryChange}
                        />
                    </div>
                    <div className={clPicker("search-icon")}>
                        <IconContainer>
                            {
                                (query && query.length > 0) ?
                                    <CancelIcon className={clPicker("clear-icon")} width={20} height={20} onClick={() => onQueryChange("")} /> :
                                    <SearchIcon width={20} height={20} color="var(--text-muted)" />
                            }
                        </IconContainer>
                    </div>
                </div>
            </div>
        </Header>
    );
};
