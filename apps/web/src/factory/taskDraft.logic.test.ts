import type { FactoryTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentDraft,
  draftAfterSave,
  draftConflict,
  draftFieldText,
  draftSave,
  editDraftField,
  editDraftNote,
  keepMine,
  takeTheirs,
} from "./taskDraft.logic";

const record = (rev: number, fields: Partial<FactoryTask> = {}): FactoryTask => ({
  v: 1,
  id: "task-1",
  number: 7,
  rev,
  projectId: null,
  title: "Ship it",
  description: "",
  lane: "backlog",
  laneSetAt: "2026-11-01T00:00:00.000Z",
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: null,
  source: { _tag: "local" },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: `2026-11-01T00:0${rev}:00.000Z`,
  ...fields,
});

describe("a task edit session", () => {
  it("keeps its base revision while it has unsaved changes", () => {
    const stored = editDraftField(currentDraft(undefined, record(1)), "title", "Mine");
    const draft = currentDraft(stored, record(2, { title: "Theirs" }));
    expect(draft.base.rev).toBe(1);
    expect(draftSave(draft)).toEqual({
      sent: { rev: 1, fields: { title: "Mine" } },
      patch: { title: "Mine" },
    });
  });

  it("offers both choices when the record changes elsewhere while it is dirty", () => {
    const theirs = record(2, { title: "Theirs", lane: "ready" });
    const draft = currentDraft(
      editDraftField(currentDraft(undefined, record(1)), "title", "Mine"),
      theirs,
    );
    expect(draftConflict(draft, theirs)).toEqual({ theirs, changed: ["title", "lane"] });

    const kept = keepMine(draft, theirs);
    expect(draftConflict(kept, theirs)).toBeNull();
    expect(draftFieldText(kept, "title")).toBe("Mine");
    expect(draftSave(kept).sent.rev).toBe(2);

    const taken = takeTheirs(draft, theirs);
    expect(draftConflict(taken, theirs)).toBeNull();
    expect(draftFieldText(taken, "title")).toBe("Theirs");
    expect(draftSave(taken).patch).toEqual({});
  });

  it("keeps text typed while a save is in flight", () => {
    const start = editDraftNote(
      editDraftField(currentDraft(undefined, record(1)), "title", "Renamed"),
      "first note",
    );
    const { sent } = draftSave(start);
    const typedMeanwhile = editDraftNote(
      editDraftField(start, "title", "Renamed again"),
      "first note, and more",
    );
    const after = draftAfterSave(
      typedMeanwhile,
      { ...sent, note: "first note" },
      record(2, { title: "Renamed" }),
    );
    expect(after.base.rev).toBe(2);
    expect(draftFieldText(after, "title")).toBe("Renamed again");
    expect(after.note).toBe("first note, and more");

    const untouched = draftAfterSave(
      start,
      { ...sent, note: "first note" },
      record(2, { title: "Renamed" }),
    );
    expect(untouched.fields).toEqual({});
    expect(untouched.note).toBe("");
  });

  it("follows the remote record while nothing is unsaved", () => {
    const stored = editDraftNote(currentDraft(undefined, record(1)), "half a note");
    const theirs = record(3, { title: "Theirs" });
    const draft = currentDraft(stored, theirs);
    expect(draft.base).toBe(theirs);
    expect(draft.note).toBe("half a note");
    expect(draftConflict(draft, theirs)).toBeNull();
    expect(draftFieldText(draft, "title")).toBe("Theirs");
  });
});
