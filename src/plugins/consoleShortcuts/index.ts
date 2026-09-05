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

import { loadLazyChunks } from "@debug/loadLazyChunks";
import { Devs } from "@utils/constants";
import { getCurrentChannel, getCurrentGuild } from "@utils/discord";
import { runtimeHashMessageKey } from "@utils/intlHash";
import { SYM_LAZY_GET } from "@utils/lazy";
import { relaunch } from "@utils/native";
import { canonicalizeMatch, canonicalizeReplace, canonicalizeReplacement } from "@utils/patches";
import definePlugin, { StartAt } from "@utils/types";
import * as Webpack from "@webpack";
import { extract, filters, findAll, findModuleId, search } from "@webpack";
import * as Common from "@webpack/common";
import type { ComponentType } from "react";

const DESKTOP_ONLY = (f: string) => () => {
    throw new Error(`'${f}' is Discord Desktop only.`);
};

const switchBranch = (branch: string) => () => {
    if (!IS_VESKTOP && !IS_EQUIBOP) throw new Error("This function only works on vesktop and equibop.");

    const target = IS_VESKTOP ? Vesktop : Equibop;
    if (target.Settings.store.discordBranch === branch) throw new Error(`Already on ${branch}.`);
    target.Settings.store.discordBranch = branch;
    VesktopNative.app.relaunch();
};

const installedShortcuts = new Map<string, { previous?: PropertyDescriptor; installed: PropertyDescriptor; }>();
let renderWindow: Window | null = null;
let renderRoot: ReturnType<typeof Common.createRoot> | undefined;

function closeFakeRender() {
    const win = renderWindow;
    const root = renderRoot;
    renderWindow = null;
    renderRoot = undefined;
    try { root?.unmount(); } finally { win?.close(); }
}

function installShortcut(key: string, descriptor: PropertyDescriptor) {
    const previous = Object.getOwnPropertyDescriptor(window, key);
    if (previous?.configurable === false) return;
    const installed = { configurable: true, enumerable: true, ...descriptor };
    Object.defineProperty(window, key, installed);
    installedShortcuts.set(key, { previous, installed });
}

function resolveShortcut(value: unknown) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    const resolve = Reflect.get(value, SYM_LAZY_GET) ?? Reflect.get(value, "$$vencordGetWrappedComponent");
    return typeof resolve === "function" ? Reflect.apply(resolve, value, []) : value;
}

