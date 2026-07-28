#!/usr/bin/node
/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 LawyerCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const INSTALLER_COMMIT = "c6bfed9c941883fb0aa48cc1ab6031ed69334c2a";
const [, , sourceArgument, tag, clientSha, clientAsarArgument] = process.argv;

if (!sourceArgument || !tag || !clientSha || !clientAsarArgument) {
    throw new Error("Usage: prepareInstallerSource.mjs <source-directory> <release-tag> <client-sha> <desktop.asar>");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tag)) throw new Error("Invalid release tag");
if (!/^[a-f0-9]{40}$/u.test(clientSha)) throw new Error("Invalid client commit");

const sourceDirectory = resolve(sourceArgument);
const clientAsar = resolve(clientAsarArgument);
const clientPayload = await readFile(clientAsar);
if (!clientPayload.includes(Buffer.from(`// LawyerCord ${clientSha}`, "utf8")))
    throw new Error("desktop.asar does not match the requested LawyerCord commit");
const revision = spawnSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
});
if (revision.status !== 0 || revision.stdout.trim() !== INSTALLER_COMMIT)
    throw new Error(`Installer source must be the audited commit ${INSTALLER_COMMIT}`);

const expectedFiles = new Map([
    ["constants.go", "1b1110c8686ee56641f486dda940ce33584149707f704528c1c3b6208bfc600b"],
    ["self_updater.go", "008a5c9c4af7b8bc7d48800b9ba4f68a45d8a29ba6c33a1a3dbcffe7f20d22fd"],
    ["github_downloader.go", "943f9eb1a27154ea5964693a20d2b6fd30117360d9d92dc6ab73a46a8ab54f71"],
    ["patcher.go", "5f3661524ef368c33ddca818f3e3ea8c95bf6901791d2435ff6492752691f3a0"],
    ["gui.go", "b4e1a7ceb2236703e5a6cfe917b2ede40328e23a77f30403312ee8ef7d19e5d7"],
    ["cli.go", "5d9d487227984de9389c4809215ab6b4f68bec651bb981565cab179c12fb7680"],
    ["find_discord_linux.go", "16db43eecfe705c1aa5b15fc0f63c86a6f03cedb5e2e16235f8dc0f3c3e851c1"],
    ["winres/winres.json", "5e471b3c8d674e930a504077f4ede58040d543fbb564d354a81a4ed0e8998fb2"],
]);

for (const [file, expectedHash] of expectedFiles) {
    const contents = await readFile(resolve(sourceDirectory, file));
    const actualHash = createHash("sha256").update(contents).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`${file} does not match the audited installer source`);
}

const constantsSource = `/*
 * SPDX-License-Identifier: GPL-3.0
 * Vencord Installer, a cross platform gui/cli app for installing Vencord
 * Copyright (c) 2023 Vendicated and Vencord contributors
 */

package main

import "image/color"

var UserAgent = "LawyerCordInstaller/${tag} (https://github.com/SenorLawyer/LawyerCord)"

var (
\tDiscordGreen  = color.RGBA{R: 0x2D, G: 0x7C, B: 0x46, A: 0xFF}
\tDiscordRed    = color.RGBA{R: 0xEC, G: 0x41, B: 0x44, A: 0xFF}
\tDiscordBlue   = color.RGBA{R: 0x58, G: 0x65, B: 0xF2, A: 0xFF}
\tDiscordYellow = color.RGBA{R: 0xfe, G: 0xe7, B: 0x5c, A: 0xff}
)

var LinuxDiscordNames = []string{
\t"Discord",
\t"DiscordPTB",
\t"DiscordCanary",
\t"DiscordDevelopment",
\t"discord",
\t"discordptb",
\t"discordcanary",
\t"discorddevelopment",
\t"discord-ptb",
\t"discord-canary",
\t"discord-development",
\t"com.discordapp.Discord",
\t"com.discordapp.DiscordPTB",
\t"com.discordapp.DiscordCanary",
\t"com.discordapp.DiscordDevelopment",
}
`;

