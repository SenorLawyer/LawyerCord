/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { playAudio } from "@api/AudioPlayer";
import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import { PlainSettings } from "@api/Settings";
import { ErrorBoundary } from "@components/index";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { StartAt } from "@utils/types";
import type { Quest, QuestUserStatus } from "@vencord/discord-types";
import { onceReady } from "@webpack";
import { QuestStore } from "@webpack/common";

import { disguiseHomeButton, QuestButton, showQuestButton } from "./components/questButton";
import { QuestTileContextMenu } from "./components/questTileContextMenu";
import { getQuestifySettings } from "./settings/access";
import { startAutoFetchingQuests, stopAutoFetchingQuests } from "./settings/fetching";
import { validateIgnoredQuests } from "./settings/ignoredQuests";
import { rerenderQuests, useQuestRerender } from "./settings/rerender";
import { disposeRestartTracking, initializeRestartTracking, promptToRestartIfDirty, setRestartDirty } from "./settings/restartTracking";
import { settings } from "./settings/store";
import { getSettingsModalOpen, setInitialQuestDataFetched, setSettingsModalOpen } from "./state";
import managedStyle from "./styles.css?managed";
import { canOpenDevToolsWindow, fetchAndDispatchQuests, openDevToolsWindow, snakeToCamel } from "./utils/fetching";
import { notifyQuestCompletion, QL } from "./utils/logging";
import { getQuestEmbedProgress, getQuestPanelOverride, getQuestPanelPercentComplete } from "./utils/questState";
import { getLastFilterChoices, getLastSortChoice, getQuestTileClasses, getQuestTileStyle, setLastFilterChoices, setLastSortChoice, shouldPreloadQuestAssets, sortQuests } from "./utils/questTiles";
import { formatLowerBadge, QUEST_PAGE } from "./utils/ui";

let isSwitchingAccount = false;
const notifiedCompletedQuests = new Set<string>();
export const enabledOnStartup = PlainSettings.plugins.Questify?.enabled;

function setOnQuestsPage(force?: boolean): void {
    getQuestifySettings().isOnQuestsPage = force ?? (window.location.pathname === QUEST_PAGE);
}

function startPerAccountTasks(source: string): void {
    const startedAt = Date.now();

    setOnQuestsPage();
    startAutoFetchingQuests();
    fetchAndDispatchQuests();

    QL.info(`START_TASKS-${source.toUpperCase()}`, { startedAt });
}

function stopPerAccountTasks(source: string): void {
    const stoppedAt = Date.now();

    setOnQuestsPage();
    stopAutoFetchingQuests();
    notifiedCompletedQuests.clear();

    QL.info(`STOP_TASKS-${source.toUpperCase()}`, { stoppedAt });
}

