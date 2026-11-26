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

## Kind

A task has a **Kind**, set in the task panel. It decides which workflow **Start** runs:

- **Software** (the default) runs `factory-task`: plan, parts, pull requests, merge.
- **Knowledge** runs `factory-brief`: an agent writes a brief, a Markdown file.
- **Research** runs `factory-experiment`: a bounded experiment on a Git project.

Cards show a chip for Knowledge and Research; Software shows none. The two newer kinds are described under [Knowledge and Research tasks](#knowledge-and-research-tasks).

## Start a task

Press **Start** on a task, or tick the start option when you create it. Software and Knowledge tasks can run with a project or with **No project** (Research requires a Git project). Then:

1. An agent reads the project and proposes a plan of one to six parts. It changes nothing.
2. You approve the plan, or drop it.
3. Each part runs in its own worktree with its own agent. The agent opens a pull request when the project is a Git repository with a remote; with `baseRef` set, it is told to open it against that branch. The pull request must be one of the project's own, or the part stops.
4. The workflow waits for the pull request's checks, then a separate review agent reads the change and lists its findings; [How review works](#how-review-works) says which ones block. If the checks fail or the review blocks the merge, the part's agent fixes it, up to two rounds by default. If it still does not pass, you choose **Merge anyway**, **Fix again** or **Stop**. **Fix again** needs a reason: the worker takes it as your ruling for one more round, and the next reviewer is shown it.
5. When `askMerge` is on — or when the pull request classifies as `high` risk (protected paths, missing or mismatched scope/head SHA, unknown checks, or exhausted fix rounds) — you approve the merge; high-risk merges always require an in-app answer from a person even when `askMerge` is off. The pull request is then merged.
6. A part with no pull request is shown to you instead, and you accept it or ask for a redo.

A task made from an issue asks each part's agent to reference that issue in its pull request description; when the description does not, the workflow comments `Refs <issue URL>` on the pull request. A fix round that pushes no new commit is reported as such, and the same commit is not checked or reviewed again. The merge question and the question for a part that did not pass review show the pull request, the agent's summary, how many fix rounds pushed a commit and how many pushed nothing, the notes of the latest review that was not stale, its open findings (blocking ones first, at most 20), how many findings the disprove pass refuted, and your rulings.

If an agent runs out of time (`stepTimeout`), its thread is continued once from where it stopped rather than restarted. If it runs out again, the task shows **Failed** and waits in **Needs you**; resume the run on the Workflows page and the same thread carries on. An agent that you stopped, or whose turn could not be stopped, is not continued automatically: the part stops and says why.

Starting again after a run stops makes a new attempt; the task lists its attempts, and any still-open pull requests from earlier attempts are passed to the worker so it updates them instead of opening duplicates. A task that is already running cannot be started, and neither can a dropped one, from the page or the command line.

Questions appear in two places. The **Needs you** strip sits above **Board**, **List** and **Graph** and lists every task whose run waits on you or has paused. Each item has a badge for what it waits on (**Approve plan**, **Merge**, **Accept**, **Review stuck**, **Failed** or **Question**), the task number and title, and **Open run**, which takes you to the run on the Workflows page, where you answer. When you answer an item or close its panel, focus moves to the next item in the strip, or to the one before it when that was the last, or to the strip's heading when none is left. **Next item needing me** opens the task of the oldest item, then the next one on each press; the command palette has the same command. The count on **Work** in the sidebar adds up the items of every server you are connected to; when a server's count cannot be known (it is disconnected, has workflows off, or refused), the count reads "at least". If a part's agent asks you something of its own, that question shows in the agent's thread as usual.

The sidebar count starts once you have opened **Work** in a session. With nothing known to be waiting there is no count, and the **Work** tooltip says when some servers could not be counted.

### How review works

The reviewer gives no verdict. It lists findings, each with a severity, a category (correctness, scope, test, security or other), the file and line it is about, one sentence on what is wrong, and a quoted line or command output when it has one. A review with no findings says the change can be merged as it is.

- **Blocker** and **major** findings block the merge. **Minor** and **nit** findings are recorded and shown to you but never block.
- The result follows from the findings: a review asks for changes exactly when a blocker or major finding is still open. A reviewer cannot approve a change with a blocking finding open.
- Before a blocking finding counts, another agent tries to disprove it, by reproducing it or finding a counter-example. A finding it shows to be false is marked **refuted** and no longer blocks. If it cannot show that, or fails, or runs out of time, the finding stays open: a failed attempt never lets a change through.
- A review belongs to one commit. If the pull request gets a new commit while it is being reviewed, or the reviewer says it read another commit, the review is **stale**: its findings are kept and shown but decide nothing, and the pull request is checked and reviewed once more. If that review is stale too, you get the **Review did not pass** question at once; no fix round is spent on it.
- When the change is high risk, a second reviewer also asks what input or state breaks the changed lines, quoting the line. Its findings count like the first reviewer's.

Every round of review stays on the task, so you can see what was raised, what was refuted and what came back.

### Where agents work

A project that is a Git repository gets a worktree per part. A project folder that is not a Git repository is worked in directly (the `root` workspace), so only one run at a time works in it; other runs on the same project wait their turn. A task with **No project** works in a scratch folder that the server keeps. Start refuses with `workspace-unavailable`, and says why, when that folder cannot be set up. One cause: the T3 home sits inside a Git repository, which turns projectless threads off until the home is moved outside it.

## Knowledge and Research tasks

**Knowledge** (`factory-brief`). An agent writes one Markdown brief of at most 5 MiB, citing its sources, and changes no Git state. The request is frozen when the attempt begins, so later edits to the task do not move it. If `critiqueModel` is set, a second agent reviews the brief and the writer revises it, up to `fixRounds`. Then you **Accept**, ask to **Revise** (with a reason) or **Drop**. Acceptance is of the exact file by its SHA-256; a file that changed after review is refused and recorded. When the task came from an issue and `briefDelivery` is `issue-comment`, the brief is posted as a comment on it. The post carries a marker, so a repeat finds the comment instead of posting twice, and when the tracker's listing cannot show whether it landed, you are asked whether to post again.

**Research** (`factory-experiment`). Git projects only. An agent proposes a protocol: a hypothesis, one metric and its direction, an existing evaluator command, which paths may be edited, which are sealed, and a budget (1 to 20 iterations, a wall clock, a per-measurement timeout). You approve it with **Seal** or drop it, and the evaluator's SHA-256 is fixed. A baseline is measured. Each iteration then has an agent make one commit inside the allowed paths; a commit that touches anything else, or that changes the evaluator, is invalid. Otherwise it is measured and kept only if it beats the best metric by at least the minimum improvement; a discarded commit is reset away. Three crashes in a row, the wall clock or the iteration limit end the loop. Every trial, kept or not, is a row of `results.tsv`, so negative results stay on record. You then choose **Promote to task**, **Promote to brief** or **Keep as result**; promotion adds a Backlog task and starts nothing.

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

## Self-repair

`factory-self-repair` runs daily at 04:00. It looks for Factory runs that ended or paused for the same reason at least twice (stopped runs from the last seven days; paused runs whenever they paused) and adds one **Backlog** task per reason, naming the workflow, the reason and the runs. A run that ended on your own choice, such as a plan you did not approve, does not count. It never starts the task: you decide whether a repair is worth a run. A reason already turned into a task is not added again.

## Outcomes and metrics

When an attempt of a Software task ends, the workflow records its outcome: what each part came to and, for each part that completed, the risk tier it ended on, how many fix rounds moved the pull request and how many did not, whether its agent had to be continued, how many questions it put to you, how many times you ruled **Fix again**, whether you merged anyway, and how many review rounds ran with how many blocking findings raised and refuted.

`factory-metrics` runs daily at 05:00 and rolls up the outcomes that ended in the last 30 days into one record, kept under the day it ran. It stores counts, never rates, scores or thresholds: you divide. With no outcome recorded yet it does nothing. To make a roll-up now, start it with the time it should end at, and a new key each time:

```sh
t3 workflow start factory-metrics --input '{"scheduledAt":"<ISO time>"}' --key metrics/<n>
t3 workflow store list factory/v1/metrics/<date>
```

`<date>` is the day the roll-up ends, as `2026-03-02`. A second roll-up that ends on the same day replaces the first. The record reads like this:

- `from` and `to`: the window. An outcome counts when it ended at or after `from` and before `to`.
- `tasks` and `attempts`: how many distinct tasks, and how many attempts, ended in the window.
- `leadTime`: `n`, `medianMs` and `p90Ms`, in milliseconds from a task's creation to the end of its first attempt that delivered. A task with no delivered attempt is left out, so `n` can be below `tasks`. Percentiles are nearest rank; both are null when `n` is 0.
- `delivery`: `parts` counts the parts that were merged or accepted, plus the parts that stopped; `clean` counts those merged or accepted with no **Fix again** ruling and no merge anyway. `clean / parts` is the share delivered without rescue. Skipped and cancelled parts are in neither.
- `intervention`: over the parts that completed, `parts`, `asks` (questions put to you), `rulings` and `mergedAnyway`. `asks / parts` is questions per part.
- `retry`: over the parts that completed, `parts`, `continued`, `fixed` (parts with at least one fix round that moved the pull request), then `laterAttempts` (attempts after the first) and `laterAttemptsDelivered`.
- `review`: `rounds` that were not stale, `raised` (blocking findings, counted once per round, so a finding raised in three rounds counts three times) and `refuted`. `refuted / raised` is how often the disprove pass cleared a finding.
- `byTier`: parts that completed, by the risk tier they ended on: `low`, `standard`, `high`, and `none` for a part with no pull request.

## Settings per project

Settings are JSON values in the workflow store. `factory/v1/config` applies to every project, and `factory/v1/config/<projectId>` overrides it field by field. Setting a key replaces the whole value, so read it first (`t3 workflow store list factory/v1/config`) and write the merged object with `"v":1`. Every field is optional:

- `baseRef`: the branch or ref worktrees start from. Default: `HEAD`.
- `planModel`, `workerModel`, `reviewModel`: `{ "instanceId": "…", "model": "…" }` with an optional `options` list. A role left unset uses the task's own model, then the agent's default. `reviewModel` is used by both reviewers; `planModel` by the plan and by the disprove pass.
- `concurrency`: how many agents of one task work at a time, 1 to 4. Default 2. A part waiting on checks or on you does not hold a place.
- `askPlan`, `askMerge`: ask you before starting and before merging. Both default to on.
- `fixRounds`: fix rounds, 0 to 3. Default 2.
- `stepTimeout`, `checksTimeout`: how long an agent step and the wait for checks may take. Defaults `"2 hours"` and `"1 hour"`.
- `mergeMethod`: `merge`, `squash`, `rebase` or `fast-forward`. Default `squash`.
- `mergeNeedsPerson`: a merge goes ahead only on an answer you give in the app. An agent's answer through the command line makes the question come back, and only your answer counts. It also asks the merge question when `askMerge` is off. Default off. It guards against an agent answering by habit; it is not a security boundary.
- `critiqueModel`, `briefDelivery`: for Knowledge tasks. `critiqueModel` has the same shape as the models above; unset, the brief gets no critique. `briefDelivery` is `none` or `issue-comment`. Default `none`.
- `protectedPaths`, `lowRiskPaths`: glob lists for pull-request risk routing. Protected paths (workflows, lockfiles, migrations, fork seams, plus any paths you add) always ask for a person's merge approval even when `askMerge` is off.

A value that does not decode stops the task at its first step with a message naming the key; it is not ignored. Checks are the pull request's own checks; Work runs no check command of its own.

## On the page

- Each column heading has a tooltip saying what the column holds.
- **Roll up parents** places a parent in the column its parts add up to. It is available once every task has loaded.
- A task's panel lists **Artifacts and receipts**: the files a run recorded (a brief, an experiment's evaluator and results) with their SHA-256, and receipts such as accepted, delivered or promoted, with who gave each. Records are never overwritten.
- Each attempt has **View plan**, which shows the plan that attempt made.
- A task's panel has a **Review findings** section for each attempt. For each part it shows the latest result with how many findings block and how many were refuted; for each round, its findings with severity, status, file and line, claim, evidence and what the disprove pass tried. A finding that a later round did not raise again is labelled "not raised again", not fixed: the reviewer simply did not find it again. A stale round is labelled as reviewed at a commit that then moved. A server that does not record review findings shows nothing here.
- A task's **Prerequisites** section draws the tasks that block it, the task itself and the tasks that are parts of it as a diagram, and lists every link below with a link that selects that task. Each related task is open, completed, dropped or unknown; unknown means it cannot be read, and it is never shown as ready or done. At most 25 related tasks are shown, blockers first, and the section says how many were left out. Only the blockers and parents you set on tasks are drawn; links observed in a tracker are not.
- The command palette has **Next item needing me** and **Go to task...**, which lists tasks by number and title.

## What needs Workflows on

The board itself works without workflows: create, edit, move and annotate tasks. Starting a task, run-driven columns, **Needs you**, intake and the Orchestrator's commands need **Settings → Labs → Workflows** on, and the Factory workflows installed on the server. A note on the page says when workflows are off.

## Limits

- There is no Work screen on mobile yet. Questions and runs on mobile are the ones workflows already show.
- Saving a task is refused if someone else changed it first. The task reloads and shows what changed; apply your edit again.
- The board shows the newest 2,000 tasks, and hides finished tasks untouched for 30 days.
- Tasks belong to the server that holds them.
- Metrics are records in the workflow store. The Work page has no view of them, and Knowledge and Research tasks record no outcomes.
