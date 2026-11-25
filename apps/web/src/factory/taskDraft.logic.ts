import type { FactoryTask, FactoryTaskPatch } from "@t3tools/contracts";

/** The task fields a person edits as text. */
export type TaskDraftField = "title" | "description" | "assignee";

export type TaskDraftFields = Readonly<Partial<Record<TaskDraftField, string>>>;

/** One edit session on a task: the record it started from, and what was typed since. */
export interface TaskDraft {
  /** Every save sends this record's `rev`. */
  readonly base: FactoryTask;
  /** Typed values, kept as typed; a value equal to the base's text is not kept. */
  readonly fields: TaskDraftFields;
  /** A note not yet added. It does not hold the base back. */
  readonly note: string;
}

/** What a save sent, so its answer clears only what still holds it. */
export interface TaskDraftSent {
  readonly rev: number;
  readonly fields: TaskDraftFields;
  readonly note?: string;
}

/** A part of the record another writer can change. */
export type TaskChange =
  | "title"
  | "description"
  | "assignee"
  | "lane"
  | "parent"
  | "blockers"
  | "model"
  | "project";

export interface TaskDraftConflict {
  readonly theirs: FactoryTask;
  readonly changed: ReadonlyArray<TaskChange>;
}

const FIELDS: ReadonlyArray<TaskDraftField> = ["title", "description", "assignee"];

/** What a field shows for a record. */
function taskFieldText(task: FactoryTask, field: TaskDraftField): string {
  return field === "assignee" ? (task.assignee ?? "") : task[field];
}

/** Titles and assignees save trimmed, and a blank assignee is nobody. */
function savedValue(field: TaskDraftField, value: string): string | null {
  if (field === "description") return value;
  const trimmed = value.trim();
  return field === "assignee" && trimmed === "" ? null : trimmed;
}

function changes(task: FactoryTask, field: TaskDraftField, value: string): boolean {
  return savedValue(field, value) !== (field === "assignee" ? task.assignee : task[field]);
}

function withFields(
  fields: TaskDraftFields,
  base: FactoryTask,
  keep: (field: TaskDraftField, value: string) => boolean,
): TaskDraftFields {
  const next: Partial<Record<TaskDraftField, string>> = {};
  for (const field of FIELDS) {
    const value = fields[field];
    if (value !== undefined && value !== taskFieldText(base, field) && keep(field, value)) {
      next[field] = value;
    }
  }
  return next;
}

/** Whether a save of the typed fields would change the base. */
export function isDraftDirty(draft: TaskDraft): boolean {
  return FIELDS.some((field) => {
    const value = draft.fields[field];
    return value !== undefined && changes(draft.base, field, value);
  });
}

/**
 * The session as it stands against the newest record known. With nothing unsaved it moves to
 * that record; with unsaved changes it keeps its base until the person chooses.
 */
export function currentDraft(stored: TaskDraft | undefined, latest: FactoryTask): TaskDraft {
  if (stored === undefined) return { base: latest, fields: {}, note: "" };
  if (latest.rev <= stored.base.rev || isDraftDirty(stored)) return stored;
  return { base: latest, fields: {}, note: stored.note };
}

export function draftFieldText(draft: TaskDraft, field: TaskDraftField): string {
  return draft.fields[field] ?? taskFieldText(draft.base, field);
}

export function editDraftField(draft: TaskDraft, field: TaskDraftField, value: string): TaskDraft {
  return {
    ...draft,
    fields: withFields({ ...draft.fields, [field]: value }, draft.base, () => true),
  };
}

export function editDraftNote(draft: TaskDraft, note: string): TaskDraft {
  return { ...draft, note };
}

/** A save of the typed fields: the base's `rev` and only the fields that change it. */
export function draftSave(draft: TaskDraft): {
  readonly sent: TaskDraftSent;
  readonly patch: FactoryTaskPatch;
} {
  const fields = withFields(draft.fields, draft.base, (field, value) =>
    changes(draft.base, field, value),
  );
  const title = fields.title === undefined ? undefined : savedValue("title", fields.title);
  const assignee =
    fields.assignee === undefined ? undefined : savedValue("assignee", fields.assignee);
  return {
    sent: { rev: draft.base.rev, fields },
    patch: {
      ...(title === undefined || title === null ? {} : { title }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(assignee === undefined ? {} : { assignee }),
    },
  };
}

/**
 * The session once a save sent from it returned `saved`. The base becomes `saved`; a field, and
 * the note, is cleared only while it still holds what was sent, so text typed meanwhile stays.
 * A session with unsaved changes on another base is left for the person to reconcile.
 */
export function draftAfterSave(
  draft: TaskDraft | undefined,
  sent: TaskDraftSent,
  saved: FactoryTask,
): TaskDraft {
  if (draft === undefined) return { base: saved, fields: {}, note: "" };
  if (saved.rev <= draft.base.rev) return draft;
  const note = sent.note !== undefined && draft.note === sent.note ? "" : draft.note;
  if (draft.base.rev !== sent.rev) {
    return isDraftDirty(draft) ? { ...draft, note } : { base: saved, fields: {}, note };
  }
  return {
    base: saved,
    fields: withFields(draft.fields, saved, (field, value) => value !== sent.fields[field]),
    note,
  };
}

const sameModel = (left: FactoryTask["model"], right: FactoryTask["model"]) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Which parts of the record differ between two versions of it. */
function taskChanges(before: FactoryTask, after: FactoryTask): ReadonlyArray<TaskChange> {
  const changed: TaskChange[] = [];
  if (before.title !== after.title) changed.push("title");
  if (before.description !== after.description) changed.push("description");
  if (before.assignee !== after.assignee) changed.push("assignee");
  if (before.lane !== after.lane) changed.push("lane");
  if (before.parentId !== after.parentId) changed.push("parent");
  if (before.blockedBy.join("\n") !== after.blockedBy.join("\n")) changed.push("blockers");
  if (!sameModel(before.model, after.model)) changed.push("model");
  if (before.projectId !== after.projectId) changed.push("project");
  return changed;
}

/** Another writer moved the record past a base the person still has unsaved changes on. */
export function draftConflict(draft: TaskDraft, latest: FactoryTask): TaskDraftConflict | null {
  if (latest.rev <= draft.base.rev || !isDraftDirty(draft)) return null;
  return { theirs: latest, changed: taskChanges(draft.base, latest) };
}

/** "Keep mine": the base moves to their version and the typed values stay, to save over it. */
export function keepMine(draft: TaskDraft, theirs: FactoryTask): TaskDraft {
  return { ...draft, base: theirs };
}

/** "Use theirs": the typed values go and the session starts again from their version. */
export function takeTheirs(draft: TaskDraft, theirs: FactoryTask): TaskDraft {
  return { base: theirs, fields: {}, note: draft.note };
}
