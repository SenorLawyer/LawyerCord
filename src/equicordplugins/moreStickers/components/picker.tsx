/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PickerContent, PickerContentHeader, PickerContentRow, PickerContentRowGrid, PickerHeaderProps, SidebarProps, Sticker, StickerCategoryType, StickerListProps, StickerListRef } from "@equicordplugins/moreStickers/types";
import { sendSticker } from "@equicordplugins/moreStickers/upload";
import { clPicker } from "@equicordplugins/moreStickers/utils";
import { classes } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import { findComponentByCodeLazy } from "@webpack";
import { Clickable, Modal, openModal, React, showToast, TextInput, Toasts } from "@webpack/common";

import { CategoryImage, CategoryScroller, CategoryWrapper, StickerCategory } from "./categories";
import { CancelIcon, CogIcon, IconContainer, RecentlyUsedIcon, SearchIcon } from "./icons";
import { addRecentSticker, getRecentStickers, Header, Packs, RECENT_STICKERS_ID, RECENT_STICKERS_TITLE } from "./misc";

const EMPTY_STICKERS: Sticker[] = [];
const StickerList = findComponentByCodeLazy<StickerListProps>("getSectionDescriptors:", "stickyHeaders:", "rowCountBySection:");

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
    isExpanded,
    onToggle
}: PickerContentHeader) {
    return (
        <div className={clPicker("content-header-wrapper")}>
            <Clickable className={clPicker("content-header-header")}
                aria-expanded={isExpanded}
                aria-label={`Category, ${title}`}
                role="button"
                tabIndex={0}
                onClick={onToggle}
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
                <HeaderCollapseIcon isExpanded={isExpanded} />
            </Clickable>
        </div>
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

    const scrollerRef = React.useRef<StickerListRef>(null);
    const [viewportHeight, setViewportHeight] = React.useState(0);
    const listPadding = React.useMemo(() => [0, 0, Math.max(0, viewportHeight - 32), 8], [viewportHeight]);
    const onResize = React.useCallback(({ height }: { height: number; }) => setViewportHeight(height), []);
    const [collapsedPacks, setCollapsedPacks] = React.useState<Set<string>>(() => new Set());
    const packs = React.useMemo(() => {
        const normalizedQuery = query?.toLowerCase();
        return [
            { id: RECENT_STICKERS_ID, title: RECENT_STICKERS_TITLE, image: <RecentlyUsedIcon width={16} height={16} color="currentColor" />, stickers: recentStickers },
            ...stickerPacks.map(pack => ({ id: pack.id, title: pack.title, image: pack.logo.image, stickers: pack.stickers }))
        ].map(pack => ({ ...pack, stickers: normalizedQuery ? pack.stickers.filter(sticker => sticker.title.toLowerCase().includes(normalizedQuery)) : pack.stickers }));
    }, [stickerPacks, recentStickers, query]);
    const rowCountBySection = React.useMemo(() => packs.map(pack => collapsedPacks.has(pack.id) ? 0 : Math.ceil(pack.stickers.length / 3)), [packs, collapsedPacks]);
    const renderRow = React.useCallback((index: number, { sectionIndex, sectionRowIndex }: { sectionIndex: number; sectionRowIndex: number; }) => {
        const stickers = packs[sectionIndex].stickers.slice(sectionRowIndex * 3, sectionRowIndex * 3 + 3);
        const grids = stickers.map((sticker, colIndex) => ({
            rowIndex: index + 1,
            colIndex: colIndex + 1,
            sticker,
            onHover: setCurrentSticker,
            onSend: (_: Sticker | undefined, keepOpen: boolean | undefined) => { if (!keepOpen) closePopout(); },
            selection
        }));
        return <PickerContentRow key={`${packs[sectionIndex].id}:${stickers[0].id}`} rowIndex={index + 1} channelId={channelId} grid1={grids[0]} grid2={grids[1]} grid3={grids[2]} />;
    }, [packs, channelId, closePopout, selection]);
    const renderSectionHeader = React.useCallback((index: number) => {
        const pack = packs[index];
        return <PickerContentHeader key={pack.id} image={pack.image} title={pack.title} isExpanded={!collapsedPacks.has(pack.id)} onToggle={() => {
            scrollerRef.current?.scrollToSectionTop(index);
            setCollapsedPacks(previous => {
                const next = new Set(previous);
                if (next.has(pack.id)) next.delete(pack.id);
                else next.add(pack.id);
                return next;
            });
        }} />;
    }, [packs, collapsedPacks]);
    const renderSection = React.useCallback((index: number, children: React.ReactNode) => <div key={packs[index].id}>{children}</div>, [packs]);
    React.useEffect(() => {
        if (!selectedStickerPackId) return;
        const section = packs.findIndex(pack => pack.id === selectedStickerPackId);
        if (section !== -1) scrollerRef.current?.scrollToSectionTop(section, { animate: true });
        setSelectedStickerPackId(null);
    }, [selectedStickerPackId, packs, setSelectedStickerPackId]);

    return (
        <selection.Provider value={currentSticker?.id}>
            <div className={clPicker("content-list-wrapper")}>
                <div className={clPicker("content-wrapper")}>
                    <StickerList
                        ref={scrollerRef}
                        className={clPicker("content-scroller")}
                        rowCountBySection={rowCountBySection}
                        rowHeight={108}
                        sectionHeaderHeight={32}
                        stickyHeaders={true}
                        listPadding={listPadding}
                        onResize={onResize}
                        renderRow={renderRow}
                        renderSection={renderSection}
                        renderSectionHeader={renderSectionHeader}
                    />
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