export default definePlugin({
    name: "Questify",
    description: "Enhance specific Quest features, disable annoyances, or completely remove Quests.",
    tags: ["Appearance", "Customisation", "Privacy", "Utility"],
    authors: [EquicordDevs.Etorix],
    dependencies: ["AudioPlayerAPI", "ServerListAPI"],
    startAt: StartAt.Init, // Needed in order to beat Read All Messages to inserting above the server list.
    managedStyle,
    settings,

    canOpenDevToolsWindow,
    disguiseHomeButton,
    formatLowerBadge,
    getLastFilterChoices,
    getLastSortChoice,
    getQuestEmbedProgress,
    getQuestPanelOverride,
    getQuestPanelPercentComplete,
    getQuestTileClasses,
    getQuestTileStyle,
    getSettingsModalOpen,
    openDevToolsWindow,
    rerenderQuests,
    setLastFilterChoices,
    setLastSortChoice,
    shouldPreloadQuestAssets,
    sortQuests,
    useQuestRerender,

    patches: [
        {
            // Prevent color picker modal and dummy Quest button context menu modal
            // from force scrolling back up to the top of the settings when closed.
            find: ",NodeFilter.SHOW_ELEMENT,{acceptNode:function(",
            replacement: {
                match: /\.focus\(\)/g,
                replace: ".focus({preventScroll:$self.getSettingsModalOpen()?!0:undefined})"
            }
        },
        {
            // Exports the guildless server list item component used by the Quest button.
            find: '="DOWNLOAD_APPS";function',
            replacement: {
                match: /(?=\i:\(\)=>\i.{0,30000}?asContainer:!\i.{0,50};let (\i)=\i.forwardRef\(function)/,
                replace: "GuildlessServerListItemComponent:()=>$1,"
            }
        },
        {
            // Prevents the DMs Quests tab from counting as part of the
            // DM button highlight logic while the Quest button is visible.
            find: "GLOBAL_DISCOVERY),",
            predicate: () => !getQuestifySettings().disableQuestsEverything && showQuestButton(getQuestifySettings().questButtonDisplay, 1, true),
            replacement: {
                match: /(pathname:(\i)}.{0,400}?return )/,
                replace: "$1$self.disguiseHomeButton($2)?false:"
            }
        },
        {
            // Hides the Quest icon on members list nameplates.
            find: '("ActivityStatus"),',
            predicate: () => getQuestifySettings().disableQuestsEverything || getQuestifySettings().disableMembersListPromo,
            replacement: {
                match: /,hasQuest:(?=\i=!1)/,
                replace: ",questifyInvalid1:"
            }
        },
        {
            // Hides the Friends List "Active Now" promotion.
            find: "`application-stream-",
            predicate: () => getQuestifySettings().disableQuestsEverything || getQuestifySettings().disableFriendsListPromo,
            replacement: [
                {
                    match: /(?<=let{party:\i,onChannelContextMenu:\i,)quest:(\i)/,
                    replace: "questifyInvalid2:$1=null"
                }
            ]
        },
        {
            // Hides Quests tab in the Discovery page.
            find: "GLOBAL_DISCOVERY_SIDEBAR},",
            predicate: () => getQuestifySettings().disableQuestsEverything || getQuestifySettings().disableRelocationNotices,
            replacement: [
                {
                    match: /(GLOBAL_DISCOVERY_TABS).map/,
                    replace: '$1.filter(tab=>tab!=="quests").map'
                }
            ]
        },
        {
            // Hides Quests tab in the DMs tab list.
            find: ".QUEST_HOME):",
            predicate: () => getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    match: /(?<="family-center"\):null,)/,
                    replace: "null&&"
                }
            ]
        },
        {
            // Hides the sponsored banner on the Quests page.
            find: "QUEST_HOME)},[]),",
            predicate: () => !getQuestifySettings().disableQuestsEverything && getQuestifySettings().disableSponsoredBanner,
            replacement: {
                match: /(?<=,{questHomeHero:(\i),isLoading:(\i)}=.{0,300}?ORBS_BALANCE_MENU}\)},\[\]\);)/,
                replace: "$1=null;$2=false;"
            }
        },
        {
            // Hides the Quest & Orbs badges on user profiles.
            find: ".MODAL]:26",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything && getQuestifySettings().disableOrbsAndQuestsBadges,
            replacement: [
                {
                    match: /(,\{badges:\i)(?=,displayProfile:\i)/,
                    replace: '$1.filter(badge=>!["quest_completed","orb_profile_badge"].includes(badge.id))',
                }
            ]
        },
        {
            // Overrides the account panel Quest popup and progress display.
            find: "collapsed-with-rewards\":\"collapsed-without-rewards",
            predicate: () => getQuestifySettings().disableAccountPanelPromo || !getQuestifySettings().disableAccountPanelQuestProgress,
            replacement: {
                match: /(?<=function\(\){)(let (\i)=\(0,\i.\i\)\(\);)/,
                replace: "void $self.useQuestRerender();$1$2=$self.getQuestPanelOverride($2);"
            }
        },
        {
            // Prevents fetching Quests.
            find: 'type:"QUESTS_FETCH_CURRENT_QUESTS_BEGIN"',
            group: true,
            predicate: () => getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    // QUESTS_FETCH_CURRENT_QUESTS_BEGIN
                    match: /(?<=if\(\i.\i.isFetchingCurrentQuests)/,
                    replace: "||true"
                },
                {
                    // QUESTS_FETCH_QUEST_TO_DELIVER_BEGIN
                    match: /(?=let \i=Date.now\(\);\i.recordQuestRequestAttempt.{0,50}QUESTS_FETCH_QUEST_TO_DELIVER_BEGIN)/,
                    replace: "return;"
                }
            ]
        },
        {
            // Fixes the progress tracking for Quests.
            find: ",{progressTextAnimation:",
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: {
                match: /(let{percentComplete:.{0,115}?children:\i,useAltStyle:\i=!1}=)(\i)/,
                replace: "const questifyProgress=$self.getQuestPanelPercentComplete({...$2,quest:$2.children?.props?.quest});$1Object.assign({},$2,questifyProgress??{})"
            }
        },
        {
            // Formats the Orbs balance on the Quests page with locale string formatting.
            find: '("BalanceCounter")',
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    match: /(`\${(\i).toFixed\(0\)}`.length)/,
                    replace: "$1+($2>=1e6?0.8:$2>=1e3?0.4:0)"
                },
                {
                    match: /(?<=children:\i.to\(\i=>`\${\i).toFixed\(0\)/,
                    replace: ".toLocaleString(undefined,{maximumFractionDigits:0})"
                }
            ]
        },
        {
            find: "QUEST_HOME)},[]),",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    // Subscribes the Quest page sort/filter state to Questify rerenders.
                    match: /(let \i,\i,\i,\i,\i=\i\.useRef\(null\),)/,
                    replace: "$1questRerenderTrigger=$self.useQuestRerender(),"
                },
                {
                    // Set the initial sort method.
                    match: /(\i.\i.SUGGESTED)/,
                    replace: "$self.getLastSortChoice()??$1"
                },
                {
                    // Set the initial filters and update the filters and sort method when they change.
                    match: /(get\(\i\)\)\?\?)(\i,\[)(\i)(\]\),\i=\i.useCallback\((\i)=>{)(.{0,60}?useCallback\((\i)=>{)/,
                    replace: "$1$self.getLastFilterChoices()??$2$3,questRerenderTrigger$4$self.setLastSortChoice($5);$6$self.setLastFilterChoices($7);$self.rerenderQuests();"
                },
                {
                    // Update the last used sort and filter choices when the toggle setting for either is changed.
                    match: /(?<=ALL,\i.useMemo\(\(\)=>\()({sortMethod:(\i),filters:(\i))/,
                    replace: "$self.setLastSortChoice($2),$self.setLastFilterChoices($3),$1"
                }
            ]
        },
        {
            find: "QUEST_HOME_TILE_HEADER_WATCH_VIDEO})},",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    // Let completed/claimed Quests with CTAs use the generalized CTA row.
                    match: /(\(\i===\i\.\i\.COMPLETED\|\|\i===\i\.\i\.CLAIMED\)&&)(?=\(0,\i\.\i\)\((\i)\))/,
                    replace: "$1!$2.config.ctaConfig&&"
                },
                {
                    // Always expose the external CTA when the Quest has one configured.
                    match: /(?<=wrap:!1,children:\[)(\i)(?=&&\(0,\i\.jsx\)\(\i,\{quest:(\i))/,
                    replace: "($2.config.ctaConfig||$1)"
                }
            ]
        },
        {
            find: 'STEP_2_CLICKED_INTERNAL,"quest_embed_card_footer',
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    // Subscribes each Quest message embed to Questify's manual rerender trigger.
                    match: /(?<=function \i\(\i\){)(?=let\{quest:\i,location:\i,questContentPosition:\i,sourceQuestContent:)/,
                    replace: "void $self.useQuestRerender();"
                },
                {
                    // Overrides the progress tracking for Quest embeds.
                    match: /(?<=\{completedRatio:\i,completedRatioDisplay:\i\}=)(\(0,\i\.\i\)\((\i)\))/,
                    replace: "Object.assign({},$1,$self.getQuestEmbedProgress($2)??{})"
                },
                {
                    // Adds Questify tile classes and inline CSS variables.
                    match: /(?<=className:)(\i\(\)\(\i.\i,\i.\i\)(?=,onMouseEnter:\i))/,
                    replace: "$self.getQuestTileClasses($1,arguments[0].quest),style:$self.getQuestTileStyle(arguments[0].quest)"
                }
            ]
        },
        {
            find: "QUEST_HOME_TILE_HEADER_WATCH_VIDEO})},",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    // Subscribes each Quest tile to Questify's manual rerender trigger.
                    match: /(?=return\(0,\i\.\i\)\("article",\{id:)/,
                    replace: "void $self.useQuestRerender();"
                },
                {
                    // Adds Questify tile classes and inline CSS variables.
                    match: /(?<=className:)(\i\(\)\(\i\.\i,\i\))(?=,onMouseEnter)/,
                    replace: "$self.getQuestTileClasses($1,arguments[0].quest),style:$self.getQuestTileStyle(arguments[0].quest)"
                },
                {
                    // Skips the reward placeholder when assets are preloaded.
                    match: /(?<=showPlaceholder:)(!\i)(?=,width)/g,
                    replace: "$self.shouldPreloadQuestAssets()?!1:$1"
                },
                {
                    // Disables lazy loading for Quest art when preloading is enabled.
                    match: /(?<=onLoadComplete:\i,lazyLoad:)!0/g,
                    replace: "$self.shouldPreloadQuestAssets()?!1:!0"
                },
                {
                    // Treats the banner & reward content as visible so it loads immediately when preloading.
                    match: /(?<=isVisibleInViewport:)(\i)(?=,sourceQuestContent:\i\}\))/g,
                    replace: "$self.shouldPreloadQuestAssets()?true:$1"
                }
            ]
        },
        {
            // Adds the Questify sort option to Discord's Quest sort enum.
            find: "SUGGESTED=\"suggested\",",
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: {
                match: /(?<=\(\((\i)=\{\}\))(?=\.SUGGESTED="suggested",)/,
                replace: ".QUESTIFY=\"questify\",$1"
            }
        },
        {
            // Labels the injected Questify sort option in the dropdown.
            find: "has no rewards configured`",
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: {
                match: /(?=case (\i\.\i)\.SUGGESTED)/,
                replace: "case $1.QUESTIFY:return\"Questify\";"
            },
        },
        {
            find: "CLAIMED=\"claimed\",",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    // Runs Questify sorting in the hook-safe Quest list path and tracks manual rerenders.
                    match: /,(\i)=new Map\((\i)\.map/,
                    replace: ";const questRerenderTrigger=$self.useQuestRerender();const questifySorted=$self.sortQuests($2,arguments[1]?.sortMethod!==\"questify\");let $1=new Map($2.map"
                },
                {
                    // Replaces Discord's filtered Quest list with Questify's order only when selected.
                    match: /(?=if\(0===(\i)\.length\)return\[\];if\(\i\.current\.length>0)/,
                    replace: "if(arguments[1]?.sortMethod===\"questify\"){$1=questifySorted;};"
                },
                {
                    // Bypasses Discord's memo cache while the Questify sort is active.
                    match: /(?<=if\()(?=\i\.current\.length>0&&\i\.current===)/,
                    replace: "arguments[1]?.sortMethod!==\"questify\"&&"
                },
                {
                    // If we already applied Questify's sort, skip further sorting.
                    match: /(?<=\{sortMethod:(\i).{0,750}?return )((\i).sort)/,
                    replace: "$1===\"questify\"?$3:$2"
                },
                {
                    // Recomputes Discord's Quest list memo when Questify settings or rerenders change.
                    match: /(?=]\)\),\i=\(\i=\i.useMemo\(\(\)=>\i.filter)/,
                    replace: ",questRerenderTrigger,questifySorted"
                }
            ]
        },
        {
            // Sorts the "Claimed Quests" tabs.
            find: ".ALL)}):(",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: [
                {
                    match: /(return \i&&0===\i.length.{0,150}?children:)\[\.\.\.(\i).{0,100}?claimedAt\?\?""\)\)/,
                    replace: "const questifySorted=$self.sortQuests($2);$1questifySorted"
                },
            ]
        },
        {
            // Allow non-shareable Quests to embed in chat and to have
            // their share URLs copyable from the embed context menu.
            find: "NOT_SHAREABLE}function",
            group: true,
            predicate: () => !getQuestifySettings().disableQuestsEverything,
            replacement: {
                match: /(?<=return )(?=\i.sharePolicy!==\i.\i.NOT_SHAREABLE)/,
                replace: "true||"
            }
        },
        {
            // Adds a maxDigits prop to the LowerBadge component which allows for not truncating, or for truncating at a specific threshold.
            find: ".BADGE_NOTIFICATION_BACKGROUND.css,disableColor",
            group: true,
            replacement: [
                {
                    // Extracts the custom maxDigits prop.
                    match: /(=>{let{count:\i,)/,
                    replace: "$1maxDigits,"
                },
                {
                    // Passes maxDigits to the rounding function.
                    match: /(children:\i\(\i)/,
                    replace: "$1,maxDigits"
                },
                {
                    // Makes use of the custom prop if provided by using custom logic for negatives and
                    // truncation. If the prop is not provided, assume default behavior for native badges.
                    match: /(?<=function \i\((\i))(\){return )(\i<1e3.{0,60}?k\+`)/,
                    replace: ",maxDigits$2maxDigits===undefined?($3):$self.formatLowerBadge($1,maxDigits)[0]"
                }
            ]
        },
    ],

    flux: {
        CHANNEL_SELECT() { setOnQuestsPage(); },

        QUESTS_FETCH_CURRENT_QUESTS_SUCCESS(data: { quests: Quest[]; }): void {
            setInitialQuestDataFetched(true);
            QL.log("QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", data);
            validateIgnoredQuests(data.quests);
        },

        QUESTS_ENROLL_SUCCESS(data: any): void {
            QL.log("QUESTS_ENROLL_SUCCESS", data);
            validateIgnoredQuests();
        },

        QUESTS_CLAIM_REWARD_SUCCESS(data: any): void {
            QL.log("QUESTS_CLAIM_REWARD_SUCCESS", data);
            validateIgnoredQuests();
        },

        QUESTS_USER_STATUS_UPDATE(data: any): void {
            QL.log("QUESTS_USER_STATUS_UPDATE", data);

            const userStatus = snakeToCamel(data).userStatus as QuestUserStatus | undefined;
            const claimedAt = !!userStatus?.claimedAt;
            const completedRecently = userStatus?.completedAt
                ? Date.now() - new Date(userStatus.completedAt).getTime() <= 5000
                : false;

            validateIgnoredQuests();

            if (completedRecently && !claimedAt && !notifiedCompletedQuests.has(userStatus!.questId)) {
                notifiedCompletedQuests.add(userStatus!.questId);

                if (getQuestifySettings().notifyOnQuestComplete) {
                    notifyQuestCompletion(QuestStore.getQuest(userStatus!.questId));
                }

                if (getQuestifySettings().questCompletedAlertSound) {
                    playAudio(
                        getQuestifySettings().questCompletedAlertSound,
                        { volume: Math.max(0, Math.min(100, getQuestifySettings().questCompletedAlertVolume)) }
                    );
                }
            }
        },

        USER_SETTINGS_MODAL_OPEN(): void {
            setSettingsModalOpen(true);
        },

        USER_SETTINGS_MODAL_CLOSE(): void {
            setSettingsModalOpen(false);
            promptToRestartIfDirty();
        },

        LOGIN_SUCCESS(): void {
            if (!isSwitchingAccount || getQuestifySettings().disableQuestsEverything) {
                return;
            } else {
                isSwitchingAccount = false;
            }

            setInitialQuestDataFetched(false);
            startPerAccountTasks("LOGIN_SUCCESS");
        },

        LOGOUT(data: { isSwitchingAccount?: boolean; }): void {
            if (!data.isSwitchingAccount) {
                return;
            } else {
                isSwitchingAccount = true;
            }

            setInitialQuestDataFetched(false);
            stopPerAccountTasks("LOGOUT");
        },
    },

    contextMenus: {
        "quests-entry": QuestTileContextMenu,
    },

    renderQuestifyButton: ErrorBoundary.wrap(QuestButton, { noop: true }),

    start() {
        if (!enabledOnStartup && PlainSettings.plugins.Questify?.enabled) {
            setRestartDirty(true);
        }

        initializeRestartTracking(settings);

        if (enabledOnStartup) {
            addServerListElement(ServerListRenderPosition.Above, this.renderQuestifyButton);
        }

        onceReady.then(() => {
            if (!getQuestifySettings().disableQuestsEverything) {
                startPerAccountTasks("PLUGIN_START");
            } else {
                removeServerListElement(ServerListRenderPosition.Above, this.renderQuestifyButton);
            }
        });
    },

    stop() {
        disposeRestartTracking();
        removeServerListElement(ServerListRenderPosition.Above, this.renderQuestifyButton);
        stopPerAccountTasks("PLUGIN_STOP");
    }
});
