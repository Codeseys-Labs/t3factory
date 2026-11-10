import { describe, expect, it } from "@effect/vitest";
import { usablePlanningSubmission } from "./factory-planning.ts";

const ref = {
  environmentId: "env-acme",
  projectId: "project-acme",
  rootId: "root",
  taskId: "root",
};
const api = { key: "api", title: "Build CSV API", description: "Return escaped CSV", after: [] };
const client = {
  key: "client",
  title: "Add export button",
  description: "Download CSV from the API",
  after: ["api"],
};
describe("planning submission grader", () => {
  it("requires a bounded, usable graph with order for this API/client task", () => {
    expect(usablePlanningSubmission({ ref, items: [api, client] })).toBe(true);
    for (const items of [
      [],
      [api],
      [api, api],
      [client],
      [{ ...api, after: ["client"] }, client],
      [{ ...api, after: ["api"] }, client],
      [api, { ...client, description: "" }],
      Array.from({ length: 33 }, (_, n) => ({ ...api, key: `task-${n}` })),
    ])
      expect(usablePlanningSubmission({ ref, items })).toBe(false);
  });
});
