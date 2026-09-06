/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { copyWithToast } from "@utils/discord";
import { React } from "@webpack/common";

import { TextField } from "./fields";
import type { OutputField } from "./outputs";

interface Props {
    fields: OutputField[];
    prefix: string;
}

export function OutputFields({ fields, prefix }: Props) {
    const [search, setSearch] = React.useState("");
    const query = search.trim().toLowerCase();
    const matches = fields.filter(field => `${field.path} ${field.type} ${field.description}`.toLowerCase().includes(query));
    if (!fields.length) return null;
    return <div className="vc-ab-output-fields">
        <TextField label={`Find a field (${fields.length})`} value={search} placeholder="Name, status, activity…" onChange={setSearch} />
        {matches.map(field => <div className="vc-ab-output-field" key={field.path}>
            <Button size="small" variant="secondary" onClick={() => copyWithToast(`{{${prefix}.${field.path}}}`, "Copied field reference.")}>{field.path}</Button>
            <span className="vc-ab-field-description"><strong>{field.type}</strong><br />{field.description}</span>
        </div>)}
        {!matches.length && <span className="vc-ab-field-description">No fields match this search.</span>}
    </div>;
}
