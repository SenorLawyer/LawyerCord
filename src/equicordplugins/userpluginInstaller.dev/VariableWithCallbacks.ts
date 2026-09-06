/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 nin0
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export class VariableWithCallbacks<T> {
    #value: T;
    #nextId = 0;
    #callbacks = new Map<number, (value: T, id: number) => void>();

    constructor(value: T) {
        this.#value = value;
    }

    value(newValue?: T): T {
        if (newValue !== undefined) {
            this.#value = newValue;
            this.#callbacks.forEach((callback, id) => callback(this.#value, id));
        }
        return this.#value;
    }

    registerCallback(callback: (value: T, id: number) => void): number {
        const id = this.#nextId++;
        this.#callbacks.set(id, callback);
        return id;
    }

    deregisterCallback(id: number) {
        this.#callbacks.delete(id);
    }
}
