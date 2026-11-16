import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Git from "../vcs/GitVcsDriver.ts";

export const makeWorktreeBaseResolver = Effect.gen(function* () {
  const git = yield* Git.GitVcsDriver;
  return Effect.fn("FactoryWorktreeBase.resolve")(function* (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly commitSha: string;
    readonly remote?: Git.GitWorktreeBaseRemote | null;
  }) {
    const { cwd, refName, commitSha } = input;
    const remote =
      input.remote === undefined
        ? yield* git.resolveWorktreeBaseRemote({ cwd, refName })
        : input.remote;
    if (remote === null) return commitSha;
    const fetched = yield* git.fetchWorktreeBaseCommit({ cwd, refName, remote });
    if (fetched === null) return commitSha;
    const ancestor = yield* git.execute({
      operation: "FactoryWorktreeBase.resolve",
      cwd,
      args: ["merge-base", "--is-ancestor", commitSha, fetched.commitSha],
      allowNonZeroExit: true,
      maxOutputBytes: 4096,
    });
    if (ancestor.exitCode === 0) return fetched.commitSha;
    if (ancestor.exitCode === 1) return commitSha;
    return yield* new GitCommandError({
      operation: "FactoryWorktreeBase.resolve",
      command: "git merge-base",
      cwd,
      detail: "Could not compare the project folder with its remote branch.",
    });
  });
});
