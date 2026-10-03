/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

package main

import (
	"strings"
	"syscall"
	"testing"
)

func TestLockedArchivePreservesInstallAndExplainsRetry(t *testing.T) {
	directory := fixture(t)
	filename, err := syscall.UTF16PtrFromString(LawyerCordDirectory)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(filename, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		if !closed {
			syscall.CloseHandle(handle)
		}
	}()
	err = installLatestBuilds()
	assertArchive(t, "Old complete archive")
	assertNoTemporaryFiles(t, directory)
	if InstalledHash != "old" {
		t.Fatal("Locked install changed InstalledHash")
	}
	if err == nil || !strings.Contains(err.Error(), "Close all Discord windows") || !strings.Contains(err.Error(), "try again") {
		t.Fatalf("Locked archive needs actionable retry instructions, got %v", err)
	}
	if err := syscall.CloseHandle(handle); err != nil {
		t.Fatal(err)
	}
	closed = true
	if err := installLatestBuilds(); err != nil {
		t.Fatalf("Retry after closing archive failed: %v", err)
	}
	assertArchive(t, "New complete archive")
	assertNoTemporaryFiles(t, directory)
	if InstalledHash != "new" {
		t.Fatal("Successful retry did not record installed hash")
	}
}

func TestPatchClosesDiscordBeforeReplacingArchive(t *testing.T) {
	directory := fixture(t)
	filename, err := syscall.UTF16PtrFromString(LawyerCordDirectory)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(filename, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer func() {
		PreparePatch = func(*DiscordInstall) {}
		if !closed {
			syscall.CloseHandle(handle)
		}
	}()
	PreparePatch = func(*DiscordInstall) {
		assertArchive(t, "Old complete archive")
		if err := syscall.CloseHandle(handle); err != nil {
			t.Fatal(err)
		}
		closed = true
	}
	install := DiscordInstall{path: directory}
	if err := install.patch(); err != nil {
		t.Fatalf("Patch tried replacing the archive before closing Discord: %v", err)
	}
	if !closed {
		t.Fatal("Patch did not prepare Discord")
	}
	assertArchive(t, "New complete archive")
	assertNoTemporaryFiles(t, directory)
}
