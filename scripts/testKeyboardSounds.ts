/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

function fixture() {
    const source = readFileSync(process.env.AUDIT_KEYBOARD_SOURCE ?? "src/equicordplugins/keyboardSounds/index.ts", "utf8");
    const { outputText } = transpileModule(source.slice(source.indexOf("type SoundEntry")), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
    });
    const players: { volume: number; deleted: boolean; restarts: number; }[] = [];
    const listeners = new Map<string, (event: { code: string; key: string; }) => void>();
    const exports: { default?: { start(): void; stop(): void; }; } = {};
    const store = { volume: 100, soundPack: "operagx" };
    let options: Record<string, { onChange(value: string | number): void; }> = {};
    const events = { addEventListener: (name: string, cb: (event: { code: string; key: string; }) => void) => listeners.set(name, cb), removeEventListener: (name: string) => listeners.delete(name) };
    runInNewContext(outputText, {
        exports, definePlugin: (p: unknown) => p,
        definePluginSettings: (def: typeof options) => { options = def; return { store }; },
        OptionType: {}, Devs: {}, EquicordDevs: {}, packs: { operagx: { others: ["a", "b", "c"], backspaces: ["d"] }, osu: { others: ["e"] } }, ignoredKeys: ["CapsLock"],
        document: events, window: events,
        createAudioPlayer: (_url: string, { volume }: { volume: number; }) => {
            const player = { volume, deleted: false, restarts: 0, delete() { this.deleted = true; }, restart() { this.restarts++; } };
            players.push(player); return player;
        }
    });
    const plugin = exports.default; assert.ok(plugin);
    return { plugin, players, listeners,
        volume(value: number) { store.volume = value; options.volume.onChange(value); },
        pack(value: string) { store.soundPack = value; options.soundPack.onChange(value); }
    };
}

test("keyboard volume edits reuse audio players and preserve typing playback", () => {
    const f = fixture(); f.plugin.start();
    assert.equal(f.players.length, 12);
    for (let volume = 0; volume <= 100; volume++) f.volume(volume);
    assert.equal(f.players.length, 12);
    assert.ok(f.players.every(player => !player.deleted && player.volume === 100));
    f.listeners.get("keydown")?.({ code: "KeyA", key: "a" });
    assert.equal(f.players.reduce((n, player) => n + player.restarts, 0), 1);
    f.pack("osu");
    assert.ok(f.players.slice(0, 12).every(player => player.deleted));
    assert.equal(f.players.length, 15);
    f.plugin.stop(); assert.equal(f.listeners.size, 0);
    assert.ok(f.players.every(player => player.deleted));
});

test("keyboard setting changes cannot create audio after stop", () => {
    const f = fixture(); f.plugin.start(); f.plugin.stop();
    const count = f.players.length; f.volume(25); f.pack("osu");
    assert.equal(f.players.length, count);
    f.plugin.start();
    assert.equal(f.players.length, count + 3);
    assert.ok(f.players.slice(count).every(player => player.volume === 25 && !player.deleted));
    f.plugin.stop();
});
