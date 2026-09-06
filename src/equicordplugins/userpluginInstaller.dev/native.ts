/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { exec, execFile, spawn } from "child_process";
import { BrowserWindow, dialog, shell } from "electron";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "fs/promises";
import { basename, dirname, join } from "path";
import { createSourceFile, isCallExpression, isExportAssignment, isIdentifier, isObjectLiteralExpression, isPropertyAssignment, isStringLiteralLike, ScriptTarget } from "typescript";
import yaml from "yaml-js";

// @ts-ignore fuck off
import pluginValidateContent from "./misc/pluginValidate.txt"; // i would use HTML but esbuild is being whiny
// @ts-ignore fuck off
import updateValidateContent from "./misc/updateValidate.txt"; // see above

// if edited, also edit in misc/constants.ts!!!
const CLONE_LINK_REGEX = /https:\/\/(?:((?:git(?:hub|lab)\.com|git\.(?:[a-zA-Z0-9]|\.)+|codeberg\.org))\/(?!user-attachments)((?:[a-zA-Z0-9]|-)+)\/((?:[a-zA-Z0-9]|-|\.)+)(?:\.git)?|(plugins\.(nin0)\.dev)\/((?:[a-zA-Z0-9]|-|\.)+))(?:\/)?/;

const vencordPath = ["desktop", "equibop"].includes(basename(__dirname)) ? join(__dirname, "../") : __dirname;

function getPluginDirectory(name: unknown): string;
function getPluginDirectory(name: unknown, allowMissing: true): string | undefined;
function getPluginDirectory(name: unknown, allowMissing = false): string | undefined {
    if (typeof name !== "string" || !name || name.length > 255 || name === "." || name === ".." || /[/\\:\0]/.test(name))
        throw new Error("Invalid plugin directory.");

    try {
        const root = realpathSync(join(vencordPath, "../src/userplugins"));
        let directory: string;
        try {
            directory = realpathSync(join(root, name));
        } catch (error) {
            if (allowMissing && typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
            throw error;
        }
        if (dirname(directory) === root) return directory;
    } catch {
        throw new Error("Invalid plugin directory.");
    }
    throw new Error("Invalid plugin directory.");
}

export async function ensurePluginsDirectory() {
    if (!IS_DEV) return;
    try {
        await mkdir(join(vencordPath, "../src/userplugins"), { recursive: true });
    } catch {
        throw new Error("Could not create the userplugins directory.");
    }
}

let mutationPending: Promise<void> | undefined;

async function runPluginMutation<T>(operation: () => Promise<T>, wait = false): Promise<T> {
    while (mutationPending) {
        if (!wait) throw new Error("Another plugin operation is in progress. Finish it before trying again.");
        await mutationPending;
    }
    let release: () => void = () => {};
    mutationPending = new Promise<void>(resolve => { release = resolve; });
    try {
        return await operation();
    } finally {
        mutationPending = undefined;
        release();
    }
}

export async function rmPlugin(_, name: string): Promise<boolean> {
    return runPluginMutation(async () => {
        getPluginDirectory(name);
        const plugins = await getUserplugins().catch(() => { throw new Error("Could not read installed plugins."); });
        const plugin = plugins.find(plugin => plugin.directory === name);
        if (!plugin) throw new Error("Plugin not found.");

        const confirmation = await dialog.showMessageBox({
            title: "Uninstall plugin",
            message: `Uninstall ${plugin.name}`,
            type: "error",
            detail: `The uninstall of the userplugin ${plugin.name} has been requested. Would you like to do so?\n\nIf you did not initiate this, press No.`,
            buttons: ["No", "Yes"]
        });

        if (confirmation.response !== 1) return false;
        try {
            await rm(getPluginDirectory(name), { recursive: true });
            await build();
        } catch {
            throw new Error("Could not uninstall the plugin.");
        }
        return true;
    });
}

export async function isUpdateAvailableForPlugin(_, name: string): Promise<boolean> {
    return runPluginMutation(async () => {
        const pluginDir = getPluginDirectory(name, true);
        if (pluginDir === undefined) return false;
        return new Promise(resolve => {
            exec("git fetch", {
                cwd: pluginDir,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "false" }
            }, error => {
                if (error) return resolve(false);
                exec("git rev-list --count HEAD..origin/HEAD", { cwd: pluginDir }, (error, stdout) => {
                    if (error) return resolve(false);
                    resolve(Number(stdout.trim()) > 0);
                });
            });
        });
    }, true);
}

