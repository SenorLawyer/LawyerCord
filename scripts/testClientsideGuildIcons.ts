import assert from "node:assert/strict";

import {
    normalizeStoredGuildIcon,
    normalizeStoredGuildIcons,
} from "../src/equicordplugins/clientsideGuildIcons/iconStorage";

async function main(): Promise<void> {
    const pngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const migratedIcon = await normalizeStoredGuildIcon(pngDataUrl);

    assert(migratedIcon instanceof Blob, "legacy image data URLs migrate to Blob storage");
    assert.equal(migratedIcon.type, "image/png", "the image MIME type is preserved");
    assert(migratedIcon.size < pngDataUrl.length, "binary storage is smaller than base64 storage");

    const storedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    assert.equal(await normalizeStoredGuildIcon(storedBlob), storedBlob, "existing Blob storage is reused");
    assert.equal(await normalizeStoredGuildIcon("https://example.com/icon.png"), null, "remote URLs are not accepted as local icon data");

    const migrated = await normalizeStoredGuildIcons({ malformed: "data:image/png;base64,%%%", guild: pngDataUrl, invalid: "not-an-image" });
    assert.equal(Object.keys(migrated).length, 1, "invalid stored icons are removed from the runtime map");

    const canonical = await normalizeStoredGuildIcons({ guild: storedBlob });
    assert.deepEqual(canonical, { guild: storedBlob }, "canonical Blob records are preserved");

    console.log("clientsideGuildIcons storage checks passed");
}

void main();
