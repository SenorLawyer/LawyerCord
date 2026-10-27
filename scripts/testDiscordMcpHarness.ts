/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const PLUGIN_DIRECTORY = "src/equicordplugins/discordMcp.desktop";

type Exports = Record<string, unknown>;

export function loadPluginModule(
    file: string,
    externals: Record<string, unknown>,
    injected: Record<string, unknown> = {},
    overrides: Record<string, Exports> = {},
    expose: string[] = []
): Exports {
    const cache = new Map<string, Exports>();

    const load = (name: string): Exports => {
        const override = overrides[name];
        if (override) return override;
        const cached = cache.get(name);
        if (cached) return cached;

        const source = readFileSync(`${PLUGIN_DIRECTORY}/${name}.ts`, "utf8");
        const code = transpileModule(name === file && expose.length ? `${source}
exports.__expose = { ${expose.join(", ")} };` : source, {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
        }).outputText;
        const module = { exports: {} as Exports };
        cache.set(name, module.exports);
        const names = Object.keys(injected);
        new Function("exports", "require", "module", ...names, code)(
            module.exports,
            (request: string) => {
                if (request.startsWith("./")) return load(request.slice(2));
                if (!(request in externals)) throw new Error(`Unmocked import: ${request}`);
                return externals[request];
            },
            module,
            ...names.map(key => injected[key])
        );
        return module.exports;
    };

    return load(file);
}
