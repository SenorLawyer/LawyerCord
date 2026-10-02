/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from "typescript";

test("collapsed song previews discard results after their profile is replaced or closed", async () => {
    const effects: Array<() => (() => void) | undefined> = [];
    const pending: Array<(value: { label: string; }) => void> = [];
    let updates = 0;
    const common = {
        useState: (value: unknown) => [value, () => { updates++; }],
        useMemo: (factory: () => unknown) => factory(),
        useEffect: (effect: () => (() => void) | undefined) => effects.push(effect)
    };
    const modules: Record<string, unknown> = {
        "@webpack/common": common,
        "@song-spotlight/api/util": { sid: (song: { id: string; }) => song.id },
        "@equicordplugins/songSpotlight.desktop/service": { Native: { renderSong: () => new Promise(resolve => pending.push(resolve)) } },
        "@equicordplugins/songSpotlight.desktop/ui/common": { ContainerClasses: {}, ProfileCardClasses: {}, OverlayClasses: {} },
        "@utils/index": { classes: () => "" }
    };
    const source = readFileSync(process.env.AUDIT_SONG_PREVIEW_SOURCE ?? "src/equicordplugins/songSpotlight.desktop/ui/songs/CollapsedProfileSongs.tsx", "utf8");
    const { outputText } = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS, jsx: JsxEmit.React } });
    const component = runInNewContext(`${outputText};exports.default`, {
        exports: {}, require: (name: string) => modules[name] ?? {},
        React: { createElement: () => null }
    });
    component({ data: [{ id: "old" }], user: { id: "old-profile" }, isSideBar: false });
    const cleanup = effects[0]();
    cleanup?.();
    const before = updates;
    pending[0]({ label: "Old result" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(updates, before, "a closed or replaced profile must not publish its old song preview");
    component({ data: [{ id: "new" }], user: { id: "new-profile" }, isSideBar: false });
    effects[1]();
    const active = updates;
    pending[1]({ label: "Current result" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(updates, active + 1);
});
