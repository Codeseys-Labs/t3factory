import type { FactoryTaskRef } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { queueTaskSave } from "./taskSaveQueue";

const ref = (taskId: string) =>
  ({ environmentId: "env", projectId: "project", rootId: "root", taskId }) as FactoryTaskRef;

const gate = () => {
  let open: (outcome: "ok" | "fail") => void = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    open = (outcome) => (outcome === "ok" ? resolve() : reject(new Error("save failed")));
  });
  return { opened, open };
};

it("starts a task's saves one at a time, in order, and keeps going after a rejection", async () => {
  const started: string[] = [];
  const first = gate();
  const results = [
    queueTaskSave(ref("a"), async () => {
      started.push("first");
      await first.opened;
    }),
    queueTaskSave(ref("a"), async () => {
      started.push("second");
    }),
    // Another task's saves do not wait on this one.
    queueTaskSave(ref("b"), async () => {
      started.push("other task");
    }),
  ];
  const rejected = expect(results[0]).rejects.toThrow("save failed");
  await results[2];
  expect(started).toEqual(["first", "other task"]);
  first.open("fail");
  await rejected;
  await results[1];
  expect(started).toEqual(["first", "other task", "second"]);
});
