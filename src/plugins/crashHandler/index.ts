/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { clearPreviousChannel } from "@plugins/keepCurrentChannel";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { maybePromptToUpdate } from "@utils/updater";
import { findByPropsLazy } from "@webpack";
import { closeAllModals, DraftType, ExpressionPickerStore, FluxDispatcher, NavigationRouter, SelectedChannelStore } from "@webpack/common";

const CrashHandlerLogger = new Logger("CrashHandler");

const ModalStack = findByPropsLazy("pushLazy", "popAll");
const DraftManager = findByPropsLazy("clearDraft", "saveDraft");

const settings = definePluginSettings({
    attemptToPreventCrashes: {
        type: OptionType.BOOLEAN,
        description: "Whether to attempt to prevent Discord crashes.",
        default: true
    },
    attemptToNavigateToHome: {
        type: OptionType.BOOLEAN,
        description: "Whether to attempt to navigate to the home when preventing Discord crashes.",
        default: false
    }
});

interface CrashState {
    error: unknown;
    info?: unknown;
}

interface CrashBoundary {
    setState(state: CrashState): void;
}

let hasCrashedOnce = false;
let isRecovering = false;
let shouldAttemptRecover = true;

export default definePlugin({
    name: "CrashHandler",
    performance: {
        impact: "low",
        description: "Attempts recovery only when Discord reports a client crash."
    },
    description: "Utility plugin for handling and possibly recovering from crashes without a restart",
    authors: [Devs.Nuckyz],
    tags: ["Utility", "Developers"],
    enabledByDefault: true,
    settings,

    patches: [
        {
            find: "#{intl::ERRORS_UNEXPECTED_CRASH}",
            replacement: {
                match: /this\.setState\(/,
                replace: "$self.handleCrash(this,"
            }
        }
    ],

    handleCrash(_this: CrashBoundary, errorState: CrashState) {
        void clearPreviousChannel();

        const { info } = errorState;
        if (IS_DEV && info !== null && typeof info === "object" && "componentStack" in info)
            CrashHandlerLogger.error("Component Stack:", info.componentStack);
        _this.setState(errorState);

        // Already recovering, prevent error which happens more than once too fast to trigger another recover
        if (isRecovering) return;
        isRecovering = true;

        // 1 ms timeout to avoid react breaking when re-rendering
        setTimeout(() => {
            // Set isRecovering to false before setting the state to allow us to handle the next crash error correcty, in case it happens
            setImmediate(() => isRecovering = false);

            // Prevent a crash loop with an error that could not be handled
            if (!shouldAttemptRecover) {
                try {
                    showNotification({
                        color: "#eed202",
                        title: "Discord has crashed!",
                        body: "Awn :( Discord has crashed two times rapidly, not attempting to recover.",
                        noPersist: true,
                    });
                } catch (err) {
                    CrashHandlerLogger.debug("Failed to show crash notification.", err);
                }

                return;
            }

            shouldAttemptRecover = false;
            // This is enough to avoid a crash loop
            setTimeout(() => shouldAttemptRecover = true, 1000);

            if (!hasCrashedOnce) {
                hasCrashedOnce = true;
                void maybePromptToUpdate("Uh oh, Discord has just crashed... but good news, there is a LawyerCord update available that might fix this issue! Would you like to update now?", true);
            }

            try {
                if (settings.store.attemptToPreventCrashes) {
                    this.handlePreventCrash(_this);
                }
            } catch (err) {
                CrashHandlerLogger.error("Failed to handle crash", err);
            }
        }, 1);
    },

    handlePreventCrash(_this: CrashBoundary) {
        try {
            showNotification({
                color: "#eed202",
                title: "Discord has crashed!",
                body: "Attempting to recover...",
                noPersist: true,
            });
        } catch (err) {
            CrashHandlerLogger.debug("Failed to show recovery notification.", err);
        }

        try {
            const channelId = SelectedChannelStore.getChannelId();

            DraftManager.clearDraft(channelId, DraftType.ChannelMessage);
            DraftManager.clearDraft(channelId, DraftType.FirstThreadMessage);
        } catch (err) {
            CrashHandlerLogger.debug("Failed to clear drafts.", err);
        }
        try {
            ExpressionPickerStore.closeExpressionPicker();
        }
        catch (err) {
            CrashHandlerLogger.debug("Failed to close expression picker.", err);
        }
        try {
            FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" });
        } catch (err) {
            CrashHandlerLogger.debug("Failed to close open context menu.", err);
        }
        try {
            ModalStack.popAll();
        } catch (err) {
            CrashHandlerLogger.debug("Failed to close old modals.", err);
        }
        try {
            closeAllModals();
        } catch (err) {
            CrashHandlerLogger.debug("Failed to close all open modals.", err);
        }
        try {
            FluxDispatcher.dispatch({ type: "USER_PROFILE_MODAL_CLOSE" });
        } catch (err) {
            CrashHandlerLogger.debug("Failed to close user popout.", err);
        }
        try {
            FluxDispatcher.dispatch({ type: "LAYER_POP_ALL" });
        } catch (err) {
            CrashHandlerLogger.debug("Failed to pop all layers.", err);
        }
        try {
            FluxDispatcher.dispatch({
                type: "DEV_TOOLS_SETTINGS_UPDATE",
                settings: { displayTools: false, lastOpenTabId: "analytics" }
            });
        } catch (err) {
            CrashHandlerLogger.debug("Failed to close DevTools.", err);
        }

        if (settings.store.attemptToNavigateToHome) {
            try {
                NavigationRouter.transitionToGuild("@me");
            } catch (err) {
                CrashHandlerLogger.debug("Failed to navigate to home", err);
            }
        }

        try {
            _this.setState({ error: null, info: null });
        } catch (err) {
            CrashHandlerLogger.debug("Failed to update crash handler component.", err);
        }
    }
});
