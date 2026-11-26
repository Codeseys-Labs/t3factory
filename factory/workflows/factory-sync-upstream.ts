// Takes a new upstream nightly into the fork: an agent merges it and opens a pull request, then a
// person says whether to merge it once its checks pass. Upstream's history is merged, never rewritten.
import {
  PackConfig,
  mergeApproved,
  mergePullRequest,
  projectPullRequest,
  pullRequestHead,
  readConfig,
  taskTags,
} from "./lib/records.ts";

const { workflow, step, agent, stop, title, tags, pullRequests } = T3;

const Synced = Schema.Struct({
  prUrl: Schema.String,
  summary: Schema.String,
  conflicts: Schema.Array(Schema.String),
});

export default workflow(
  "factory-sync-upstream",
  {
    version: 1,
    payload: Schema.Struct({ projectId: Schema.String, ref: Schema.String }),
    returns: Schema.Struct({ prUrl: Schema.String }),
    asks: { merge: "Merge the upstream sync?" },
  },
  Effect.fn(function* (input, run) {
    const ref = input.ref.trim();
    yield* title(`Sync upstream ${ref}`);
    if (ref === "" || ref.startsWith("-")) return yield* stop("ref is not a git revision");
    const project = input.projectId;
    // A run is not a task, so its tags carry an id of their own.
    const syncId = `sync-${run.id}`;
    yield* tags(taskTags(syncId, project, "doing"));
    const config = yield* step("config", { returns: PackConfig }, readConfig(project));

    // A ref may hold `$`, `'` or a backtick, so the agent gets it quoted for the shell it runs.
    const posix = `'${ref.replaceAll("'", "'\\''")}'`;
    // PowerShell also reads the typographic single quotes as quotes.
    const powershell = `'${ref.replace(/['‘’‚‛]/g, "$&$&")}'`;
    // A character a branch name cannot hold, and a `%` so that the result is unambiguous, becomes
    // %XX, not `-`, because hyphens would let two different refs share one branch name.
    // A `/` stays, as it is valid in a ref.
    const hex = (byte: number) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    const branch = `sync/upstream-${ref
      .replace(/[^\w./-]/gu, (char) => Array.from(new TextEncoder().encode(char), hex).join(""))
      .replace(/\.(?=\.)/g, "%2E")
      .replace(/\/(?=\/)|^\/|\/$/g, "%2F")
      .replace(/\.(?=\/|$)/g, "%2E")
      .replace(/\/\./g, "/%2E")
      .replace(/\.lock(?=\/|$)/g, "%2Elock")}`;
    const base = config.baseRef?.replace(/^(?:origin\/|refs\/heads\/)/, "");
    const synced = yield* agent("sync", {
      project,
      title: `Sync upstream ${ref}`,
      brief: [
        "Take the upstream revision below into this fork, in this worktree. Do these steps in order.",
        "",
        "Wherever a step says <ref>, write the revision as one quoted argument, exactly as given for your shell, and never retype or expand it:",
        `POSIX shell (bash, zsh, sh): ${posix}`,
        `PowerShell: ${powershell}`,
        "Run every command in one of those shells; cmd.exe is not supported.",
        "",
        `1. Create the branch \`${branch}\` and run \`git merge <ref>\` on it. Never rebase or squash: upstream's history must stay intact.`,
        "2. Resolve conflicts. In the seam files listed in `factory/seams.json`, keep both sides' lines. For a generated file, take upstream's version. Do not hand-merge `pnpm-lock.yaml`: it must equal upstream's.",
        "3. If the merge stopped for conflicts, stage your resolutions and complete the merge with `git commit --no-edit` now. The next steps compare against the merge base of the revision and HEAD, so HEAD must already contain the merge.",
        "4. Regenerate the generated files: the route tree, by running `vp build` in `apps/web`, and the translation catalogs, by running `vp run i18n:generate` in `apps/web`, `apps/mobile` and `apps/desktop`.",
        "5. Run `node scripts/factory-i18n.ts merge --base <ref>`, then `node scripts/factory-i18n.ts check --base <ref>`, then `node scripts/factory-seams.ts --base <ref>`. If a seam is stale, remove it from `factory/seams.json`.",
        "6. Run the Factory tests, `vp test run apps/server/src/factory scripts/factory- evals/factory-pack` and, in `apps/web`, `vp test run src/factory --project unit`, and fix what broke.",
        `7. Commit everything steps 4 to 6 changed, push, and open a pull request against ${base === undefined ? "the project's default branch" : `the branch \`${base}\``}.`,
        "8. Return the pull request's URL as `prUrl`, a short `summary`, and in `conflicts` one entry for each conflict you resolved, naming its path and how you resolved it.",
      ].join("\n"),
      workspace: { type: "worktree", baseRef: config.baseRef ?? "HEAD" },
      runtimeMode: "full-access",
      timeout: config.stepTimeout,
      returns: Synced,
    });
    const { prUrl: reported, summary, conflicts } = synced.value;

    const prUrl = yield* projectPullRequest(project, reported);
    if (prUrl === null) return yield* stop("pull request is not this project's");

    const pr = { project, url: prUrl };
    yield* tags(taskTags(syncId, project, "review"));
    const standing = yield* pullRequests.wait("checks/0", pr, {
      until: "checks",
      timeout: config.checksTimeout,
    });
    if (Option.isNone(standing)) return yield* stop("checks did not finish");
    if (standing.value.state === "closed") return yield* stop("pull request closed");
    if (standing.value.state !== "merged") {
      const { checks } = standing.value;
      if (checks !== "passing" && checks !== "none") {
        return yield* stop("checks are not passing");
      }
      const headSha = yield* pullRequestHead(pr);
      // No check ran, so nothing vouches for the merge: only a person's answer in the app counts.
      const approved = yield* mergeApproved(
        {
          title: "Merge the upstream sync?",
          kind: "merge",
          data: { prUrl, ref, conflicts, summary, checks },
          links: [{ label: "Pull request", url: prUrl }],
          timeout: "7 days",
        },
        config.mergeNeedsPerson || checks === "none",
      );
      if (!approved) return yield* stop("merge held");
      yield* mergePullRequest(pr, headSha, "merge");
    }
    yield* tags(taskTags(syncId, project, "done"));
    return { prUrl };
  }),
);
