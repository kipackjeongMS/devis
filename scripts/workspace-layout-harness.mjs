import assert from "node:assert/strict";

// The Workspace's layout (web/src/workspaceLayout.ts) in both places what needs you can show:
// its own Needs you panel (the default) or Devis's chat (Settings > Workspace).
const L = await import("../web/workspaceLayout.js");

const ids = (layout) => layout.columns.map((c) => c.panels.map((p) => p.id));

// ---- the panel, the default ----
{
    L.setNeedsPanel(true);
    assert.equal(L.hasNeedsPanel(), true);
    assert.deepEqual([...L.sections()], ["needs", "tasks", "prs", "comms", "meetings", "s360", "todos", "note"]);
    assert.equal(L.isSection("needs"), true);
    assert.deepEqual(ids(L.defaultLayout()), [["needs", "todos", "note"], ["devis"], ["tasks", "prs", "meetings", "comms", "s360"]]);
    assert.equal(L.isDefault(L.defaultLayout()), true);
    assert.equal(L.PANEL_NAME.needs, "Needs you");
    assert.equal(L.PANEL_NAME.s360, "S360");
}

// ---- Devis's chat ----
{
    L.setNeedsPanel(false);
    assert.equal(L.hasNeedsPanel(), false);
    assert.deepEqual([...L.sections()], ["tasks", "prs", "comms", "meetings", "s360", "todos", "note"]);
    assert.equal(L.isSection("needs"), false, "no Needs you panel to place");
    assert.equal(L.isPanelId("needs"), false);
    assert.deepEqual(L.ALL_SECTIONS.includes("needs"), true, "it's still one there can be");
    assert.deepEqual(ids(L.defaultLayout()), [["todos", "note"], ["devis"], ["tasks", "prs", "meetings", "comms", "s360"]]);
    assert.equal(L.isDefault(L.defaultLayout()), true);

    // A layout saved with the panel drops it, and its column when that was all it held.
    const withNeeds = {
        columns: [
            { w: 0.2, panels: [{ id: "needs" }] },
            { w: 0.5, panels: [{ id: "devis" }] },
            { w: 0.3, panels: [{ id: "todos" }, { id: "note" }, { id: "tasks" }, { id: "prs" }, { id: "meetings" }, { id: "comms" }] },
        ],
        flat: ["needs", "tasks", "prs", "comms", "meetings", "todos", "note"],
    };
    const read = L.normalize(withNeeds);
    assert.deepEqual(ids(read), [["devis"], ["todos", "note", "tasks", "prs", "meetings", "s360", "comms"]]);
    assert.ok(Math.abs(read.columns[0].w + read.columns[1].w - 1) < 1e-9, "the widths still add up");
    assert.deepEqual(read.flat, ["tasks", "prs", "comms", "meetings", "s360", "todos", "note"]);
}

// ---- back to the panel ----
{
    L.setNeedsPanel(true);
    // Saved while in the chat: Needs you goes back over To-dos, wherever To-dos is.
    const saved = {
        columns: [
            { w: 0.6, panels: [{ id: "devis" }] },
            { w: 0.4, panels: [{ id: "tasks" }, { id: "todos", g: 2 }, { id: "note" }, { id: "prs" }, { id: "meetings" }, { id: "comms" }] },
        ],
    };
    assert.deepEqual(ids(L.normalize(saved)), [["devis"], ["tasks", "needs", "todos", "note", "prs", "meetings", "s360", "comms"]]);
    assert.equal(L.normalize(saved).columns[1].panels.find((p) => p.id === "todos").g, 2, "To-dos keeps its height share");

    // No To-dos placed (an old layout with nothing but Devis): it goes with the rest, in a column of its own.
    const bare = L.normalize({ columns: [{ w: null, panels: [{ id: "devis" }] }] });
    assert.deepEqual(ids(bare), [["devis"], ["needs", "tasks", "prs", "comms", "meetings", "s360", "todos", "note"]]);

    // The flat list: Needs you comes back first.
    const flat = L.normalize({ columns: saved.columns, flat: ["todos", "tasks", "note", "prs", "comms", "meetings"] });
    assert.deepEqual(flat.flat, ["needs", "todos", "tasks", "note", "prs", "comms", "meetings", "s360"]);

    // A layout that has it keeps it where it was.
    const kept = L.normalize({
        columns: [
            { w: 0.5, panels: [{ id: "devis" }, { id: "needs", g: 0.5 }] },
            { w: 0.5, panels: [{ id: "tasks" }, { id: "prs" }, { id: "comms" }, { id: "meetings" }, { id: "todos" }, { id: "note" }] },
        ],
    });
    assert.deepEqual(ids(kept), [["devis", "needs"], ["tasks", "prs", "comms", "meetings", "s360", "todos", "note"]]);
    assert.equal(kept.columns[0].panels[1].g, 0.5);
}

// ---- S360, new since a layout was saved ----
{
    L.setNeedsPanel(true);
    // It goes in under Meetings, wherever Meetings is, and the rest keep their places and sizes.
    const before = {
        columns: [
            { w: 0.3, panels: [{ id: "needs" }, { id: "meetings", g: 1.5 }, { id: "todos" }, { id: "note" }] },
            { w: 0.4, panels: [{ id: "devis" }] },
            { w: 0.3, panels: [{ id: "tasks" }, { id: "prs" }, { id: "comms" }] },
        ],
        flat: ["needs", "tasks", "prs", "comms", "meetings", "todos", "note"],
    };
    const read = L.normalize(before);
    assert.deepEqual(ids(read), [["needs", "meetings", "s360", "todos", "note"], ["devis"], ["tasks", "prs", "comms"]]);
    assert.equal(read.columns[0].panels[1].g, 1.5, "Meetings keeps its height share");
    assert.equal(read.columns[0].panels[2].g, undefined, "S360 takes the default share");
    assert.deepEqual(read.columns.map((c) => c.w), [0.3, 0.4, 0.3]);
    assert.deepEqual(read.flat, ["needs", "tasks", "prs", "comms", "meetings", "s360", "todos", "note"]);
    // The old default (without S360) isn't the default anymore: S360 lands under Meetings there.
    const oldDefault = {
        columns: [
            { w: 0.25, panels: [{ id: "needs", g: 1 }, { id: "todos", g: 1 }, { id: "note", g: 1 }] },
            { w: 0.54, panels: [{ id: "devis" }] },
            { w: 0.21, panels: [{ id: "tasks", g: 1.1 }, { id: "prs", g: 0.9 }, { id: "meetings", g: 1 }, { id: "comms", g: 1 }] },
        ],
    };
    assert.deepEqual(ids(L.normalize(oldDefault))[2], ["tasks", "prs", "meetings", "s360", "comms"]);
}

console.log("workspace-layout harness: ok");