export async function initPluginInstall(_, link: string, source: string, owner: string, repo: string): Promise<{ name: string; native: boolean; }> {
    return runPluginMutation(async () => {
        if (typeof link !== "string" || link.length > 8192 || typeof source !== "string" || typeof owner !== "string"
            || typeof repo !== "string" || !repo || repo.length > 255 || repo === "." || repo === "..")
            return Promise.reject(new Error("Invalid link."));
        const verifiedRegex = link.match(CLONE_LINK_REGEX);
        const idpl = source === "plugins.nin0.dev" ? 1 : 0;
        if (!verifiedRegex || verifiedRegex[0] !== link || verifiedRegex[[1, 4][idpl]] !== source || verifiedRegex[[2, 5][idpl]] !== owner || verifiedRegex[[3, 6][idpl]] !== repo)
            return Promise.reject(new Error("Invalid link."));

        // Ask for clone
        const cloneDialog = await dialog.showMessageBox({
            title: "Clone userplugin",
            message: `You are about to clone a userplugin from ${source}.`,
            type: "question",
            detail: `The repository name is "${repo}" and it is owned by "${owner}".\nThe repository URL is ${link}\n\n(If you did not request this intentionally, choose Cancel)`,
            buttons: ["Cancel", "Clone repository and continue install", "Open repository in browser"]
        }).catch(() => { throw new Error("Could not open the clone confirmation."); });
        switch (cloneDialog.response) {
            case 0: {
                throw new Error("Rejected by user");
            }
            case 1: {
                break;
            }
            case 2: {
                await shell.openExternal(link).catch(() => { throw new Error("Could not open the repository."); });
                throw new Error("silentStop");
            }
        }

        const stagingPath = await mkdtemp(join(vencordPath, "..", "src", "userplugins", ".install-"))
            .catch(() => { throw new Error("Could not create the plugin staging directory."); });
        const stagingName = basename(stagingPath);
        let approved = false;
        try {
            await cloneRepo(link, stagingName).catch(() => { throw new Error("Could not clone the plugin."); });
            // Get plugin meta
            const meta = await getPluginMeta(getPluginDirectory(stagingName))
                .catch(() => { throw new Error("Could not read the plugin metadata."); });

            return await new Promise<{ name: string; native: boolean; }>((resolve, reject) => {
                // Review plugin
                const win = new BrowserWindow({
                    maximizable: false,
                    minimizable: false,
                    width: 560,
                    height: meta.usesNative || meta.usesPreSend ? 650 : 360,
                    resizable: false,
                    webPreferences: {
                        devTools: true
                    },
                    title: "Review userplugin",
                    modal: true,
                    parent: BrowserWindow.getAllWindows()[0],
                    show: false,
                    autoHideMenuBar: true
                });
                let decided = false;
                win.once("closed", () => {
                    if (!decided) reject(new Error("Review window closed."));
                    decided = true;
                });
                win.loadURL(generateReviewPluginContent(meta)).catch(() => {
                    if (decided) return;
                    decided = true;
                    reject(new Error("Could not load the plugin review."));
                    win.close();
                });
                win.on("page-title-updated", async e => {
                    if (decided) return;
                    switch (win.webContents.getTitle() as "abortInstall" | "reviewCode" | "install") {
                        case "abortInstall": {
                            decided = true;
                            win.close();
                            return reject("Rejected by user");
                        }
                        case "install": {
                            decided = true;
                            win.close();
                            try {
                                try {
                                    const destination = join(vencordPath, "..", "src", "userplugins", repo);
                                    const backup = `${stagingPath}.previous`;
                                    const replacing = existsSync(destination);
                                    if (replacing) {
                                        const confirmation = await dialog.showMessageBox({
                                            title: "Replace plugin",
                                            message: `Replace the installed copy of ${repo}?`,
                                            detail: "Local changes in the installed copy will be removed.",
                                            buttons: ["Cancel", "Replace"]
                                        });
                                        if (confirmation.response !== 1) return reject(new Error("Installation cancelled."));
                                        if (existsSync(backup)) throw new Error("Plugin backup already exists.");
                                        await rename(getPluginDirectory(repo), backup);
                                    }
                                    try {
                                        await rename(getPluginDirectory(stagingName), destination);
                                    } catch {
                                        if (replacing) await rename(backup, destination);
                                        throw new Error("Could not install the staged plugin.");
                                    }
                                    approved = true;
                                    if (replacing) await rm(getPluginDirectory(basename(backup)), { recursive: true });
                                } catch {
                                    throw new Error("Could not install the staged plugin.");
                                }
                                await build();
                            }
                            catch (e) {
                                return reject(e);
                            }
                            resolve({
                                name: meta.name,
                                native: meta.usesNative
                            });
                            break;
                        }
                    }
                });
                win.show();
            });
        } catch (error) {
            if (!approved) {
                try {
                    await rm(getPluginDirectory(stagingName), { recursive: true });
                } catch {
                    throw new Error("Could not remove the cancelled plugin installation.");
                }
            }
            throw error;
        }
    });
}

