/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { settings } from "../index";

export class LimitedMap<K, V> extends Map<K, V> {
    set(key: K, value: V) {
        const { cacheLimit } = settings.store;
        super.delete(key);
        super.set(key, value);
        if (cacheLimit > 0) {
            while (this.size > cacheLimit) {
                const oldest = this.keys().next();
                if (oldest.done) break;
                super.delete(oldest.value);
            }
        }
        return this;
    }
}
