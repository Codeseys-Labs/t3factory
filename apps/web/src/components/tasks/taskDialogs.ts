import type { EnvironmentId, FactoryTaskRef, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * The dialogs any screen can open over itself. `new-task` is the capture composer. `task-setup`
 * asks who runs a task and how, then starts it, runs it again, or asks for a breakdown.
 */
export type TaskDialog =
  | {
      readonly kind: "new-task";
      readonly environmentId?: EnvironmentId;
      readonly projectId?: ProjectId;
      // Set to add a sub-task under this task.
      readonly parent?: FactoryTaskRef;
    }
  | {
      readonly kind: "task-setup";
      readonly ref: FactoryTaskRef;
      readonly intent: "start" | "retry" | "break-down";
    };

interface TaskDialogStore {
  readonly dialog: TaskDialog | null;
  readonly open: (dialog: TaskDialog) => void;
  readonly close: () => void;
}

export const useTaskDialogStore = create<TaskDialogStore>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

export function openNewTask(
  defaults: Omit<Extract<TaskDialog, { kind: "new-task" }>, "kind"> = {},
) {
  useTaskDialogStore.getState().open({ kind: "new-task", ...defaults });
}

export function openTaskSetup(ref: FactoryTaskRef, intent: "start" | "retry" | "break-down") {
  useTaskDialogStore.getState().open({ kind: "task-setup", ref, intent });
}
