/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import { app } from "electron";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "original-fs";
import { join, resolve } from "path";
import { setTimeout as sleep } from "timers/promises";

import { NativeSettings, RendererSettings } from "../settings";

const windowsWorkerSource = String.raw`
$ErrorActionPreference = 'Stop'
$directory = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$staged = Join-Path $directory 'archive.asar'
$request = Join-Path $directory 'restart.json'
$state = $manifest.destination + '.update.json'
$applied = $false
function Get-ArchiveDigest($file) {
    $stream = [IO.File]::OpenRead($file)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Record-Result($value) {
    $result = Join-Path $directory 'result.json'
    $temporary = $result + '.tmp'
    [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress))
    if ([IO.File]::Exists($result)) { [IO.File]::Replace($temporary, $result, $null) }
    else { [IO.File]::Move($temporary, $result) }
}
function Restart-Client {
    if (-not (Test-Path -LiteralPath $request)) { return }
    $restart = Get-Content -LiteralPath $request -Raw -Encoding UTF8 | ConvertFrom-Json
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $manifest.executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.Arguments = (@($restart.args | ForEach-Object {
        '"' + ([regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
    }) -join ' ')
    $started = [Diagnostics.Process]::Start($start)
    $started.Dispose()
}
try {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LawyerCordArchive { [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool MoveFileEx(string existing, string replacement, uint flags); }'
    if ((Get-ArchiveDigest $staged) -ne $manifest.digest) { throw 'The staged update failed its checksum check. Download the release again.' }
    $parent = $null
    try { $parent = [Diagnostics.Process]::GetProcessById($manifest.pid) } catch [ArgumentException] { $parent = $null }
    [IO.File]::WriteAllText((Join-Path $directory 'ready.tmp'), (@{ pid = $PID } | ConvertTo-Json -Compress))
    [IO.File]::Move((Join-Path $directory 'ready.tmp'), (Join-Path $directory 'ready.json'))
    if ($null -ne $parent) { $parent.WaitForExit(); $parent.Dispose() }
    if ((Get-ArchiveDigest $staged) -ne $manifest.digest) { throw 'The staged update changed before installation. Download the release again.' }
    if ((Get-ArchiveDigest $manifest.destination) -ne $manifest.previousDigest) { throw 'Another installer changed LawyerCord while this update was waiting. The newer installed archive was kept.' }
    [IO.File]::Copy($manifest.destination, (Join-Path $directory 'previous.asar'))
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ((Get-ArchiveDigest $manifest.destination) -ne $manifest.previousDigest) { throw 'Another installer changed LawyerCord while this update was waiting. The newer installed archive was kept.' }
        if ([LawyerCordArchive]::MoveFileEx($staged, $manifest.destination, 9)) { $applied = $true; break }
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -notin @(5, 32, 33)) { throw 'The update could not replace the archive. Check folder permissions and retry. The previous version was kept.' }
        Start-Sleep -Milliseconds 250
    }
    if (-not $applied) { throw 'Close all Discord clients, then reopen LawyerCord and retry the update. The previous version was kept.' }
    Record-Result @{ ok = $true }
    Restart-Client
    if (Test-Path -LiteralPath $state) {
        $pending = Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pending.directory -eq $directory) { Remove-Item -LiteralPath $state }
    }
} catch {
    $message = if ($applied) { 'The release was installed, but Discord could not restart. Open Discord normally.' } else { $_.Exception.Message }
    Record-Result @{ ok = $false; error = $message }
    if (-not $applied) { Restart-Client }
    exit 1
}
`;

interface StagedUpdate {
    directory: string;
    workerPid: number;
}

let stagedUpdate: StagedUpdate | undefined;
let appliedUpdate = false;

function stateFile(destination: string) {
    return `${destination}.update.json`;
}

