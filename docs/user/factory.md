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
3. Each part runs in its own worktree with its own agent. The agent opens a pull request when the project is a Git repository with a remote; with `baseRef` set, it targets that branch. If a local worker in a known Git project with a remote does not return a pull request, Factory asks the same worker once to finish publishing. A missing or unverifiable recovery stops the attempt instead of offering **Accept**.
4. The workflow waits for the pull request's checks, then a separate review agent reads the change and lists its findings; [How review works](#how-review-works) says which ones block. If the checks fail or the review blocks the merge, the part's agent fixes it, up to two rounds by default. If it still does not pass, you choose **Merge anyway**, **Fix again** or **Stop**. **Fix again** needs a reason: the worker takes it as your ruling for one more round, and the next reviewer is shown it.
5. When `askMerge` is on — or when the pull request classifies as `high` risk (protected paths, missing or mismatched scope/head SHA, unknown checks, or exhausted fix rounds) — you approve the merge; high-risk merges always require an in-app answer from a person even when `askMerge` is off. For a verified GitHub delivery, Factory waits for the host to confirm that the reviewed commit merged into its target. If it finds a local pull request already merged before review could be accepted, it flags the merge rather than marking the task done. **Hold** leaves a verified local task stopped rather than done.
6. Work that does not need a pull request is shown to you instead. Choose **Accept** or **Redo**. If you choose **Redo** or withdraw the question, the task does not go to **Done**. Once all parts have ended, a question under **Needs you** says a part was not accepted. Answer **Seen** to end the attempt, then start the task again, edit it, or drop it. Nothing reruns the part for you.

A task made from an issue asks each part's agent to reference that issue in its pull request description; when the description does not, the workflow comments `Refs <issue URL>` on the pull request. A fix round that pushes no new commit is reported as such, and the same commit is not checked or reviewed again. The merge question and the question for a part that did not pass review show the pull request, the agent's summary, how many fix rounds pushed a commit and how many pushed nothing, the notes of the latest review that was not stale, its open findings (blocking ones first, at most 20), how many findings the disprove pass refuted, and your rulings.

If an agent runs out of time (`stepTimeout`), its thread is continued once from where it stopped rather than restarted. If it runs out again, the task shows **Failed** and waits in **Needs you**; resume the run on the Workflows page and the same thread carries on. An agent that you stopped, or whose turn could not be stopped, is not continued automatically: the part stops and says why.

Starting again after a run stops makes a new attempt. The task lists its attempts, and the worker is shown any still-open pull requests from earlier attempts. In a known local GitHub project, Factory can reuse a recorded pull request only when its branch belongs to the same part. A worker on another machine is asked to open its own. A task that is already running cannot be started, and neither can a dropped one, from the page or the command line.

Questions appear in two places. The **Needs you** strip sits above **Board**, **List** and **Graph** and lists every task whose run waits on you or has paused. Each item has a badge for what it waits on (**Approve plan**, **Merge**, **Accept**, **Review stuck**, **Failed** or **Question**), the task number and title, and **Open run**, which takes you to the run on the Workflows page, where you answer. When you answer an item or close its panel, focus moves to the next item in the strip, or to the one before it when that was the last, or to the strip's heading when none is left. **Next item needing me** opens the task of the oldest item, then the next one on each press; the command palette has the same command. The count on **Work** in the sidebar adds up the items of every server you are connected to; when a server's count cannot be known (it is disconnected, has workflows off, or refused), the count reads "at least". If a part's agent asks you something of its own, that question shows in the agent's thread as usual.

The sidebar count starts once you have opened **Work** in a session. With nothing known to be waiting there is no count, and the **Work** tooltip says when some servers could not be counted.

### How review works

The reviewer gives no verdict. It lists findings, each with a severity, a category (correctness, scope, test, security or other), the file and line it is about, one sentence on what is wrong, and a quoted line or command output when it has one. A review with no findings says the change can be merged as it is.