const downloaderSource = `/*
 * SPDX-License-Identifier: GPL-3.0
 * Vencord Installer, a cross platform gui/cli app for installing Vencord
 * Copyright (c) 2023 Vendicated and Vencord contributors
 */

package main

import (
\t_ "embed"
\t"os"
\t"path/filepath"
\t"regexp"
)

//go:embed lawyercord-desktop.asar
var embeddedLawyerCordAsar []byte

var GithubError error
var GithubDoneChan chan bool
var InstalledHash = "None"
var LatestHash = "${clientSha}"
var IsDevInstall bool

func InitGithubDownloader() {
\tGithubDoneChan = make(chan bool, 1)
\tIsDevInstall = os.Getenv("LAWYERCORD_DEV_INSTALL") == "1" || os.Getenv("EQUICORD_DEV_INSTALL") == "1"
\tif IsDevInstall {
\t\tGithubDoneChan <- true
\t\treturn
\t}

\tLawyerCordFile := LawyerCordDirectory
\tif stat, err := os.Stat(LawyerCordFile); err == nil {
\t\tif stat.IsDir() {
\t\t\tLawyerCordFile = filepath.Join(LawyerCordFile, "main.js")
\t\t}
\t\tif contents, readErr := os.ReadFile(LawyerCordFile); readErr == nil {
\t\t\tif match := regexp.MustCompile(\`// LawyerCord (\\w+)\`).FindSubmatch(contents); match != nil {
\t\t\t\tInstalledHash = string(match[1])
\t\t\t}
\t\t}
\t}
\tGithubDoneChan <- true
}

func installLatestBuilds() error {
\tif IsDevInstall {
\t\treturn nil
\t}
\tif err := os.WriteFile(LawyerCordDirectory, embeddedLawyerCordAsar, 0o644); err != nil {
\t\treturn err
\t}
\tif err := FixOwnership(LawyerCordDirectory); err != nil {
\t\treturn err
\t}
\tInstalledHash = LatestHash
\treturn nil
}
`;

const selfUpdaterSource = `/*
 * SPDX-License-Identifier: GPL-3.0
 * Vencord Installer, a cross platform gui/cli app for installing Vencord
 * Copyright (c) 2023 Vendicated and Vencord contributors
 */

package main

import "errors"

var IsSelfOutdated = false
var SelfUpdateCheckDoneChan = make(chan bool, 1)

func init() {
\tSelfUpdateCheckDoneChan <- true
}

func GetInstallerDownloadLink() string {
\treturn ""
}

func CanUpdateSelf() bool {
\treturn false
}

func UpdateSelf() error {
\treturn errors.New("Installer updates are delivered as immutable LawyerCord releases")
}

func RelaunchSelf() error {
\treturn errors.New("This installer does not replace itself")
}
`;

await writeFile(resolve(sourceDirectory, "constants.go"), constantsSource);
await writeFile(resolve(sourceDirectory, "github_downloader.go"), downloaderSource);
await writeFile(resolve(sourceDirectory, "self_updater.go"), selfUpdaterSource);
await writeFile(
    resolve(sourceDirectory, "buildinfo/lawyercord.go"),
    `package buildinfo\n\nvar ClientGitHash = "${clientSha}"\n`,
);
await copyFile(clientAsar, resolve(sourceDirectory, "lawyercord-desktop.asar"));

for (const file of ["patcher.go", "gui.go", "cli.go", "find_discord_linux.go"]) {
    const path = resolve(sourceDirectory, file);
    const source = await readFile(path, "utf8");
    await writeFile(
        path,
        source
            .replaceAll("EQUICORD", "LAWYERCORD")
            .replaceAll("Equilotl", "LawyerCord Installer")
            .replaceAll("Equicord", "LawyerCord")
            .replaceAll("equicord.asar", "lawyercord.asar"),
    );
}

const winresPath = resolve(sourceDirectory, "winres/winres.json");
const winres = JSON.parse(await readFile(winresPath, "utf8"));
const versionInfo = winres.RT_VERSION["#1"]["0000"].info["0409"];
winres.RT_MANIFEST["#1"]["0409"].description = "An installer for the LawyerCord Discord client mod";
versionInfo.CompanyName = "LawyerCord";
versionInfo.FileDescription = "LawyerCord Installer";
versionInfo.LegalCopyright = "© 2026 Vencord, Equicord, and LawyerCord contributors - GPL-3.0-or-later";
versionInfo.ProductName = "LawyerCord Installer";
await writeFile(winresPath, `${JSON.stringify(winres, null, 2)}\n`);

await Promise.all([
    rm(resolve(sourceDirectory, ".github"), { force: true, recursive: true }),
    rm(resolve(sourceDirectory, ".idea"), { force: true, recursive: true }),
    rm(resolve(sourceDirectory, "install.ps1"), { force: true }),
    rm(resolve(sourceDirectory, "install.sh"), { force: true }),
]);
await writeFile(
    resolve(sourceDirectory, "README.md"),
    `# LawyerCord Installer source\n\nThis is the audited Equilotl installer source at commit \`${INSTALLER_COMMIT}\`, adapted for LawyerCord release \`${tag}\`.\n\nThe installer embeds LawyerCord client commit \`${clientSha}\` and does not download the client or update itself. It modifies a selected local Discord installation only after the user chooses an install or repair action.\n\nOriginal project: https://github.com/Equicord/Equilotl\n`,
);

console.log(`Prepared LawyerCord installer source ${INSTALLER_COMMIT} for ${tag}`);
