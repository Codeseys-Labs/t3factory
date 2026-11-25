// Takes a new upstream nightly into the fork: an agent merges it and opens a pull request, then a
// person says whether to merge it once its checks pass. Upstream's history is merged, never rewritten.
import { PackConfig, readConfig, taskTags } from "./lib/records.ts";

const { workflow, step, agent, ask, stop, title, tags, pullRequests } = T3;

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

    const branch = `sync/upstream-${ref
      .replace(/[^\w.-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/[.-]+$/, "")
      .replace(/\.lock$/, "-lock")}`;
    const base = config.baseRef?.replace(/^(?:origin\/|refs\/heads\/)/, "");
    const synced = yield* agent("sync", {
      project,
      title: `Sync upstream ${ref}`,
      brief: [
        `Take the upstream revision \`${ref}\` into this fork, in this worktree. Do these steps in order.`,
        "",
        `1. Create the branch \`${branch}\` and run \`git merge ${ref}\` on it. Never rebase or squash: upstream's history must stay intact.`,
        "2. Resolve conflicts. In the seam files listed in `factory/seams.json`, keep both sides' lines. For a generated file, take upstream's version. Do not hand-merge `pnpm-lock.yaml`: it must equal upstream's.",
        "3. Regenerate the generated files: the route tree, and run `vp run i18n:generate` in `apps/web`, `apps/mobile` and `apps/desktop`.",
        `4. Run \`node scripts/factory-i18n.ts merge --base ${ref}\`, then \`node scripts/factory-i18n.ts check --base ${ref}\`, then \`node scripts/factory-seams.ts --base ${ref}\`. If a seam is stale, remove it from \`factory/seams.json\`.`,
        "5. Run the Factory tests, `vp test run apps/server/src/factory scripts/factory- evals/factory-pack` and, in `apps/web`, `vp test run src/factory --project unit`, and fix what broke.",
        `6. Commit, push, and open a pull request against ${base === undefined ? "the project's default branch" : `the branch \`${base}\``}.`,
        "7. Return the pull request's URL as `prUrl`, a short `summary`, and in `conflicts` one entry for each conflict you resolved, naming its path and how you resolved it.",
      ].join("\n"),
      workspace: { type: "worktree", baseRef: config.baseRef ?? "HEAD" },
      runtimeMode: "full-access",
      timeout: config.stepTimeout,
      returns: Synced,
    });
    const { prUrl: reported, summary, conflicts } = synced.value;

    const prUrl = yield* step(
      "pull-request",
      { returns: Schema.NullOr(Schema.String) },
      Effect.gen(function* () {
        const wanted = reported.trim().replace(/\/+$/, "").toLowerCase();
        if (wanted === "") return null;
        const listed = yield* pullRequests.list({ project, state: "all", limit: 500 });
        const found = listed.find(
          (entry) => entry.url.trim().replace(/\/+$/, "").toLowerCase() === wanted,
        );
        return found === undefined ? null : found.url;
      }),
    );
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
      if (standing.value.checks !== "passing" && standing.value.checks !== "none") {
        return yield* stop("checks are not passing");
      }
      const answer = yield* ask("approve-merge", {
        title: "Merge the upstream sync?",
        kind: "merge",
        choices: ["Merge", "Hold"],
        data: { prUrl, ref, conflicts, summary },
        links: [{ label: "Pull request", url: prUrl }],
        timeout: "7 days",
      });
      if (Option.isNone(answer) || answer.value.choice !== "Merge") {
        return yield* stop("merge held");
      }
      yield* step(
        "merge",
        { returns: Schema.Void },
        Effect.gen(function* () {
          const detail = yield* pullRequests.read(pr);
          if (detail.state === "merged") return;
          yield* pullRequests.act(pr, "merge", { mergeMethod: "merge" });
        }),
      );
    }
    yield* tags(taskTags(syncId, project, "done"));
    return { prUrl };
  }),
);