function build(): Promise<void> {
    return new Promise((resolve, reject) => {
        exec("pnpm build --dev", {
            cwd: join(vencordPath, ".."),
            shell: process.env.SHELL || process.env.ComSpec || "/bin/sh"
        }, error => {
            if (error) reject(new Error("Could not build LawyerCord. Try building from the terminal."));
            else resolve();
        });
    });
}

async function getPluginMeta(path: string, extra: object = {}): Promise<{
    name: string;
    description: string;
    usesPreSend: boolean;
    usesNative: boolean;
    directory?: string;
    remote: string;
    supportChannelID?: string;
}> {
    const files = readdirSync(path);
    let fileToRead: "index.ts" | "index.tsx" | "index.js" | "index.jsx" | undefined;
    files.forEach(f => {
        if (f === "index.ts") fileToRead = "index.ts";
        if (f === "index.tsx") fileToRead = "index.tsx";
        if (f === "index.js") fileToRead = "index.js";
        if (f === "index.jsx") fileToRead = "index.jsx";
    });
    if (!fileToRead) throw new Error("Plugin entry file is missing.");

    const file = readFileSync(`${path}/${fileToRead}`, "utf8");
    const remote = files.includes(".git")
        ? await new Promise<string>(resolve => {
            execFile("git", ["config", "--local", "--get", "remote.origin.url"], { cwd: path }, (error, stdout) => resolve(error ? "" : stdout.trim()));
        }).catch(() => "")
        : "";
    const remoteURL = remote.match(CLONE_LINK_REGEX);

    let supportChannelID;
    try {
        const meta = readFileSync(join(path, "meta.yml"), "utf8");
        const parsed = yaml.load(meta);
        if (parsed.thread && typeof parsed.thread === "string" && /^\d+$/.test(parsed.thread)) {
            supportChannelID = parsed.thread;
        }
    } catch {
        supportChannelID = null;
    }

    const syntax = createSourceFile(fileToRead, file, ScriptTarget.Latest, true);
    let name: string | undefined;
    let description: string | undefined;
    for (const statement of syntax.statements) {
        if (!isExportAssignment(statement) || !isCallExpression(statement.expression)) continue;
        const call = statement.expression;
        if (!isIdentifier(call.expression) || call.expression.text !== "definePlugin") continue;
        const object = call.arguments[0];
        if (!object || !isObjectLiteralExpression(object)) continue;
        for (const property of object.properties) {
            if (!property.name || (!isIdentifier(property.name) && !isStringLiteralLike(property.name))) {
                name = description = undefined;
                continue;
            }
            const value = isPropertyAssignment(property) && isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
            if (property.name.text === "name") name = value;
            if (property.name.text === "description") description = value;
        }
    }
    if (name === undefined || description === undefined) throw new Error("Plugin metadata is invalid.");
    return {
        name,
        description,
        usesPreSend: file.includes("PreSendListener") || file.includes("onBeforeMessage"),
        usesNative: files.includes("native.ts") || files.includes("native.js") || (files.includes("native") && existsSync(join(path, "native/index.ts"))),
        remote: remoteURL?.[0] === remote ? remote.replace(/(?:\.git)?\/?$/, "") : "",
        supportChannelID,
        ...extra
    };
}

