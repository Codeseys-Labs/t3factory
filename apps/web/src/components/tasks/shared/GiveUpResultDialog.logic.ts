import type { FactoryTaskWorkspace } from "@t3tools/contracts";

/** The sentence saying where a given-up run's files are: `lead`, then `path` if known, then `tail`. */
export interface GiveUpFolderText {
  readonly lead: string;
  readonly path: string | null;
  readonly tail: string;
}

/**
 * Names only the folder the files are really in. A worktree run whose thread is not loaded (an
 * archived thread, say) has no known folder, and the project folder would be the wrong one.
 */
export function presentGiveUpFolder(input: {
  readonly workspace: FactoryTaskWorkspace;
  readonly worktreePath: string | null;
  readonly projectRoot: string | null;
}): GiveUpFolderText {
  if (input.workspace === "root")
    return {
      lead: "Nothing is removed: the agent's changes stay in the project folder",
      path: input.projectRoot,
      tail: ".",
    };
  const tail = " until your Storage settings clean up that folder, as for any other thread.";
  return input.worktreePath === null
    ? {
        lead: "Nothing is removed: the agent's files stay where the run left them",
        path: null,
        tail,
      }
    : { lead: "Nothing is removed: the agent's files stay in", path: input.worktreePath, tail };
}
