import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { tasksSearch, tasksViewState, validateTasksSearch } from "./taskRoutes";

describe("tasks route search", () => {
  it("keeps a view through the router's parsed search values", () => {
    const peek = {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      rootId: "root",
      taskId: "task",
    };
    const search = tasksSearch({
      layout: "list",
      grouping: "assignee",
      filters: { statuses: ["ready", "backlog"], text: "paging" },
      peek,
    });

    expect(search).toEqual({
      layout: "list",
      group: "assignee",
      filters: { statuses: ["backlog", "ready"], text: "paging" },
      peek,
    });
    expect(tasksViewState(search)).toEqual({
      layout: "list",
      grouping: "assignee",
      filters: { statuses: ["backlog", "ready"], text: "paging" },
      peek,
    });
  });

  it("drops what it cannot read and leaves the defaults out of the URL", () => {
    expect(
      validateTasksSearch({
        layout: "grid",
        group: 7,
        filters: { statuses: ["nonsense"] },
        peek: "T-38",
      }),
    ).toEqual({});
  });
});
