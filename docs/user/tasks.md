# Tasks

A task is a piece of work you can hand to an agent, follow on a board and review when it is done.
**Tasks**, **Inbox** and **Automations** sit at the top of the sidebar, above your threads.

## Add a task

Choose **New task** in the sidebar, press `C`, or use the command palette. The first line is the
title; the rest is the description. Pick the project and who does it:

- **Auto** picks an agent when the task starts, from the project's defaults and your agent profiles.
- An **agent profile** or a pinned harness and model runs exactly that.
- **You** or **Unassigned** keep the task for a person.

A run uses the mode its agent profile sets, or the one you pick when you start it. Otherwise it takes
the project's **Default permissions** from Settings, which is Full access unless you changed it. An
agent that does not offer the mode runs Supervised, as it does in a thread.

**Add to backlog** saves it. **Start now** saves it and starts an agent at once. A sub-task added under
a task follows its parent's assignee on Auto.

## Follow the work

**Tasks** shows a board or a list over the same tasks, grouped by status, assignee or project. Status
follows the run: In progress while an agent works, In review when it has a result, Done when you
accept it. Backlog and Ready are yours to set; drag a card between them. Dropping a card on In progress
opens the start sheet. Nothing starts an agent without your click: not a rule, not an approved plan,
and not a sub-task whose blocker finished.

**Needs you** lists every task that waits on you: a failed run, an approval, a question, a plan to
review or a result to review. It sits above the board and fills the **Inbox**, which the sidebar
counts. You can answer and approve from either place, or from the task page.

A task's **Thread** tab shows the agent's conversation. Replies to a working agent go through its
question and approval cards; to change the result, use **Request changes** with a note, which starts a
new run with it.

## Review a result

**Accept** records your review of that revision and marks the task Done. **Request changes** runs the
task again with your note; it waits while another sub-task of the same task is running. **Reopen**,
in the task page's menu, takes a Done task back to In review.

Accepting does not publish anything. For an accepted code result, **Publish** pushes that exact
commit to a new branch named after the task and revision
(`t3/T-36-rev1-3e6f91a2c8b745d0a1f4269e837bc502/audio-ring-demo`) and opens a pull request
against the repository's default branch; **Merge** merges it, and only while it still points at the
commit you accepted. Both need source-control write access and are always your click. If T3 Code lost
the host's answer, the task shows **Unconfirmed**; **Check** reads the host and settles it without
sending again. Publishing and merging happen on the desktop and web; the phone shows the state. If you merged the
pull request on the host, **Check** brings that in too.

If the task started from commits outside origin's default branch, Publish tells you how many extra
commits it would include. Publish or rebase those commits first.

## Automations

**Automations** connects sources (GitHub issues, a feed, or a schedule), rules that decide which new
items become tasks and who gets them, and agent profiles that name a harness and model so tasks and
rules can pick them. New items arrive in **Inbox → Triage** with the rule's suggestion; you accept,
snooze, decline or mark them duplicate. A rule can suggest a type and assignee; it cannot start an
agent. **Try once** runs a new rule on its next match and waits for your verdict before it turns on.
Snoozed items come back on their own when their time comes; until then they wait in Triage's snoozed
view, where **Unsnooze** brings one back early.

The older Factory pages (Issues, Feed sources, Briefs, Research, Scheduled workflows and Orchestrator)
are linked at the bottom of Automations.

## On your phone

**Tasks** is a row at the top of the home screen. The phone lists tasks, shows what needs you, and
answers questions and approvals. Starting, accepting and setting up automations stay on the desktop
and web.

## Things to know

- Task runs support Codex, Claude Code, Grok, Pi, Antigravity and registered ACP agents (including
  OMP), plus locally managed OpenCode servers, on Windows and on Linux with delegated cgroup v2.
  Cursor's in-process SDK, Muse, external OpenCode servers and macOS cannot yet prove that all agent
  writers have stopped, so they can plan tasks but cannot start runs. Linux without delegated
  cgroup v2 also refuses starts.
- Stopping a run stops every process the agent started. It is not a sandbox: an agent that
  deliberately moves a process out of the run, or asks another service to start one, can keep
  working after the run ends.
- A sub-task that waits on another task stays Ready when its blocker finishes. Start it yourself.
- Editing a plan while its sub-tasks run can leave a waiting approval unanswerable. Stop that run and
  start it again.
