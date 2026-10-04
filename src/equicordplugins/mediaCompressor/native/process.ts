/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import { constants, setPriority } from "os";

export function run(executable: string, args: string[], cwd: string, signal: AbortSignal, timeout = 30_000, log: (message: string) => void = () => {}) {
    signal.throwIfAborted();
    return new Promise<{ code: number; output: string; }>(resolve => {
        const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const abort = () => child.kill("SIGKILL");
        const timer = setTimeout(abort, timeout);
        signal.addEventListener("abort", abort, { once: true });
        let output = "";
        const read = (data: Buffer) => { const text = data.toString(); output = (output + text).slice(-65_536); log(text); };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.on("spawn", () => {
            if (child.pid) {
                try { setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); }
                catch { log("The encoder is running at normal process priority."); }
            }
        });
        child.once("error", () => finish(-1));
        child.once("close", code => finish(code ?? -1));
        function finish(code: number) {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            resolve({ code, output });
        }
    });
}
