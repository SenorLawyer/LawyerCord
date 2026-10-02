/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./prepareInstallerSource.mjs", import.meta.url), "utf8");

assert.match(source, /errors\.Is\(err, os\.ErrNotExist\)/);
assert.match(source, /os\.Rename\(_appAsar, appAsar\)/);

const start = source.indexOf("const downloaderSource = ");
const end = source.indexOf("const selfUpdaterSource = ", start);
assert.ok(start >= 0 && end > start);
const downloader = runInNewContext(`${source.slice(start, end)}\ndownloaderSource;`, { clientSha: "a".repeat(40) });
const directory = await mkdtemp(join(tmpdir(), "lawyercord-installer-proof-"));
try {
    await writeFile(join(directory, "github_downloader.go"), downloader.replace("os.CreateTemp(", "faultableCreateTemp("));
    await writeFile(join(directory, "lawyercord-desktop.asar"), "New complete archive");
    await writeFile(join(directory, "persistence_test.go"), String.raw`/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

package main

import (
    "errors"
    "os"
    "path/filepath"
    "runtime"
    "testing"
)

var LawyerCordDirectory string
var FixOwnership = func(string) error { return nil }
var injectedFailure string
var diskFailure = errors.New("Injected disk failure")

type faultFile struct { *os.File }

func faultableCreateTemp(directory, pattern string) (*faultFile, error) {
    if injectedFailure == "create" { return nil, diskFailure }
    file, err := os.CreateTemp(directory, pattern)
    if err != nil { return nil, err }
    return &faultFile{file}, nil
}

func (file *faultFile) Write(bytes []byte) (int, error) {
    if injectedFailure == "write" {
        written, err := file.File.Write(bytes[:3])
        if err != nil { return written, err }
        return written, diskFailure
    }
    return file.File.Write(bytes)
}

func (file *faultFile) Chmod(mode os.FileMode) error {
    if injectedFailure == "chmod" { return diskFailure }
    return file.File.Chmod(mode)
}

func (file *faultFile) Sync() error {
    if injectedFailure == "sync" { return diskFailure }
    return file.File.Sync()
}

func (file *faultFile) Close() error {
    err := file.File.Close()
    if injectedFailure == "close" { return diskFailure }
    return err
}

func fixture(t *testing.T) string {
    t.Helper()
    directory := t.TempDir()
    LawyerCordDirectory = filepath.Join(directory, "lawyercord.asar")
    InstalledHash = "old"
    LatestHash = "new"
    IsDevInstall = false
    injectedFailure = ""
    FixOwnership = func(string) error { return nil }
    if err := os.WriteFile(LawyerCordDirectory, []byte("Old complete archive"), 0o644); err != nil {
        t.Fatal(err)
    }
    return directory
}

func assertArchive(t *testing.T, text string) {
    t.Helper()
    bytes, err := os.ReadFile(LawyerCordDirectory)
    if err != nil || string(bytes) != text {
        t.Fatalf("Installed archive = %q, error = %v, want %q", bytes, err, text)
    }
}

func assertNoTemporaryFiles(t *testing.T, directory string) {
    t.Helper()
    entries, err := os.ReadDir(directory)
    if err != nil || len(entries) != 1 || entries[0].Name() != "lawyercord.asar" {
        t.Fatalf("Unexpected directory contents: %v, error: %v", entries, err)
    }
}

func TestOwnershipFailurePreservesInstalledArchive(t *testing.T) {
    directory := fixture(t)
    failure := errors.New("Ownership failed")
    FixOwnership = func(string) error { return failure }
    if err := installLatestBuilds(); !errors.Is(err, failure) { t.Fatalf("Error = %v", err) }
    assertArchive(t, "Old complete archive")
    if InstalledHash != "old" { t.Fatal("Failed install changed InstalledHash") }
    assertNoTemporaryFiles(t, directory)
}

func TestSuccessfulReplacementPreparesBeforePublishing(t *testing.T) {
    directory := fixture(t)
    calls := 0
    FixOwnership = func(path string) error {
        calls++
        assertArchive(t, "Old complete archive")
        if path == LawyerCordDirectory || filepath.Dir(path) != directory {
            t.Fatalf("Ownership was applied to %q", path)
        }
        bytes, err := os.ReadFile(path)
        if err != nil || string(bytes) != "New complete archive" { t.Fatalf("Prepared bytes = %q, error = %v", bytes, err) }
        return nil
    }
    if err := installLatestBuilds(); err != nil { t.Fatal(err) }
    assertArchive(t, "New complete archive")
    if calls != 1 || InstalledHash != "new" { t.Fatalf("Ownership calls = %d, hash = %q", calls, InstalledHash) }
    if runtime.GOOS != "windows" {
        info, err := os.Stat(LawyerCordDirectory)
        if err != nil || info.Mode().Perm() != 0o644 { t.Fatalf("Archive mode = %v, error = %v", info, err) }
    }
    assertNoTemporaryFiles(t, directory)
}

func TestRenameFailurePreservesExistingDestination(t *testing.T) {
    directory := fixture(t)
    if err := os.Remove(LawyerCordDirectory); err != nil { t.Fatal(err) }
    if err := os.Mkdir(LawyerCordDirectory, 0o755); err != nil { t.Fatal(err) }
    marker := filepath.Join(LawyerCordDirectory, "existing.txt")
    if err := os.WriteFile(marker, []byte("Keep me"), 0o644); err != nil { t.Fatal(err) }
    if err := installLatestBuilds(); err == nil { t.Fatal("Install unexpectedly replaced a nonempty directory") }
    bytes, err := os.ReadFile(marker)
    if err != nil || string(bytes) != "Keep me" { t.Fatalf("Destination changed: %q, %v", bytes, err) }
    if InstalledHash != "old" { t.Fatal("Failed replacement changed InstalledHash") }
    assertNoTemporaryFiles(t, directory)
}

func TestMissingParentDoesNotAcknowledgeInstallation(t *testing.T) {
    directory := fixture(t)
    LawyerCordDirectory = filepath.Join(directory, "missing", "lawyercord.asar")
    if err := installLatestBuilds(); err == nil { t.Fatal("Install unexpectedly succeeded") }
    if InstalledHash != "old" { t.Fatal("Failed preparation changed InstalledHash") }
    if _, err := os.Stat(filepath.Dir(LawyerCordDirectory)); !errors.Is(err, os.ErrNotExist) { t.Fatalf("Unexpected parent state: %v", err) }
    assertNoTemporaryFiles(t, directory)
}

func TestDevelopmentInstallPreservesArchive(t *testing.T) {
    directory := fixture(t)
    IsDevInstall = true
    FixOwnership = func(string) error { t.Fatal("Development install modified ownership"); return nil }
    if err := installLatestBuilds(); err != nil { t.Fatal(err) }
    assertArchive(t, "Old complete archive")
    if InstalledHash != "old" { t.Fatal("Development install changed InstalledHash") }
    assertNoTemporaryFiles(t, directory)
}

func TestDiskFailuresPreserveInstalledArchiveAndCleanTemporaryFiles(t *testing.T) {
    for _, stage := range []string{"create", "write", "chmod", "sync", "close"} {
        t.Run(stage, func(t *testing.T) {
            directory := fixture(t)
            injectedFailure = stage
            if err := installLatestBuilds(); !errors.Is(err, diskFailure) { t.Fatalf("Error = %v", err) }
            assertArchive(t, "Old complete archive")
            if InstalledHash != "old" { t.Fatal("Failed preparation changed InstalledHash") }
            assertNoTemporaryFiles(t, directory)
        })
    }
}
`);
    const result = spawnSync(process.env.LAWYERCORD_GO_BINARY ?? "go", ["test", "-count=1", "-v", "."], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GO111MODULE: "off", GOTOOLCHAIN: "local" },
        timeout: 120_000,
        windowsHide: true
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.error, undefined, "Go must be available to execute the installer persistence proof");
    assert.equal(result.status, 0, "Generated installer persistence checks failed");
} finally {
    await rm(directory, { recursive: true, force: true });
}

console.log("Installer stale-marker structure and generated persistence checks passed");
