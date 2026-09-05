/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";

import { arrangeBlocks, edgePath, freeSpot, NODE_WIDTH, nodeHeight, overlaps, settle } from "../src/components/settings/tabs/automations/layout";
import { createAutomationBlock } from "../src/components/settings/tabs/automations/model";

const at = (blocks: ReturnType<typeof arrangeBlocks>, id: string) => {
    const block = blocks.find(item => item.id === id);
    assert.ok(block?.position, `${id} was placed`);
    return block.position;
};

// A straight chain lines up left to right on one row.
{
    const a = createAutomationBlock("send-message");
    const b = createAutomationBlock("delay");
    const c = createAutomationBlock("notify");
    a.next = b.id; b.next = c.id;
    const laid = arrangeBlocks([c, a, b]);
    assert.ok(at(laid, a.id).x < at(laid, b.id).x && at(laid, b.id).x < at(laid, c.id).x, "columns follow the edges");
    assert.equal(at(laid, a.id).y, at(laid, b.id).y);
    assert.equal(at(laid, b.id).y, at(laid, c.id).y);
    assert.ok(at(laid, b.id).x - at(laid, a.id).x >= NODE_WIDTH, "nodes do not overlap horizontally");
}

// Yes goes above, No below, and the error branch below that. The branch node sits between them.
{
    const check = createAutomationBlock("condition");
    const yes = createAutomationBlock("send-message");
    const no = createAutomationBlock("notify");
    const oops = createAutomationBlock("log");
    check.next = yes.id; check.alternate = no.id; check.error = oops.id;
    const laid = arrangeBlocks([oops, no, yes, check]);
    assert.ok(at(laid, yes.id).y < at(laid, no.id).y, "yes above no");
    assert.ok(at(laid, no.id).y < at(laid, oops.id).y, "no above error");
    assert.ok(at(laid, check.id).y >= at(laid, yes.id).y && at(laid, check.id).y <= at(laid, oops.id).y, "branch node between its branches");
    assert.equal(at(laid, yes.id).x, at(laid, no.id).x, "branches share a column");
    assert.ok(at(laid, check.id).x < at(laid, yes.id).x);
    for (const block of laid) assert.ok(!overlaps(laid.filter(other => other.id !== block.id), block.position?.x ?? 0, block.position?.y ?? 0, block.type), "nothing overlaps");
}

// A loop back to the repeat block is laid out as if the back edge were not there.
{
    const loop = createAutomationBlock("repeat");
    const body = createAutomationBlock("log");
    const after = createAutomationBlock("notify");
    loop.next = body.id; body.next = loop.id; loop.alternate = after.id;
    const laid = arrangeBlocks([loop, body, after]);
    assert.ok(at(laid, body.id).x > at(laid, loop.id).x, "loop body sits right of the loop");
    assert.ok(at(laid, body.id).y < at(laid, after.id).y, "each pass above when done");
    assert.ok(edgePath({ x: 400, y: 30 }, { x: 60, y: 30 }, 120).includes(" 120 "), "a backward edge loops underneath");
}

// Disconnected pieces land below everything that is connected, and every block still gets a spot.
{
    const a = createAutomationBlock("send-message");
    const b = createAutomationBlock("delay");
    const stray = createAutomationBlock("note");
    a.next = b.id;
    const laid = arrangeBlocks([a, b, stray]);
    assert.ok(at(laid, stray.id).y > at(laid, a.id).y + nodeHeight(a.type), "the stray block is below the chain");
    assert.equal(laid.length, 3);
}

// Snapping aligns with a neighbour when close, and free spots step down past occupied space.
{
    const a = createAutomationBlock("send-message");
    a.position = { x: 200, y: 100 };
    assert.deepEqual(settle([a], "other", 209, 93), { x: 200, y: 100 });
    assert.deepEqual(settle([a], "other", 333, 341), { x: 340, y: 340 });
    const spot = freeSpot([a], 200, 100, "notify");
    assert.ok(spot.y >= 100 + nodeHeight("send-message"), "a free spot never lands on an existing node");
    const crowded = Array.from({ length: 100 }, (_, i) => ({ ...createAutomationBlock("note"), position: { x: 0, y: i * 100 } })).reverse();
    for (const [x, y] of [[0, 0], [-400, 0], [0, -200]]) {
        const free = freeSpot(crowded, x, y, "notify");
        assert.ok(!overlaps(crowded, free.x, free.y, "notify"), "the final snapped position is free even in a crowded column");
    }
}

console.log("automation layout checks passed");