- **Blocker** and **major** findings block the merge. **Minor** and **nit** findings are recorded and shown to you but never block.
- The result follows from the findings: a review asks for changes exactly when a blocker or major finding is still open. A reviewer cannot approve a change with a blocking finding open.
- Before a blocking finding counts, another agent tries to disprove it, by reproducing it or finding a counter-example. A finding it shows to be false is marked **refuted** and no longer blocks. If it cannot show that, or fails, or runs out of time, the finding stays open: a failed attempt never lets a change through.
- A review belongs to one commit. If the reviewer says it read another commit, or the pull request moves while a local worker's change is being reviewed, the review is **stale**: its findings are kept and shown but decide nothing, and the pull request is checked and reviewed once more. If that review is stale too, you get the **Review did not pass** question at once; no fix round is spent on it. If Factory finds an unexpected commit on the pull request of a worker [on another machine](#work-on-another-machine), it stops the part instead of reviewing that commit.
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

`factory-intake` checks a project's tracker every five minutes and adds each new open issue with your labels as a task in **Ready**. It adds an issue once. Turn it on per project by storing a binding:

```sh
t3 workflow store set factory/v1/intake/<projectId> '{"v":1,"enabled":true,"labels":["factory"],"autoStart":false}'
```

The project's tracker has to be connected under **Settings → Source control & issues**. Setting the key replaces the whole binding, so read it first (`t3 workflow store list factory/v1/intake/<projectId>`) and write it back whole.

### Start issues automatically

With `autoStart` on, intake also starts a captured task, but only when a GitHub account you listed in `authors` opened the issue after intake began on the project. Any other issue is still captured and waits in **Ready** until you start it.

```sh
t3 workflow store set factory/v1/intake/<projectId> '{"v":1,"enabled":true,"labels":["factory"],"autoStart":true,"authors":["<github-login>"]}'
```

- With no `authors`, or an empty list, nothing starts. That includes a binding that had `autoStart` on before `authors` existed: it goes on capturing, and each new task gets a note saying the binding lists no authors, until you add the list.
- An entry is a GitHub login without `@`: letters, digits and hyphens, at most 39 characters. Case does not matter. A list of more than 100 logins, or one entry of any other form, makes the whole binding invalid, and intake reads none of the project's issues until you fix it.
- List only accounts whose issues you would start yourself. Never list a bot, or an account that posts text from elsewhere, such as a sync or form account or a machine user. Who opened an issue is checked once, when intake first lists it; later edits to the issue are not checked.
- Intake begins on a project at the first check that finds its binding on. That time is kept under `factory/v1/intake-since/<projectId>` and does not move when you turn the binding off and on again, so issues that were already open are captured but never started for you; start them yourself. If you delete that key, the next check records a new, later time.
- Only GitHub issues start: other trackers do not say which account opened an issue in a way intake can rely on. GitHub Enterprise logins that contain `_` cannot be listed.

Each check's result, on the Workflows page or with `t3 workflow show <run>`, lists every captured issue with what happened to it: `started`, `running`, `dropped` or `failed`, or the reason it was not started. With `autoStart` on, the task also gets a note giving that reason. When several reasons apply, the first in this table is the one given:

| Reason               | The issue was not started because                                                |
| -------------------- | -------------------------------------------------------------------------------- |
| `tracker-not-github` | it is not a GitHub issue.                                                        |
| `no-authors`         | the binding lists no `authors`.                                                  |
| `no-author`          | the tracker did not say who opened it.                                           |
| `author-not-listed`  | the account that opened it is not in `authors`.                                  |
| `created-at-invalid` | its creation time is not a valid UTC time, or is later than this server's clock. |
| `before-since`       | it was opened before intake began on the project, or at that moment.             |
| `autostart-off`      | it would have started, but `autoStart` is off.                                   |

Two open issues of one project with the same key, which can happen when a project spans several repositories, are neither captured nor started; the result lists each under `failed`. A binding or start time that cannot be read is listed there too, and that project's issues are not read.

### Preview a binding

The preview says what the next check would do and changes nothing: it creates no task, starts nothing, adds no note and records no start time. Give it a new key each time:

```sh
t3 workflow start factory-intake-preview --input '{"projectId":"<projectId>"}' --key intake-preview/<projectId>/<n>
t3 workflow show <run>
```