function makeShortcuts() {
    function newFindWrapper<Args extends unknown[]>(filterFactory: (...props: Args) => Webpack.FilterFn, topLevelOnly = false) {
        return (...filterProps: Args) => {
            const matches = findAll(filterFactory(...filterProps), { topLevelOnly });
            if (!matches.length) return null;
            const uniqueMatches = [...new Set(matches)];
            if (uniqueMatches.length > 1)
                console.warn(`Warning: This filter matches ${uniqueMatches.length} exports. Make it more specific!\n`, uniqueMatches);
            return matches[0];
        };
    }

    const find = newFindWrapper((filter: Webpack.FilterFn) => filter);
    const findByProps = newFindWrapper(filters.byProps);

    return {
        ...Object.fromEntries(Object.keys(Common).map(key => [key, { getter: () => Common[key] }])),
        wp: Webpack,
        wpc: { getter: () => Webpack.cache },
        wreq: { getter: () => Webpack.wreq },
        wpPatcher: { getter: () => Vencord.WebpackPatcher },
        wpInstances: { getter: () => Vencord.WebpackPatcher.allWebpackInstances },
        wpsearch: search,
        wpex: extract,
        wpexs: (code: string) => {
            const id = findModuleId(code);
            return id == null ? null : extract(id);
        },
        loadLazyChunks: loadLazyChunks,
        find,
        findAll: findAll,
        findByProps,
        findAllByProps: (...props: string[]) => findAll(filters.byProps(...props)),
        findByCode: newFindWrapper(filters.byCode),
        findCssClasses: newFindWrapper(filters.byClassNames, true),
        findAllByCode: (code: string) => findAll(filters.byCode(code)),
        findComponentByCode: newFindWrapper(filters.componentByCode),
        findAllComponentsByCode: (...code: string[]) => findAll(filters.componentByCode(...code)),
        findExportedComponent: (...props: string[]) => findByProps(...props)?.[props[0]],
        findStore: (name: string) => {
            try { return Webpack.findStore(name); } catch { return null; }
        },
        PluginsApi: { getter: () => Vencord.Plugins },
        plugins: { getter: () => Vencord.Plugins.plugins },
        Settings: { getter: () => Vencord.Settings },
        Api: { getter: () => Vencord.Api },
        Util: { getter: () => Vencord.Util },
        reload: () => location.reload(),
        restart: IS_WEB ? DESKTOP_ONLY("restart") : relaunch,
        canonicalizeMatch,
        canonicalizeReplace,
        canonicalizeReplacement,
        runtimeHashMessageKey,
        fakeRender: <Props extends object>(component: ComponentType<Props>, props?: Props) => {
            if (!renderWindow || renderWindow.closed) {
                closeFakeRender();
                const win = window.open("about:blank", "Fake Render", "popup,width=500,height=500");
                if (!win) throw new Error("Could not open the component preview window");
                renderWindow = win;
                try {
                    const doc = win.document;
                    doc.body.style.margin = "1em";

                    for (const style of document.querySelectorAll("style, link[rel=stylesheet]"))
                        doc.head.append(style.cloneNode(true));

                    renderRoot = Common.createRoot(doc.body.appendChild(doc.createElement("div")));
                } catch (error) {
                    closeFakeRender();
                    throw error;
                }
                win.addEventListener("pagehide", () => {
                    if (renderWindow === win) closeFakeRender();
                }, { once: true });
            }
            renderWindow.focus();
            renderRoot?.render(Common.React.createElement(component, props));
        },

        preEnable: (plugin: string) => (Vencord.Settings.plugins[plugin] ??= { enabled: true }).enabled = true,

        channel: { getter: () => getCurrentChannel() },
        channelId: { getter: () => Common.SelectedChannelStore.getChannelId() },
        guild: { getter: () => getCurrentGuild() },
        guildId: { getter: () => Common.SelectedGuildStore.getGuildId() },
        me: { getter: () => Common.UserStore.getCurrentUser() },
        meId: { getter: () => Common.UserStore.getCurrentUser()?.id },
        messages: { getter: () => Common.MessageStore.getMessages(Common.SelectedChannelStore.getChannelId()) },
        openModal: { getter: () => Common.openModal },
        openModalLazy: { getter: () => Common.openModalLazy },

        Stores: { getter: () => Object.fromEntries(Webpack.fluxStores) },

        // e.g. "2024-05_desktop_visual_refresh", 0
        setExperiment: (id: string, bucket: number) => {
            Common.FluxDispatcher.dispatch({
                type: "EXPERIMENT_OVERRIDE_BUCKET",
                experimentId: id,
                experimentBucket: bucket,
            });
        },
        switchBranch,
        ...IS_EQUIBOP ? {
            equibopStable: switchBranch("stable"),
            equibopCanary: switchBranch("canary"),
            equibopPtb: switchBranch("ptb"),
        } : {},
    };
}

export default definePlugin({
    name: "ConsoleShortcuts",
    description: "Adds shorter Aliases for many things on the window. Run `shortcutList` for a list.",
    authors: [Devs.Ven],
    tags: ["Developers", "Console", "Shortcuts", "Utility"],
    startAt: StartAt.Init,

    patches: [
        {
            find: "&&this.initializeIfNeeded()",
            replacement: [
                {
                    match: /\i&&this\.initializeIfNeeded\(\)/,
                    replace: "$&,Reflect.defineProperty(this,Symbol.toStringTag,{value:this.getName(),configurable:!0,writable:!0,enumerable:!1})"
                }
            ]
        }
    ],

    start() {
        if (installedShortcuts.size) return;
        const shortcutList: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(makeShortcuts())) {
            const descriptor = "getter" in value
                ? { get: () => resolveShortcut(value.getter()) }
                : { value, writable: true };
            Object.defineProperty(shortcutList, key, { configurable: true, enumerable: true, ...descriptor });
            installShortcut(key, descriptor);
        }
        installShortcut("shortcutList", { value: shortcutList, writable: true });
    },

    stop() {
        for (const [key, { previous, installed }] of installedShortcuts) {
            const current = Object.getOwnPropertyDescriptor(window, key);
            if (!current?.configurable || current.get !== installed.get || current.set !== installed.set || current.value !== installed.value) continue;
            if (previous) Object.defineProperty(window, key, previous);
            else delete window[key];
        }
        installedShortcuts.clear();
        closeFakeRender();
    }
});
