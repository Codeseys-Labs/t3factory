import { NewTaskDialog } from "./NewTaskDialog";
import { TaskSetupDialog } from "./TaskSetupDialog";
import { useTaskDialogStore } from "../taskDialogs";

/** Mounted once in the app shell. Renders whichever dialog `taskDialogs` says is open. */
export function TaskDialogsHost() {
  const dialog = useTaskDialogStore((state) => state.dialog);
  if (dialog === null) return null;
  return dialog.kind === "new-task" ? (
    <NewTaskDialog defaults={dialog} />
  ) : (
    <TaskSetupDialog
      key={`${dialog.ref.environmentId}/${dialog.ref.taskId}/${dialog.intent}`}
      taskRef={dialog.ref}
      intent={dialog.intent}
    />
  );
}
