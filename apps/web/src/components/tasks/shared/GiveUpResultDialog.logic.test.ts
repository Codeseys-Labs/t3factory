import { describe, expect, it } from "vite-plus/test";

import { presentGiveUpFolder } from "./GiveUpResultDialog.logic";

describe("presentGiveUpFolder", () => {
  it.each([
    {
      name: "a worktree run whose folder is known names that folder",
      input: { workspace: "worktree", worktreePath: "/wt/run-1", projectRoot: "/repo" },
      path: "/wt/run-1",
      text: "Nothing is removed: the agent's files stay in /wt/run-1 until your Storage settings clean up that folder, as for any other thread.",
    },
    {
      name: "a run in the project folder names the project folder",
      input: { workspace: "root", worktreePath: null, projectRoot: "/repo" },
      path: "/repo",
      text: "Nothing is removed: the agent's changes stay in the project folder /repo.",
    },
    {
      name: "a worktree run whose folder is unknown names no folder",
      input: { workspace: "worktree", worktreePath: null, projectRoot: "/repo" },
      path: null,
      text: "Nothing is removed: the agent's files stay where the run left them until your Storage settings clean up that folder, as for any other thread.",
    },
    {
      name: "a run in an unknown project folder names no folder",
      input: { workspace: "root", worktreePath: "/wt/elsewhere", projectRoot: null },
      path: null,
      text: "Nothing is removed: the agent's changes stay in the project folder.",
    },
  ] as const)("$name", ({ input, path, text }) => {
    const presented = presentGiveUpFolder(input);
    expect(presented.path).toBe(path);
    expect(
      `${presented.lead}${presented.path === null ? "" : ` ${presented.path}`}${presented.tail}`,
    ).toBe(text);
  });
});
