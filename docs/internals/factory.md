# T3 Factory

T3 Factory is a thin fork of T3 Code. It adds a Work page and a pack of workflows on top of upstream's durable workflows, and changes as few upstream files as it can. This page records why it is shaped the way it is. For what a user sees, read [Work](../user/factory.md); for upkeep, [the fork runbook](../operations/factory-fork.md).

## A task is a record, not a run

A workflow run cannot be a card on a backlog. A run summary carries no description, project, model or person, a run cannot exist before it starts, only the workflow body can set a run's tags, and the client's run list is the newest 500. So a task is a record that Factory owns, and a run is one attempt at it. A task can have many attempts; the task outlives all of them.

## Where records live

Records are JSON values in upstream's workflow key/value store, under `factory/v1/`. Agents and workflow steps can already write that store (`t3 workflow store`, `T3.store`), so they create and read tasks with no new tool. A separate database would need a new CLI command or MCP tool for each thing an agent does to a task, and each is another seam and more agent context.

[`FactoryTaskStore.ts`](../../apps/server/src/factory/FactoryTaskStore.ts) is the only place that knows the key layout. Everything else asks for tasks, attempts or notes. Moving to a real table later is a change to that file. The service builds its own key/value layer on the shared SQL client, so the board works while workflows are off; only starting needs them.

The browser never gets a storage key. It has six typed methods, defined in [`factory.ts`](../../packages/contracts/src/factory.ts): subscribe, get, create, update, start and set the Orchestrator. A generic `storeSet` from the browser would let any page write any key and skip every rule below. A record that fails its schema is skipped and counted, so one bad record never breaks a read.

The pack cannot import server code, and the server cannot import workflow files, so the create and start rules exist twice: in [`FactoryTasks.ts`](../../apps/server/src/factory/FactoryTasks.ts) and in [`records.ts`](../../factory/workflows/lib/records.ts). Change one and change the other; tests on both sides (the service tests and `evals/factory-pack`) check them.

## What workflows cannot see