It lists the project's open issues with your labels once and gives each an outcome: `start`, `capture` with the reason it would not start, `seen` when intake has already captured it, or `refused` when its key is shared. It treats the binding as on even when it is off, and before intake has begun on the project it treats it as beginning now, so no issue shows `start`. A missing or invalid binding gives a `problem` instead. If the tracker cannot be read, the preview pauses with the tracker's reason; resume it on the Workflows page.

## Signals

Signals gathers the items of public RSS 2.0 and Atom 1.0 feeds that this server follows, so you can turn the ones worth doing into tasks. Nothing from a feed starts or creates anything by itself. You decide on each item: **Admit** adds a **Backlog** task that is not started, and **Dismiss** sets the item aside.

Press **Signals** on the Work page and follow a feed from **Feeds**, with its address, a name and, if you like, the project that tasks admitted from it belong to. The server reads it within about 15 minutes, and its new items wait under **Waiting**. What you admitted or dismissed is under **Decided**, where a dismissed item can still be admitted. On a server without Signals the button does not appear.

- An admitted task carries only the item's title. Its description says which feed and item it came from and nothing more; the item's text and link stay in Signals. Write what you want done in the task before you start it, because its agents see only the task.
- Only public `https` addresses on port 443 can be followed: no other scheme or port, no user name or password, no IP address and no local or private host name. A feed whose host turns out to resolve to a private, local or reserved address is not read.
- Each feed is read at most once an hour, whether the last read worked or not. The server never opens the links inside items and does not follow redirects; a link shows as text.
- An item that changes gets a new revision. A waiting item stays waiting, a dismissed one comes back to **Waiting**, and an admitted one stays admitted and is marked **Changed after it was admitted**; its task does not change. While you follow a feed, each of its items is admitted at most once. If an item changed after Signals showed it, **Admit** and **Dismiss** are refused until you read it again.
- **Stop following** removes the feed's waiting and decided items and keeps the tasks you admitted. Following the same address again starts over, so an item admitted before can be admitted again. To rename a feed or change its project, stop following it and follow it again.
- Following and unfollowing feeds, admitting and dismissing need a device paired with permission to operate this server.
- Feeds are read only while workflows are on. Admitting and dismissing work without them.

Limits: a server follows at most 20 feeds. A feed must answer within 5 seconds with at most 256 KB, uncompressed, and only its first 50 items are read. A feed holds at most 100 waiting items; newer ones are picked up by a later read once you have decided some. Beyond 200 dismissed items, the oldest that are no longer in the feed are forgotten, and come back as new if they reappear. Titles are cut at 200 characters and summaries at 2,000. **Waiting** and **Decided** show the newest 200 items each. When a read fails, **Feeds** says when and why.

## Model proxy

The model proxy is a pinned version of CLIProxyAPI that runs on the selected environment's machine. Usage reads it as a hub named **Factory proxy** and includes the subscription accounts you sign in to there in [Usage → Limits](usage.md#track-subscription-limits). Each machine has its own proxy and sign-ins. Usage pools the accounts from the environments you are connected to. Agent traffic does not go through the proxy yet.

1. On **Work**, pick the environment and open **Model proxy**. To change the proxy, your device must be paired with permission to manage providers on that environment.
2. Choose **Install**. If you want to use the management console, first type a management key of 16 to 64 printable ASCII characters with no spaces. If you leave it blank, the server makes a key for Usage and you cannot sign in to the console. T3 Code never shows either key. To add or change a key you can use, uninstall, keep your sign-ins, and install again with a key you type.
3. When installation finishes, choose **Start**. The proxy listens only on that machine at `127.0.0.1`. The dialog shows its port, the first free one from 8317 through 8327 at installation. If you typed a key, open the console address in a browser on that machine and sign in with it. Use the console to sign in to provider accounts and manage their settings.
4. Choose **Stop** to end the proxy without removing it or its sign-ins. **Uninstall** also removes the program, its settings and keys, and the hub from Usage. Sign-ins are kept for the next install unless you select **Also remove the sign-ins it holds**. To delete sign-ins left by an earlier uninstall, choose **Remove kept sign-ins**.

