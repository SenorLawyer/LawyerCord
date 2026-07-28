/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import "./checkNodeVersion.js";

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const configuredInstaller = process.env.LAWYERCORD_INSTALLER_PATH;

if (!configuredInstaller) {
    throw new Error(
        "Refusing to download and execute a mutable installer release. " +
        "Set LAWYERCORD_INSTALLER_PATH to an installer binary you built or verified locally."
    );
}

const installerBin = resolve(configuredInstaller);
if (!existsSync(installerBin))
    throw new Error(`LAWYERCORD_INSTALLER_PATH does not exist: ${installerBin}`);

const argStart = process.argv.indexOf("--");
const args = argStart === -1 ? [] : process.argv.slice(argStart + 1);

execFileSync(installerBin, args, {
    stdio: "inherit",
    env: {
        ...process.env,
        LAWYERCORD_USER_DATA_DIR: BASE_DIR,
        LAWYERCORD_DIRECTORY: join(BASE_DIR, "dist/desktop"),
        LAWYERCORD_DEV_INSTALL: "1",
        // Equilotl currently consumes the inherited Equicord variable names.
        EQUICORD_USER_DATA_DIR: BASE_DIR,
        EQUICORD_DIRECTORY: join(BASE_DIR, "dist/desktop"),
        EQUICORD_DEV_INSTALL: "1",
    },
});
