# Work

The Work page is a board of tasks for a project. A task is something you want done: you describe it, start it, and a workflow plans it, has agents do the parts in their own worktrees, reviews each result, and asks you at the points that matter. Work is part of T3 Factory and builds on [workflows](workflows.md).

## Open it

Pick **Work** in the sidebar footer, or run **Open work** from the command palette. The page shows one server at a time; with several connected, pick the server at the top. Switch between **Board**, **List** and **Graph**, filter by project, or filter by title or `T-` number. **New task** adds a task.

## Tasks and lanes

Each task has a number (`T-12`), a title, an optional description, a project, an assignee, a model, notes, and optionally a parent task and tasks that block it. A parent groups its parts. A blocker marks the task **Blocked** until the blocker is done.

A task sits in one of six lanes: **Backlog**, **Ready**, **Doing**, **Review**, **Done** or **Dropped**. You move it between them yourself. **Dropped** takes it off the board; press **Undo** in the message that appears to put it back.

A task that has a run follows the run instead of its lane:

- While the run is going the task shows under **Doing**, or **Review** once its pull requests are being checked.
- When the run completes, the task shows under **Done**. If you moved it after the run ended, your lane wins.
- When the run stops or is cancelled, the task goes back to its lane and shows **Stopped**.
- A task shows **Working** while any of its agents is at work, and **Waiting** when nothing is, for example while its run waits on checks.
- **Failed** shows when its run, or any of its parts, has paused on a failed step. A failed task is also listed under **Needs you**.

Notes are a log on the task. You can add one at any time; the workflow adds one when a run ends, saying what each part came to.

## Start a task

Press **Start** on a task, or tick the start option when you create it. A task needs a project to run. Then:

1. An agent reads the project and proposes a plan of one to six parts. It changes nothing.
2. You approve the plan, or drop it.
3. Each part runs in its own worktree with its own agent. The agent opens a pull request when the project is a Git repository with a remote; with `baseRef` set, it is told to open it against that branch. The pull request must be one of the project's own, or the part stops.
4. The workflow waits for the pull request's checks, then a separate review agent reads the change. If the checks fail or the review asks for changes, the part's agent fixes it, up to two rounds by default. If it still does not pass, you choose **Merge anyway** or **Stop**.
5. You approve the merge. The pull request is then merged.
6. A part with no pull request is shown to you instead, and you accept it or ask for a redo.

If an agent runs out of time (`stepTimeout`), its thread is continued once from where it stopped rather than restarted. If it runs out again, the task shows **Failed** and waits in **Needs you**; resume the run on the Workflows page and the same thread carries on.

Starting again after a run stops makes a new attempt; the task lists its attempts. A task that is already running cannot be started, and neither can a dropped one, from the page or the command line.

Questions appear in two places. On the board, the **Needs you** strip lists every task whose run waits on you or has paused; **Open** takes you to the run on the Workflows page, where you answer. If a part's agent asks you something of its own, that question shows in the agent's thread as usual.

## The Orchestrator

An Orchestrator is an ordinary thread in a project that you give an outcome to. It turns the outcome into tasks, starts them, and reports what waits on you. It never answers your plan, accept or merge questions unless you tell it to in the conversation.

Select a project in the project filter, then press **Orchestrator**. If the project has one, its thread opens. If not, a new thread starts with instructions to load the `t3factory-orchestrator` skill; the skill has to be installed where your agent finds skills (see [the fork runbook](../operations/factory-fork.md)). To make a thread the project's Orchestrator, open it and run **Make this thread the project's Orchestrator** from the command palette. Pressing **Orchestrator** later opens that thread.

## Agents and the command line

Agents, scripts and you can create and start tasks with the `t3 workflow` command. Every start needs a `--key`; starting twice with the same key returns the same run, so a retry never makes a second task.

```sh
t3 workflow start factory-capture --input '{"title":"Add CSV export","projectId":"<projectId>","start":true}' --key capture/csv-export
t3 workflow start factory-start --input '{"taskId":"<taskId>"}' --key start/<taskId>/1
```

`factory-capture` takes `title` (required), `description`, `projectId`, `parentId`, `blockedBy`, `lane`, `assignee`, `model`, `issue` and `start`. It returns the task's id and number. `factory-start` starts an existing task; use a new key for each attempt, and it ends with `already running` when the last attempt is still going.

## Turn issues into tasks

`factory-intake` checks a project's tracker every five minutes and adds each new issue with your labels as a task in **Ready**. It adds an issue once. Turn it on per project by storing a binding:

```sh
t3 workflow store set factory/v1/intake/<projectId> '{"v":1,"enabled":true,"labels":["factory"],"autoStart":false}'
```

With `autoStart` on, each captured task also starts. The project's tracker has to be connected under **Settings → Source control & issues**.

## Settings per project

Settings are JSON values in the workflow store. `factory/v1/config` applies to every project, and `factory/v1/config/<projectId>` overrides it field by field. Setting a key replaces the whole value, so read it first (`t3 workflow store list factory/v1/config`) and write the merged object with `"v":1`. Every field is optional:

- `baseRef`: the branch or ref worktrees start from. Default: `HEAD`.
- `planModel`, `workerModel`, `reviewModel`: `{ "instanceId": "…", "model": "…" }` with an optional `options` list. A role left unset uses the task's own model, then the agent's default.
- `concurrency`: how many agents of one task work at a time, 1 to 4. Default 2. A part waiting on checks or on you does not hold a place.
- `askPlan`, `askMerge`: ask you before starting and before merging. Both default to on.
- `fixRounds`: fix rounds, 0 to 3. Default 2.
- `stepTimeout`, `checksTimeout`: how long an agent step and the wait for checks may take. Defaults `"2 hours"` and `"1 hour"`.
- `mergeMethod`: `merge`, `squash`, `rebase` or `fast-forward`. Default `squash`.
- `mergeNeedsPerson`: a merge goes ahead only on an answer you give in the app. An agent's answer through the command line makes the question come back, and only your answer counts. It also asks the merge question when `askMerge` is off. Default off. It guards against an agent answering by habit; it is not a security boundary.

A value that does not decode stops the task at its first step with a message naming the key; it is not ignored. Checks are the pull request's own checks; Work runs no check command of its own.

## What needs Workflows on

The board itself works without workflows: create, edit, move and annotate tasks. Starting a task, run-driven columns, **Needs you**, intake and the Orchestrator's commands need **Settings → Labs → Workflows** on, and the Factory workflows installed on the server. A note on the page says when workflows are off.

## Limits

- There is no Work screen on mobile yet. Questions and runs on mobile are the ones workflows already show.
- Saving a task is refused if someone else changed it first. The task reloads and shows what changed; apply your edit again.
- The board shows the newest 2,000 tasks, and hides finished tasks untouched for 30 days.
- Tasks belong to the server that holds them.