export function getStagedUpdateError(destination: string): string | undefined {
    if (!existsSync(stateFile(destination))) return;
    const state: unknown = JSON.parse(readFileSync(stateFile(destination), "utf8"));
    if (typeof state !== "object" || state === null || !("directory" in state) || typeof state.directory !== "string"
        || !resolve(state.directory).startsWith(`${resolve(destination)}.update-`))
        throw new Error("The pending update record is invalid. Repair LawyerCord with the installer.");
    const result = join(state.directory, "result.json");
    if (!existsSync(result)) return;
    const outcome: unknown = JSON.parse(readFileSync(result, "utf8"));
    if (typeof outcome === "object" && outcome !== null && "ok" in outcome && outcome.ok === false
        && "error" in outcome && typeof outcome.error === "string") {
        rmSync(stateFile(destination));
        return outcome.error;
    }
}

export async function replaceVerifiedArchive(destination: string, data: Buffer): Promise<{ staged: boolean; }> {
    if (stagedUpdate || appliedUpdate) throw new Error("An update is already downloaded. Restart Discord before selecting another release.");
    const directory = mkdtempSync(`${destination}.update-`);
    let spawned = false;
    try {
        writeFileSync(join(directory, "archive.asar"), data, { flush: true, mode: 0o600 });
        writeFileSync(join(directory, "settings-backup.json"), JSON.stringify({ renderer: RendererSettings.plain, native: NativeSettings.plain }), { flush: true, mode: 0o600 });
        writeFileSync(join(directory, "manifest.json"), JSON.stringify({ destination: resolve(destination), digest: createHash("sha256").update(data).digest("hex"), previousDigest: createHash("sha256").update(readFileSync(destination)).digest("hex"), pid: process.pid, executable: process.execPath }), { flush: true, mode: 0o600 });
        if (process.platform !== "win32") {
            copyFileSync(destination, join(directory, "previous.asar"));
            renameSync(join(directory, "archive.asar"), destination);
            spawned = appliedUpdate = true;
            return { staged: false };
        }
        const worker = join(directory, "apply.ps1");
        writeFileSync(worker, windowsWorkerSource, { flush: true, mode: 0o600 });
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.NODE_OPTIONS;
        delete env.ELECTRON_RUN_AS_NODE;
        const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        env.LAWYERCORD_UPDATE_SCRIPT = worker;
        env.LAWYERCORD_UPDATE_RUNTIME = executable;
        const launcher = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:LAWYERCORD_UPDATE_RUNTIME -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ('\"' + $env:LAWYERCORD_UPDATE_SCRIPT + '\"')) -WindowStyle Hidden | Out-Null";
        const args = ["-NoProfile", "-NonInteractive", "-Command", launcher];
        const child = spawn(executable, args, { stdio: "ignore", windowsHide: true, env });
        let launchError = false;
        child.once("error", () => { launchError = true; });
        const readyFile = join(directory, "ready.json");
        for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt++) {
            if (launchError || child.exitCode !== null && child.exitCode !== 0) break;
            await sleep(50);
        }
        if (!existsSync(readyFile)) {
            child.kill();
            throw new Error("The update helper could not start. Repair LawyerCord with the installer.");
        }
        const ready: unknown = JSON.parse(readFileSync(readyFile, "utf8"));
        if (typeof ready !== "object" || ready === null || !("pid" in ready) || typeof ready.pid !== "number" || !Number.isSafeInteger(ready.pid) || ready.pid < 1)
            throw new Error("The update helper could not start.");
        const state = { directory, workerPid: ready.pid };
        try { writeFileSync(stateFile(destination), JSON.stringify(state), { flush: true, mode: 0o600 }); }
        catch (error) { process.kill(state.workerPid); throw error; }
        spawned = true;
        stagedUpdate = state;
        child.unref();
        return { staged: true };
    } finally {
        if (!spawned) rmSync(directory, { recursive: true, force: true });
    }
}

export async function restartStagedUpdate(): Promise<boolean> {
    if (appliedUpdate) {
        app.relaunch();
        setTimeout(() => app.quit(), 100);
        return true;
    }
    if (!stagedUpdate) return false;
    try { process.kill(stagedUpdate.workerPid, 0); }
    catch { throw new Error("The update helper stopped. Close Discord and use the installer to finish the update."); }
    writeFileSync(join(stagedUpdate.directory, "restart.json"), JSON.stringify({ args: process.argv.slice(1).filter(argument => argument !== "--squirrel-firstrun") }), { flush: true, mode: 0o600 });
    setTimeout(() => app.quit(), 100);
    return true;
}