At each start, the server sets the address, port, management key, sign-in folder and account data location again. It keeps the proxy's required client API key without removing keys you added. It restores the pinned console's download source and turns off automatic console updates. It also turns off remote management, HTTPS, network discovery, the Codex live media relay, profiling and plugins. Other settings you save in the console are kept across starts.

If the port is held, identify the current listener on that machine before stopping anything. An earlier proxy's process ID does not identify the current listener. Free the port, then retry **Start** or **Uninstall**; the proxy does not switch ports. If the settings file cannot be read, uninstall with sign-ins kept, then install again. Settings you saved in the console are lost, but the sign-ins are kept.

Only a person in the dialog can install or start the proxy. There is no command-line command, workflow or agent tool for it.

CLIProxyAPI is an unsigned third-party program that runs as the server's user, can access that user's files, and makes outbound requests on its own. Anyone with permission to manage providers on an environment can install and run it there. If the server is killed, the first Usage check after it restarts may send a typed key to another program holding the port, and that key can be reused to use your accounts or make requests from that machine.

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
- `readOnlyOn`: runs the reading steps of the project's reviews on another linked machine. It is valid only in a project's own key; see [Review on another machine](#review-on-another-machine).
- `writeOn`: runs the workers for a project's Software tasks on another linked machine. It is valid only in a project's own key; see [Work on another machine](#work-on-another-machine).

A value that does not decode stops the task at its first step with a message naming the key; it is not ignored. Checks are the pull request's own checks; Work runs no check command of its own.

## Review on another machine

The reading steps of a project's reviews can run on another machine you have linked, while everything else stays on this one. Set `readOnlyOn` in the project's own settings key, merged into what is already there:

```sh
t3 workflow store set factory/v1/config/<projectId> '{"v":1,"readOnlyOn":{"environment":"<environmentId>","project":"<project id there>","limit":2}}'
```

- `environment` is the linked machine's id, as `t3 environment list` prints it.
- `project` is the project's id on that machine, not a folder path.
- `limit` is how many places this server gives review agents there at a time, across all its tasks: 1 to 4, with no default. If `writeOn` names the same machine, the workers and reviewers share those places.

All three are required. `null`, or no `readOnlyOn`, turns it off. It is refused in `factory/v1/config`: there it stops every task with a message saying it belongs in a project's key.

Three review steps can run there: listing the changed files, the review, and the second reviewer of a high-risk change. Each gets a new worktree at the pull request's exact commit. The reader is told to read only, and gets the worker's brief as context, with each quoted line marked `| `, not as instructions to follow. Factory gives no approvals there. Planning, the disprove pass, checks, comments, merges and every task question stay on this machine. The workers and their fixes stay here unless you set `writeOn` separately.

It needs:

- A project that is a Git repository, so that its tasks work in worktrees. A task of a project that is worked in directly stops with a message saying so, and so does a task of a project that was never started from the Work page, which is where the server records how a project is worked in; start one of its tasks there once. A task with no project ignores `readOnlyOn`.
- The pull request's full commit, and a model available on that machine: `reviewModel`, or the task's model. A round without either runs on this machine, as if `readOnlyOn` were not set. For a Windows destination, use a Claude model: Codex waits for approval even to read with Git and cannot finish unattended. The turn is asked to stop at `stepTimeout`.
- **Linked environments** on for both machines and a working link; see [Link another environment](remote-access.md#link-another-environment).
- The pull request's head commit already in the reader's clone. For a verified delivery, it must also contain the **exact** commit Factory pinned for the target branch that round. The reader never fetches either commit. For other deliveries, the file listing compares to the reader's cached `origin/<base branch>`, which can be stale.

Nothing falls back. Once a round runs there, it never moves to this machine or to another one. If that machine cannot be reached, refuses the review launch or lacks the head commit, the part pauses and the task shows **Failed** under **Needs you**. The run tries again by itself after 5, 20 and 80 minutes, then waits for you. If the head is missing, every retry fails until someone fetches it on that machine.

If the reader reports a missing pinned base, the part stops before review, with no merge override. In the reader environment and project named in the stop reason, fetch the target branch from the pull request's repository yourself. Verify the reported SHA is present with `git rev-parse --verify "<SHA>^{commit}"`, then start the task again. Other file-listing failures still make the pull request high risk, so its merge asks you.

A review whose agent does not report the commit it read is stale, like one that read the wrong commit (see [How review works](#how-review-works)). To bring reviews back to this machine, cancel the run, remove `readOnlyOn` and start the task again.

Limits:

- Keeping writes out is up to that machine's provider; Factory does not enforce it. Claude declined to change the project in testing, so whether it would ask before a write was not tested. Claude does write its own plan file under `~/.claude/plans` without asking.
- Remote review has run between two real servers on one Windows machine. It has not yet been tested between two physical machines.
- What happens when the named model is missing on the other machine has not been tested.
- Each review there leaves its worktree and branch on that machine. Remove them yourself.
- A run that pauses gives back its place under `limit` while its agent there may still be working, so more than `limit` agents can be at work there at once. Work on that machine that does not come from this server does not count against `limit`.

## Work on another machine

Set `writeOn` to run the workers for a project's Software tasks on another linked machine. They make the changes, push and open pull requests there, and carry on there if a part needs to continue or fix its changes. Planning, reviews, the disprove pass, checks, Factory's comments and merges, and questions stay on this machine. To move the reading steps of review as well, set `readOnlyOn` separately.

Set `writeOn` in `factory/v1/config/<projectId>` on the machine you start the task from. Merge it into the existing settings:

```sh
t3 workflow store set factory/v1/config/<projectId> '{"v":1,"baseRef":"main","writeOn":{"environment":"<environmentId>","project":"<project id there>","limit":2}}'
```

- `environment` is the other machine's id from `t3 environment list`.
- `project` is the id of an ordinary Git repository project on that machine, with its own clone of the same repository. Do not give a folder path or use a project that makes its own clones from a plain folder.
- `limit` is how many places this server gives workers there at a time, across all its tasks: 1 to 4, with no default.

All three fields are required. If `readOnlyOn` and `writeOn` name the same machine, they must name the same project and limit, and workers and readers share that one limit. Set `writeOn` to `null` or remove it to turn it off. Do not set it in the global settings key.

Use a GitHub project and set `baseRef` to the branch on `origin` that the pull requests should target. Start from **Work** so Factory knows where the project's clone is. Turn on **Linked environments** on both machines and pair the link at full access; see [Link another environment](remote-access.md#link-another-environment). Name a `workerModel` or give the task a model that is available there. Workers run with that machine's user and Git credentials, so set up access to fetch, push and open pull requests there. Factory does not sync files or credentials. Each part needs a pull request: there is no file result to accept from another machine.

Once dispatched, the work never falls back or moves to another machine. If the other machine cannot be reached or refuses to start the worker, the part pauses and the task shows **Failed** under **Needs you**, with the step and its reason. The run tries again on that machine after 5, 20 and 80 minutes, then waits for you. A worker failure can also stop the part. The attempt note lists a stopped part as stopped; open its run for the reason. To bring the workers back here, cancel the run, remove `writeOn` and start the task again.

Limits:

- Factory may ask a writer to stop but does not kill it. A writer Factory loses track of may keep working and open a pull request Factory never reviews. Check for and close any such pull request yourself.
- Factory checks that the pull request still targets the configured branch when reviewing and before merging. A new commit or retargeting between the final check and GitHub's merge can still slip through, including during time spent in a merge queue. If the merged commit or target differs, Factory writes a task note and puts a question under **Needs you**. If it cannot confirm the merge, it asks you to check the pull request instead of marking it merged.
- The branches and worktrees stay on that machine. Remove them yourself when you no longer need them.
- Working on another machine has been tested against a stand-in for that machine only. It has not yet run between two real servers, and not between two physical machines.

## On the page

- Each column heading has a tooltip saying what the column holds.
- **Roll up parents** places a parent in the column its parts add up to. It is available once every task has loaded.
- A task's panel lists **Artifacts and receipts**: the files a run recorded (a brief, an experiment's evaluator and results) with their SHA-256, and receipts such as accepted, delivered or promoted, with who gave each. Records are never overwritten.
- Each attempt has **View plan**, which shows the plan that attempt made.
- A task's panel has a **Review findings** section for each attempt. For each part it shows the latest result with how many findings block and how many were refuted; for each round, its findings with severity, status, file and line, claim, evidence and what the disprove pass tried. A finding that a later round did not raise again is labelled "not raised again", not fixed: the reviewer simply did not find it again. A stale round is labelled as reviewed at a commit that then moved. A server that does not record review findings shows nothing here.
- A task's **Prerequisites** section draws the tasks that block it, the task itself and the tasks that are parts of it as a diagram, and lists every link below with a link that selects that task. Each related task is open, completed, dropped or unknown; unknown means it cannot be read, and it is never shown as ready or done. At most 25 related tasks are shown, blockers first, and the section says how many were left out. Only the blockers and parents you set on tasks are drawn; links observed in a tracker are not.
- The command palette has **Next item needing me** and **Go to task...**, which lists tasks by number and title.

## What needs Workflows on

The board itself works without workflows: create, edit, move and annotate tasks. Starting a task, run-driven columns, **Needs you**, intake, reading followed feeds and the Orchestrator's commands need **Settings → Labs → Workflows** on, and the Factory workflows installed on the server. A note on the page says when workflows are off.

The model proxy does not need Workflows on.

## The desktop app

T3 Factory v2 is a desktop app of its own, for Windows x64 only. It is not signed. It runs beside T3 Code and T3 Factory v1 and does not take over their data, profile, links or `t3` command. It comes as a zip, `T3-Factory-v2-<version>-x64.zip`: unpack it into a folder and start `T3 Factory v2.exe`.

- **Where it keeps its data.** Its home is `~/.t3factory-v2`, and its window profile is `%APPDATA%\t3factory-v2`. A T3 Factory server started another way, such as with the app's own `t3` command, uses the same home by default. Only one of them can run on the home at a time, so quit the app before starting another server on it, and the reverse. The home follows `T3CODE_HOME` when that variable is set, as T3 Code's does. If you set it as a Windows variable for T3 Code, this app opens T3 Code's data too: start it from an environment without that variable.
- **Links.** The app opens `t3code-factory://` links, and `t3code://` links still go to T3 Code. The app link its server prints starts with `t3code-factory://pair`. The QR code and the pairing URL beside it are unchanged, so a phone pairs through the T3 Code mobile app as usual; the app link itself does nothing on a phone.
- **Updates.** The app does not update itself. To move to a new build, quit the app, unpack the new zip into a new folder and start it from there. It uses the same home and profile, so your threads and settings stay. Delete the old folder once you no longer need it.
- **The `t3` command.** The app does not add `t3` to your `PATH` by itself. To use it from a terminal, choose **Install** next to **t3 command** in **Settings → About**, as for [T3 Code](install.md#the-t3-command).
- **Workflows.** Workflows are on unless you turn them off, and the app installs the Factory workflows into `~/.t3factory-v2\workflows` each time it starts. It adds missing files, updates its own and removes the ones it no longer ships. It never replaces or removes a file you wrote or changed: if a file there differs from the pack and is not what the app last installed, nothing is installed and the server log names the file. Move it away and restart the app. If `T3CODE_WORKFLOWS` points the server at another folder, nothing is installed.
- **Model proxy.** The app cannot install the [model proxy](#model-proxy): a packaged build has no pinned manifest, so **Install** refuses. Use a server run from a Factory checkout for it.
- **Usage data.** The app sends no usage data. Its server reports usage only if `T3CODE_TELEMETRY_ENABLED` is `true` in its environment, and those reports go to T3 Code's collector.
- **What it calls itself.** The window title, the taskbar and the startup failure messages say T3 Factory; those messages are in English whatever language the app is set to. Text inside the window still says T3 Code, including the welcome screen's note that it collects usage data.

## Limits

- There is no Work screen on mobile yet. Questions and runs on mobile are the ones workflows already show.
- Saving a task is refused if someone else changed it first. The task reloads and shows what changed; apply your edit again.
- The board shows the newest 2,000 tasks, and hides finished tasks untouched for 30 days.
- Tasks belong to the server that holds them.
- Metrics are records in the workflow store. The Work page has no view of them, and Knowledge and Research tasks record no outcomes.