A workflow cannot inspect the machine's folders. So each time it starts a task, `FactoryTasks.start` looks at the task's project (a Git repository gets a `worktree`, any other folder `root`; no project means the server's scratch project) and writes the answer to `factory/v1/target/<projectId>` (`target/scratch` for no project). Only the service writes these rows. `resolveTarget` in [`records.ts`](../../factory/workflows/lib/records.ts) reads them and returns either where to work or a `problem`, which stops the run before an agent launches. A project the service has not looked at yet is taken as a worktree; a scratch task with no row stops with a message asking for a start from the Work page. If the target cannot be resolved, `start` refuses with `workspace-unavailable` and writes the same message into the row. Agents that work in a `root` folder do so under a per-project lock (`rootPool`), because they share that folder.

## Artifacts and receipts

A deliverable and the decisions made about it are records of their own: `factory/v1/artifact/<taskId>/<attempt>/<sha256>` and `factory/v1/receipt/<taskId>/<attempt>/<kind>-<sha256 prefix>`. They are not fields of `FactoryAttempt`, because a start writes that record twice (before the run starts, then again with its `runId`), so a field there would be overwritten by the second write. Both are write-once: `writeArtifact` and `writeReceipt` in `records.ts` do nothing when the key is already held, so a replayed step leaves the first record, with its first time, in place. A key holds a content hash, so a changed file is a new artifact and never edits the old one. Receipts say what was done to a hash (`sealed`, `critiqued`, `accepted`, `rejected`, `delivered`, `uncertain`, `promoted`) and by whom: `person`, `agent` or `pack`. A person's answer is told from an agent's by the session the server stamps on it, as for the merge.

## Risk tiers

[`risk.ts`](../../factory/workflows/lib/risk.ts) classifies a pull request as `low`, `standard` or `high` by the first rule that fits, from facts the host and the `scope` agent reported; a missing, duplicate or mismatched fact is `high`. `factory-task-part` ratchets the tier across fix rounds (never downgrading) and forces a person-answered merge gate whenever the tier is `high`, even with `askMerge` off. `risk.ts` has no imports, so a workflow and a plain test can both load it. The pack cannot read `factory/seams.json` at run time, so `FORK_SEAM_PATHS` copies its paths into `DEFAULT_PROTECTED_PATHS`, and `evals/factory-pack/risk.test.ts` fails when the two differ. Changing a seam in the manifest means changing that list too.

## Invariants

- Task numbers are never reused. A counter hands them out inside the transaction that creates the task. Tasks are dropped, never deleted, and if the counter is unreadable the highest stored number takes its place.
- Every write to a task checks its revision. A stale revision is refused with `conflict` and writes nothing, whoever wrote: the web page, the pack, or an agent.
- A task has at most one live run. A start, serialized per task, looks at its newest attempt that has a run and refuses while that run has not ended. The attempt record is written before the run starts, and the run starts with the idempotency key `task/<taskId>/a<n>`, so a repeated start returns the same run. A crash between the two leaves an attempt without a run, which the next start reuses instead of making a second one.
- The task row is the source of truth for its lane. A run never writes `done` into the row. The board derives the column: a live run overrides it, a completed run shows Done unless a person moved the task afterwards, and a run that stopped leaves the lane alone. Anything that reads the store directly sees the person's lane, not the displayed column. The derivation is in [`workBoard.logic.ts`](../../apps/web/src/factory/workBoard.logic.ts).

The board is derived in the browser from the task snapshot and upstream's run list. A task whose run has fallen out of that list falls back to its lane.

## How a change reaches an open page

A write through the service refreshes every subscriber at once. A write by anything else, such as a workflow step or the CLI, is found by a poll: while at least one page is subscribed, the service looks at a watermark over the `factory/v1/` keys (how many rows, the latest update time, the total size of the values) and re-reads the records only when it moved. One read serves every subscriber, and a failed read is logged and skipped.

The trap: the watermark is a summary, not a version. An outside edit that leaves the row count, the latest timestamp and the total size unchanged, such as changing one letter in a title within the same clock tick as another write, is not seen until something else changes. Outside edits that change a task also bump its revision, which usually changes its size, so the gap is narrow. Do not close it by polling faster; the service's own writes never depend on the poll.

## Why agents use workflows

An agent in a thread cannot call the `t3_workflow` tool; it is hidden there. An agent uses the `t3 workflow` command. Rather than add an MCP tool, the pack exposes `factory-capture` and `factory-start` as workflows. They are durable, they take an idempotency key, and the Orchestrator skill in [`factory/skills`](../../factory/skills/t3factory-orchestrator/SKILL.md) already has the command. An `ask` is not a gate only a person can pass, because an agent can answer it with `t3 workflow signal`. The skill still forbids it. For the merge the pack goes further with `mergeNeedsPerson`: the server stamps a session on an answer given in the app and strips it from anything a sender supplies ([`workflow.ts`](../../apps/server/src/workflows/workflow.ts)), so the pack can tell an app answer from a command-line one and asks again when the session is missing. It guards against habit, not against an agent set on cheating.

## Replay safety in the pack

A workflow step can run again after a restart, so a step that creates or starts a task must not do it twice. `createTask` and `startTask` write markers (`factory/v1/captured/<runId>/<slot>`) in the same transaction as the task or attempt `runId`, and return what the first execution stored on replay. The `finish` step writes its note and `captured/<runId>/finish` the same way. Before merging, `pullRequestHead` records the reviewed `headSha`, and `mergePullRequest` rereads the pull request so a second run never merges twice and a push after review stops the merge (`pull request head changed after review`).

The trap: upstream's loader ([`WorkflowRuntime.ts`](../../apps/server/src/workflows/WorkflowRuntime.ts), `loadDefinitions`) reloads a changed workflow file by importing it under a new address, but a module it imports by relative path, such as `lib/records.ts`, keeps its address and Node returns the first copy. After a change under `factory/workflows/lib/` a running server fails to load the workflow or runs it against the old helper until it restarts. That includes the dev server: restart `vp run dev` after editing `lib/`.

The pack's rules for checking that a pull request is the project's, binding merge to the reviewed `headSha`, and enforcing person-only merge live once in [`records.ts`](../../factory/workflows/lib/records.ts). Every workflow that merges, whether a task's part or an upstream sync, must go through them.

## Keeping up with upstream

Every edit to an upstream file is a possible conflict on every merge, so each is counted and capped. [`factory/seams.json`](../../factory/seams.json) lists the files Factory owns, the upstream files it may edit by hand (the seams, at most twelve, each with a `maxAdded` line budget), and the generated files. [`scripts/factory-seams.ts`](../../scripts/factory-seams.ts) compares `HEAD` with its merge base and fails on any other change, on a deleted or renamed upstream file, on a seam exceeding `maxAdded`, and on a seam that no longer differs. A seam edit is small and mechanical: an import, a registration, an entry in a list; anything larger belongs in a Factory-owned file that the seam calls. The service is read in `ws.ts` through `FactoryTasks.orDisabled`, which needs no context, so upstream's own tests of that file stay untouched.

Generated files are regenerated after a merge, never merged by hand. Translation catalogs are the exception that needs a tool. Taking upstream's catalogs and running the generator resets every Factory string to English, and upstream's `i18n:check` still passes. So Factory's translations live in overlay files and [`factory-i18n.ts`](../../scripts/factory-i18n.ts) rebuilds each catalog as upstream's plus the fork's keys.

The fork adds no dependencies, so the lockfile stays upstream's, and CI checks it.
