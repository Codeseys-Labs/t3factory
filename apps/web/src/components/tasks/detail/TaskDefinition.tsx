import type { FactoryTaskSummary } from "@t3tools/contracts";
import { type KeyboardEvent, type MouseEvent, useState } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../../ChatMarkdown";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { useTaskActions, useTaskPermissions } from "../shared";

// The heading's text is the control: click it to edit in place.
const EDITABLE_TEXT =
  "-mx-1 min-w-0 cursor-text rounded-md px-1 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The task's title, edited in place. Enter saves and Escape puts the old title back. */
export function TaskTitle({ task }: { task: FactoryTaskSummary }) {
  const { update: canUpdate } = useTaskPermissions(task.ref.environmentId);
  const actions = useTaskActions();
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const title = draft.trim();
    setDraft(null);
    if (title.length > 0 && title !== task.title) void actions.update(task, { title });
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
    }
  };
  if (draft !== null)
    return (
      <Input
        aria-label="Title"
        size="lg"
        value={draft}
        maxLength={512}
        autoFocus
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={keys}
        onBlur={save}
      />
    );
  return (
    <h2 className="min-w-0 break-words font-semibold text-xl">
      {canUpdate ? (
        <button type="button" className={EDITABLE_TEXT} onClick={() => setDraft(task.title)}>
          {task.title}
        </button>
      ) : (
        task.title
      )}
    </h2>
  );
}

/** The description, edited in place. Ctrl or Cmd with Enter saves, Escape puts it back. */
export function TaskDescription({
  task,
  description,
}: {
  task: FactoryTaskSummary;
  description: string;
}) {
  const { update: canUpdate } = useTaskPermissions(task.ref.environmentId);
  const actions = useTaskActions();
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() !== description.trim()) void actions.update(task, { description: draft });
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
    }
  };
  if (draft !== null)
    return (
      <Textarea
        aria-label="Description"
        value={draft}
        maxLength={8000}
        autoFocus
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={keys}
        onBlur={save}
      />
    );
  const text = description.trim();
  const body = (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      environmentId={task.ref.environmentId}
      className="text-muted-foreground"
    />
  );
  if (!canUpdate) return text ? body : null;
  if (!text)
    return (
      <button
        type="button"
        className={cn(EDITABLE_TEXT, "py-0.5 text-muted-foreground text-sm")}
        onClick={() => setDraft(description)}
      >
        Add a description…
      </button>
    );
  // Links and selections inside the rendered description keep working; any other click edits.
  const editOnClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("a, button, summary, input"))
      return;
    if (window.getSelection()?.isCollapsed === false) return;
    setDraft(description);
  };
  return (
    <div
      role="group"
      aria-label="Description"
      aria-description="Press Enter to edit"
      tabIndex={0}
      className={cn(EDITABLE_TEXT, "py-0.5")}
      onClick={editOnClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          setDraft(description);
        }
      }}
    >
      {body}
    </div>
  );
}