async function cloneRepo(link: string, repo: string): Promise<void> {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        const proc = spawn("git", ["clone", "--", link, join(vencordPath, "..", "src", "userplugins", repo)], {
            cwd: join(vencordPath, "..", "src", "userplugins")
        });
        proc.once("error", () => reject(new Error("Could not start Git.")));
        proc.once("close", resolve);
    });
    if (exitCode !== 0) throw new Error("Failed to clone the plugin.");
}

function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function generateReviewPluginContent(meta: {
    name: string;
    description: string;
    usesPreSend: boolean;
    usesNative: boolean;
}): string {
    const template = pluginValidateContent.replace("%PLUGINNAME%", () => escapeHtml(meta.name)).replace("%PLUGINDESC%", () => escapeHtml(meta.description)).replace("%WARNINGHIDER%", !meta.usesNative && !meta.usesPreSend ? "[data-useless=\"warning\"] { display: none !important; }" : "").replace("%NATIVETSHIDER%", meta.usesNative ? "" : "#native-ts-warning { display: none !important; }").replace("%PRESENDHIDER%", meta.usesPreSend ? "" : "#pre-send-warning { display: none !important; }");
    const buf = Buffer.from(template).toString("base64");
    return `data:text/html;base64,${buf}`;
}

function generateUpdatePluginContent(meta: {
    name: string;
    description: string;
    remote: string;
    commit: string;
}): string {
    const template = updateValidateContent.replace("%PLUGINNAME%", () => escapeHtml(meta.name)).replace("%PLUGINDESC%", () => escapeHtml(meta.description)).replace("%REMOTE%", () => escapeHtml(meta.remote)).replace("%COMMITMESSAGE%", () => meta.commit.replaceAll("\n", "<br />"));
    const buf = Buffer.from(template).toString("base64");
    return `data:text/html;base64,${buf}`;
}

function formatCommitMessages(rawOutput: string, remote: string): string {
    const commitBaseUrl = remote.replace("plugins.nin0.dev", "git.nin0.dev/userplugins");
    let output = "";

    for (const line of rawOutput.split("\n")) {
        if (!line) continue;
        const [user, shortCommit, longCommit, ...message] = line.split("////////");
        if (output) output += "\n";
        output += `${escapeHtml(user)} (<a href="${escapeHtml(`${commitBaseUrl}/commit/${longCommit}`)}" style="font-family: monospace;">${escapeHtml(shortCommit)}</a>) ~ ${escapeHtml(message.join("////////"))}`;
    }

    return output;
}

export async function getUserplugins() {
    const folderContents = await readdir(join(vencordPath, "..", "src", "userplugins"), {
        withFileTypes: true
    });
    const plugins = await Promise.allSettled(
        folderContents
            .filter(item => item.isDirectory() && !item.name.startsWith(".") && !item.name.startsWith("_"))
            .map(item => getPluginMeta(join(item.parentPath, item.name), { directory: item.name }))
    );

    return plugins
        .filter(p => p.status === "fulfilled")
        .map(p => p.value);
}

