/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { cpSync, moveSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs-extra";
import { dirname, join, relative } from "path";

readdirSync(join(__dirname, "src"))
    .forEach(child => moveSync(join(__dirname, "src", child), join(__dirname, child), { overwrite: true }));

const VencordSrc = join(__dirname, "..", "..", "src");

for (const file of ["preload.d.ts", "userplugins", "debug", "src", "browser", "scripts"]) {
    rmSync(join(__dirname, file), { recursive: true, force: true });
}

function copyDtsFiles(from: string, to: string) {
    for (const file of readdirSync(from, { withFileTypes: true })) {
        // bad
        if (from === VencordSrc && file.name === "globals.d.ts") continue;

        const fullFrom = join(from, file.name);
        const fullTo = join(to, file.name);

        if (file.isDirectory()) {
            copyDtsFiles(fullFrom, fullTo);
        } else if (file.name.endsWith(".d.ts")) {
            cpSync(fullFrom, fullTo);
        }
    }
}

copyDtsFiles(VencordSrc, __dirname);

const discordTypes = join(__dirname, "discord-types");
rmSync(discordTypes, { recursive: true, force: true });
for (const entry of ["src", "enums", "webpack", "package.json", "LICENSE"]) {
    cpSync(join(__dirname, "..", "discord-types", entry), join(discordTypes, entry), { recursive: true });
}

function useBundledDiscordTypes(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "discord-types") continue;
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
            useBundledDiscordTypes(file);
        } else if (entry.name.endsWith(".d.ts")) {
            const target = relative(dirname(file), discordTypes).replaceAll("\\", "/");
            const modulePath = target.startsWith(".") ? target : `./${target}`;
            const source = readFileSync(file, "utf8");
            const bundled = source.replace(/(["'])@vencord\/discord-types((?:\/[^"']*)?)\1/g, (_match: string, quote: string, subpath: string) => `${quote}${modulePath}${subpath}${quote}`);
            if (bundled !== source) writeFileSync(file, bundled);
        }
    }
}

useBundledDiscordTypes(__dirname);
