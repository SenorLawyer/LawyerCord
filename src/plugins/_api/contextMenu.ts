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

import { Devs } from "@utils/constants";
import { canonicalizeMatch } from "@utils/patches";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

// duplicate values have multiple branches with different types. Just include all to be safe
const nameMap = {
    radio: "MenuRadioItem",
    separator: "MenuSeparator",
    checkbox: "MenuCheckboxItem",
    groupstart: "MenuGroup",

    control: "MenuControlItem",
    compositecontrol: "MenuControlItem",

    item: "MenuItem",
    customitem: "MenuItem",
};

export default definePlugin({
    name: "ContextMenuAPI",
    description: "API for adding/removing items to/from context menus.",
    authors: [Devs.Nuckyz, Devs.Ven, Devs.Kyuuhachi],
    required: true,

    patches: [
        {
            find: "navId:",
            all: true,
            noWarn: true,
            replacement: [
                {
                    match: /navId:(?=.{1,150}?([,}].{0,300}?\)))/g,
                    replace: (m, rest, ...args) => {
                        if (rest.match(/}=.+/)) return m;
                        const src = args[1].slice(Math.max(0, +args[0] - 2000), +args[0]);
                        if (Math.max(src.lastIndexOf("PureComponent{"), src.lastIndexOf("Component{")) > src.lastIndexOf("function")) return m;
                        return `contextMenuAPIArguments:typeof arguments!=='undefined'?arguments:[],${m}`;
                    }
                }
            ]
        },

        {
            find: "Menu API only allows Items",
            replacement: [
                // Patch the central context menu handler
                {
                    match: /function \i\((\i)\)\{(?=let\{[^}]{0,150}\bnavId:)/,
                    replace: "$&$1=Vencord.Api.ContextMenu._usePatchContextMenu($1);"
                },

                // Demangle Discord's Menu Item module
                {
                    match: /}$/,
                    replace: (match, _offset, source) => {
                        const start = source.search(canonicalizeMatch(/\(\i\.type===\i\.\i\).{0,50}?navigable:/));
                        const end = source.indexOf("Menu API only allows Items");
                        if (start === -1 || end < start) return match;
                        const menuItems = source.slice(start, end);
                        const registerCalls = [] as string[];

                        const typeCheckRe = canonicalizeMatch(/\(\i\.type===(\i\.\i)\)/g); // if (t.type === m.MenuItem)
                        const pushTypeRe = /type:"(\w+)"/g; // push({type:"item"})

                        let typeMatch: RegExpExecArray | null;
                        while ((typeMatch = typeCheckRe.exec(menuItems)) !== null) {
                            const component = typeMatch[1];
                            // Set the starting index of the second regex to that of the first to start
                            // matching from after the if
                            pushTypeRe.lastIndex = typeCheckRe.lastIndex;

                            // extract the first type: "..."
                            const type = pushTypeRe.exec(menuItems)?.[1];
                            if (type && type in nameMap) {
                                const name = nameMap[type];
                                registerCalls.push(`$self.registerMenuItem("${name}",${component})`);
                            }
                        }

                        if (registerCalls.length < 6) {
                            console.warn("[MenuItemDemanglerAPI] Expected to remap 6 items, only remapped", registerCalls.length);
                        }

                        return `${registerCalls.join(";")};}`;
                    },
                }
            ],
        },
        {
            find: '"message-reminder-create"',
            replacement: {
                match: /Menu:(\i)=>\{/g,
                replace: "Menu:function($1){"
            }
        }
    ],

    registerMenuItem(name: string, component: any) {
        Object.defineProperty(component, "name", { value: name });
        Menu[name] = component;
    }
});