export async function updatePlugin(_, directory: string) {
    return runPluginMutation(async () => {
        const pluginDir = getPluginDirectory(directory);
        const pluginMeta = await getPluginMeta(pluginDir)
            .catch(() => { throw new Error("Could not read the plugin metadata."); });
        const target = await new Promise<string>((resolve, reject) => {
            exec("git rev-parse origin/HEAD", { cwd: pluginDir }, (error, stdout) => {
                const commit = stdout.trim();
                if (error || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(commit)) reject(new Error("Could not resolve the plugin update."));
                else resolve(commit);
            });
        });
        const rawOutput = await new Promise<string>((resolve, reject) => {
            exec(`git log HEAD..${target} --oneline --pretty=format:%an////////%h////////%H////////%s`, {
                cwd: pluginDir
            }, (error, stdout) => {
                if (error) reject(new Error("Could not read the plugin update history."));
                else resolve(stdout);
            });
        });
        return new Promise<{ name: string; native: boolean; }>((resolve, reject) => {

            const win = new BrowserWindow({
                maximizable: false,
                minimizable: false,
                width: 560,
                height: 600,
                resizable: false,
                webPreferences: {
                    devTools: true
                },
                title: "Review userplugin",
                modal: true,
                parent: BrowserWindow.getAllWindows()[0],
                show: false,
                autoHideMenuBar: true
            });

            let decided = false;
            win.once("closed", () => {
                if (!decided) reject(new Error("Review window closed."));
                decided = true;
            });
            win.loadURL(generateUpdatePluginContent({
                name: pluginMeta.name,
                description: pluginMeta.description,
                remote: pluginMeta.remote,
                commit: formatCommitMessages(rawOutput, pluginMeta.remote)
            })).catch(() => {
                if (decided) return;
                decided = true;
                reject(new Error("Could not load the plugin review."));
                win.close();
            });
            win.on("page-title-updated", async e => {
                if (decided) return;
                const title = win.webContents.getTitle();
                if (title.startsWith("openLink:")) {
                    try {
                        const link = new URL(title.slice("openLink:".length));
                        const source = new URL(pluginMeta.remote);
                        const commitBase = `${pluginMeta.remote.replace("plugins.nin0.dev", "git.nin0.dev/userplugins")}/commit/`;
                        if (source.protocol !== "https:" || source.username || source.password
                            || (link.href !== source.href && (!link.href.startsWith(commitBase) || !/^[a-f\d]{40,64}$/.test(link.href.slice(commitBase.length)))))
                            throw new Error("Invalid update link.");
                        await shell.openExternal(link.href);
                    } catch {
                        if (!decided) {
                            decided = true;
                            reject(new Error("Could not open the update link."));
                            win.close();
                        }
                    }
                    return;
                }
                switch (title) {
                    case "abortInstall": {
                        decided = true;
                        win.close();
                        return reject("Rejected by user");
                    }
                    case "install": {
                        decided = true;
                        win.close();
                        try {
                            await new Promise<void>((resolve, reject) => exec(`git rebase ${target}`, {
                                cwd: pluginDir
                            }, error => {
                                if (error) reject(new Error("Could not apply the plugin update. Check for conflicting local changes."));
                                else resolve();
                            }));
                            await build();
                            const updatedMeta = await getPluginMeta(pluginDir);
                            resolve({
                                name: updatedMeta.name,
                                native: pluginMeta.usesNative || updatedMeta.usesNative
                            });
                        }
                        catch {
                            reject(new Error("Could not update the plugin. Check the repository and try building from the terminal."));
                        }
                        break;
                    }
                }
            });
            win.show();
        });
    });
}
