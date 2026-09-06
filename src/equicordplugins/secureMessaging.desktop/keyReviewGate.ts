/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function scopeKey(localUserId: string, peerUserId: string): string {
    return `${localUserId}\0${peerUserId}`;
}

export class KeyReviewGate {
    private readonly failures = new Map<string, Set<string>>();
    private readonly pending = new Map<string, number>();

    begin(localUserId: string, peerUserId: string): void {
        const scope = scopeKey(localUserId, peerUserId);
        this.pending.set(scope, (this.pending.get(scope) ?? 0) + 1);
    }

    finish(localUserId: string, peerUserId: string): void {
        const scope = scopeKey(localUserId, peerUserId);
        const remaining = (this.pending.get(scope) ?? 0) - 1;
        if (remaining > 0) this.pending.set(scope, remaining);
        else this.pending.delete(scope);
    }

    fail(localUserId: string, peerUserId: string, attemptId: string): void {
        const scope = scopeKey(localUserId, peerUserId);
        const attempts = this.failures.get(scope) ?? new Set<string>();
        attempts.add(attemptId);
        this.failures.set(scope, attempts);
    }

    succeed(localUserId: string, peerUserId: string, attemptId: string): void {
        const scope = scopeKey(localUserId, peerUserId);
        const attempts = this.failures.get(scope);
        if (!attempts) return;
        attempts.delete(attemptId);
        if (attempts.size === 0) this.failures.delete(scope);
    }

    isBlocked(localUserId: string, peerUserId: string): boolean {
        const scope = scopeKey(localUserId, peerUserId);
        return this.pending.has(scope) || this.failures.has(scope);
    }
}
