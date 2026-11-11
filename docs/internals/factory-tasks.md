# Factory tasks

Tasks, the Inbox and Automations are one surface over the Factory plan and execution engine. This
page records the decisions that span the server, the clients and the engine, and the traps found
while building it. The code owns everything else.

## A task is a plan task

A task is an item of a local Factory plan (`FactoryTaskRef`: environment, project, root, task). A
top-level task is a plan's root; sub-tasks are its items. Board state (lane, assignee, display id,
runs, results, activity) lives in sidecar tables next to the plan, mirrored from every committed plan
revision inside the plan's own transaction (`FactoryPlanStore.project`). Editing a plan from the older
Factory pages, from an agent or from the task page therefore lands on the same board.

Status is derived, never stored as a choice: a person sets only the lane (Backlog, Ready, Canceled);
In progress, In review and Done follow runs and accepted results
([`FactoryTaskDerivation.ts`](../../apps/server/src/factory/FactoryTaskDerivation.ts)).

## Needs you is split by who knows

The server reports what it owns: failed, changed, plan, review and unconfirmed. It never copies thread
state. Clients add question and approve from each live run's pending requests, with the same logic the
thread view uses. Both halves are merged in `packages/client-runtime/src/state/factoryTaskView.ts`, so
web and mobile rank them the same way. The `attention` list filter returns exactly the tasks that can
need a person, in any status; counting In progress and In review tasks misses a plan waiting on a
Backlog task.

## A person starts every run

No rule, approved plan or finished blocker starts an agent (issue #84). Intake rules stop at Suggest;
an `auto-start` rule can be saved but not enabled (`autonomy-not-allowed`). An unblocked sub-task
stays Ready. Accepting a result is not publishing.

## Publish goes through the delivery service

Publish and Merge reuse `FactoryDeliveryService` through `grantCommit`: the task supplies the exact
accepted commit, and acceptance is rechecked inside the grant transaction, so a Reopen between the
click and the grant wins. Delivery is per accepted revision. Check only reads the host, so an
Unconfirmed send can never be repeated by accident. The task service follows the delivery store's
change stream, which needs the RPC side and the effect worker to share one `FactoryDeliveryStore`.

## Traps

- Task runs need Windows and Codex (or the dev Replay provider):
  `NativeExecutionPlan.validateNativeExecutionCapabilities` refuses everything else.
- A work run's thread refuses messages (`FactoryExecutionLifecycle.guardCommand`), so "Message agent"
  works only for planning runs; changes go through Request changes, which starts a new attempt.
- Editing a plan bumps its revision. The engine then refuses approval answers for runs admitted under
  the old revision, so a sibling run waiting on approval must be stopped and started again.
- A live stream subscription atom stays `waiting` until the stream ends and may not emit before the
  first change. Read only its failure; treating `waiting` as loading kept every task list loading.
- Hermes does not apply `\P{…}` inside a negated character class. Shared client code that runs on the
  phone uses explicit ranges (`providerInstanceInitials`).
