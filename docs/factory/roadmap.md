# T3 Factory roadmap

Build one useful task factory first, connect it to the systems where work arrives,
then make successful task plans repeatable. Git-platform CI/CD is an optional later
execution target. The latest requested priorities are named **P1–P4** below so they
do not renumber the existing **M0–M5** milestones or **W1–W5** delivery slices.

This document proposes a product/design refinement for reconciliation into the
canonical tracker. The [Wayfinder decision map #2](https://github.com/Codeseys-Labs/t3factory/issues/2)
owns decisions, [roadmap #66](https://github.com/Codeseys-Labs/t3factory/issues/66)
owns milestones, slice order and exit evidence, and [specification #67](https://github.com/Codeseys-Labs/t3factory/issues/67)
retains the Unified Work alpha contract. Their linked tickets remain the active
implementation and acceptance records; this file does not supersede them.

The [vision](vision.md), [task-journey design](design/round-08-task-loop/task-journey/)
and [wayfinder maps](design/round-08-task-loop/wayfinder/) describe the same product
from outcome, interface and navigation perspectives. A configured integration or
machine should extend a task's capabilities while its identity and history remain
stable. The [task return wayfinders](design/round-09-task-return/wayfinder/) refine
completion and return. No tracker, hosted workflow or integration is activated by this refinement.

## Tracker crosswalk and preserved evidence

| Existing tracker identity                      | Relationship to the requested priorities                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Reproducible baseline and manual delivery | Remains a separate delivery gate across P1–P4. Exact-candidate local validation precedes separately authorized hosted checks and artifact build; publication remains [#75](https://github.com/Codeseys-Labs/t3factory/issues/75).                                                                                                                                       |
| M1 — Unified Work alpha                        | Retain implemented W1/W2 and bounded G1 evidence. P1 extends that inspection/navigation foundation; it does not reopen its accepted local alpha or require it to pass new general-task criteria.                                                                                                                                                                        |
| M2 — Coordinated outcome beta                  | P1 prioritizes W4 authorized revisioned plan edits and W5's real mixed-outcome proof. Read-only W3 [#76](https://github.com/Codeseys-Labs/t3factory/issues/76) already exists; discovery [#77](https://github.com/Codeseys-Labs/t3factory/issues/77) and native prerequisites [#78](https://github.com/Codeseys-Labs/t3factory/issues/78) keep their own bounded scope. |
| M3 — Repeatable governed workflows             | P3 refines reusable workflow authoring after the core task loop and selected integration stories.                                                                                                                                                                                                                                                                       |
| M4 — Remote execution and recovery             | P3 includes eligible-machine workflow execution; isolated linked delegation remains governed by [#65](https://github.com/Codeseys-Labs/t3factory/issues/65). This is a dependency of remote writing, not of the global board or all P1 work.                                                                                                                            |
| M5 — Connected sources and context             | P2 brings selected complete integration stories forward in priority. Required forge families and proxy/console bundling, context research and other capability lanes remain recorded in #66; selected connectors do not establish full M5 completion.                                                                                                                   |

P4 is a proposed optional platform-execution lane, not a renamed M4 or permission
to change M0 policy. Priority expresses product focus; only an actual contract or
evidence dependency blocks another lane.

Tracker #66 records source landing and bounded local G1 verification for frozen
candidate `3a4ef2e488b813787e89524fd588110934fbf566`, including declared web,
Windows and Android evidence. It also records manual-only policy activation,
local packaging and separately unexecuted hosted/publication gates. These are
attributed tracker records, not a new runtime or hosted-configuration audit. The
older "source is unpushed" note in #67 is superseded for landing state by the later
explicit reconciliation in #2/#66; its specification and bounded evidence remain.

Identity [#62](https://github.com/Codeseys-Labs/t3factory/issues/62) and release
identity/strategy [#64](https://github.com/Codeseys-Labs/t3factory/issues/64) stay
resolved. [#63](https://github.com/Codeseys-Labs/t3factory/issues/63) governs the
additional plan/edge write and dependency-dispatch authority needed by W4. Current
advisory readiness and read-only views do not acquire that authority. Preserve
[#58](https://github.com/Codeseys-Labs/t3factory/issues/58) and its assigned owner
for uncertain artifact redelivery; it does not block unrelated read-only work.

## Starting point

These foundations were inspected in source. No runtime qualification is implied.

| Foundation                                     | Evidence and remaining gap                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable threads, provider execution and launch | [Thread launch service](../../apps/server/src/orchestration-v2/ThreadLaunchService.ts) supplies an existing execution path. The general task loop should extend it rather than create a second scheduler.                                                                                                                                                                                                         |
| Project coordination                           | [Coordinator service](../../apps/server/src/project/ProjectCoordinatorService.ts) supports the environment-local project role. Any ordinary outcome thread should remain useful without assigning that role first.                                                                                                                                                                                                |
| Retained Work and history                      | [Work contract](../../packages/contracts/src/factoryWork.ts) models issue, feed, brief and protocol work, with execution/run/attempt/output history. Its planning stage is currently null; it is not the proposed general task and child-plan model.                                                                                                                                                              |
| Knowledge work without Git                     | [Knowledge contracts](../../packages/contracts/src/factoryKnowledge.ts) and [claims](../../packages/contracts/src/factoryClaims.ts) support a bounded brief, task-owned folder and artifact evidence. [Creation, start and acceptance](../../apps/server/src/factory/FactoryKnowledgeService.ts) currently have person-only boundaries; automatic agent-created follow-ups need a deliberate authority extension. |
| Local planning and optional sources            | The [Round-05 contract](design/round-05/spec/experience-contract.md) proposes a project PlanItemRef before execution. [Round-07](design/round-07-optional-linear/refined/design-decisions.md) preserves local identity through optional Linear linking and uncertain writes. These are design proposals, not implemented persistence or connector proof.                                                          |

The proposed durable task extends the planning model. It must retain optional source,
thread, invocation and attempt relationships; the existing WorkRef must not be
presented as an already implemented universal task identity.

## P1 — Complete the general task loop

**Outcome:** a person can capture an action item and receive a useful, reviewable
result without selecting a workflow or setting up an integration.

Capture creates a durable local task with its outcome and available context. The
person can save it for later or start analysis; an explicitly configured intake
policy may start analysis automatically. Simple tasks run directly. Complex tasks
grow a versioned plan with child task entries, criteria, dependencies and outputs.
Investigate → deep-dive → architect → plan → act → review are adaptive phases;
dependencies determine readiness and routine work advances within the granted
scope.

Each child records its selected model, harness and execution environment, with Auto
as a useful default and overrides available. Admission checks actual capability,
authority and configured capacity. Task dependency and execution lineage remain
different relationships. Bounded parallel work, writer isolation, result assembly,
independent review where useful, and durable attempt history complete the loop.

The task page leads with the next useful action or decision. Source state, planning,
execution, acceptance, delivery and settlement keep their separate meanings.
Missing context, unavailable capacity and uncertain results stay visible. Stop is
a request until acknowledgement or fencing establishes that replacement is safe.
A read-only child view returns to the exact parent context and distinguishes model,
harness, environment and attempt. Opening it grants no execution authority.

Accepting an exact preparation revision retains its artifacts and does not imply an
email was sent or a calendar changed. When delivery was part of the original outcome,
acceptance must narrow that outcome visibly or leave delivery outstanding. External
actions require separate approval of the exact intent and observed receipts. New task
opens an unassigned draft; capture creates a distinct identity and retains old history.
Reopen clears settlement on the same task, preserves prior accepted revisions,
artifacts and receipts, and starts no attempt or action. New work needs explicit intent
and valid scope; changed results form a new revision awaiting acceptance. Reconcile
unknown actions before a duplicate, and do not release a stop-requested writer early.

**Dependencies:** reuse resolved #62 identities and the existing source-specific
contracts. Resolve #63's additional task/plan/edge-write and dispatch policy before
W4 mutations; define how proposed plan items attach to retained work and attempts.
Extend typed service commands and destination-side permission checks for scoped
agent-created children, preserving human exact-artifact acceptance. Persist plan
changes and effects through the existing orchestration path. This includes a
non-repository workspace path and reviewable noncode outputs. Remote concurrent
writers separately depend on #65; read-only discovery does not.

**Exit evidence:** demonstrate both a simple direct task and a mixed parent task
that delegates independent children, waits for a dependency, assembles their
results and exposes a genuine review decision. Show preparation-only acceptance
with external actions unperformed, a distinct new capture, and an idle reopen that
retains accepted evidence; inspect a child and return to its parent. Include a coding change with
verification and a noncoding knowledge/draft deliverable using pasted or local
inputs. Restart during execution, reconcile a disconnected worker, and reject a
late result from a superseded attempt without duplicate work. Run the relevant
focused persistence, permission and orchestration checks and integrated real-client
journeys; cover web/desktop and mobile decisions over local and remote connections.
Design captures alone do not meet this exit.

## P2 — Connect complete work stories

**Outcome:** incoming signals and external actions join the same task lifecycle,
with source context, authority and observed results intact.

| Integration story       | Intended Factory behavior                                                                                                                 | Required evidence                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear                  | Optional issue intake/linking; local tasks remain useful and keep their identity. Source status and local task progress stay independent. | Scoped connection, admitted source revision, duplicate/echo handling, disconnect recovery and an explicitly enabled outbound update.                        |
| CodeRabbit and Greptile | Associate review findings with the exact change under review; useful findings become linked follow-up task candidates.                    | Attribution and revision binding; stale, repeated and conflicting findings remain distinguishable. A green review does not grant delivery authority.        |
| Email                   | Turn a selected message or scoped arrival into a task; prepare and review a response, then send under the applicable policy.              | Source context, draft revision, action authority and an observed send result. A timeout remains unknown until reconciled; retry cannot silently send twice. |
| Calendar                | Turn a request or meeting action into a task; propose a time or change, then confirm the authorized action.                               | Relevant calendar scope, current availability/conflict review, action identity and an observed event result; reconcile concurrent changes.                  |
| Knowledge               | Retrieve scoped context and produce a useful answer or artifact with provenance and uncertainty.                                          | Source versions/citations, access boundaries and inspectable output; unavailable evidence is visible.                                                       |

These are proposed adapter roles, not claims about vendor API support or account
entitlements. Verify each integration's current primary documentation and actual
account capabilities before implementation. Deliver the stories incrementally;
connector setup by itself does not complete this milestone.

**Dependencies:** P1's task, evidence, permission and recovery contracts. External
signals supply context; configured policy supplies authority. Deduplicate and filter
before waking an agent, and retain the originating source without forcing a source
account on local tasks.

**Exit evidence:** complete the customer-follow-up story from a real scoped input:
investigate the issue, reconcile knowledge, prepare a reply and meeting proposal,
review the assembled result, then observe the authorized email/calendar actions.
Also turn a current code-review finding into a task and return its verified result
to the original change. Exercise duplicate delivery, revoked access, stale inputs
and an uncertain external write. Any live action used for qualification requires
its own authorization.

## P3 — Author reusable workflows and run them on eligible machines

**Outcome:** a successful task plan can become a versioned procedure with inputs,
criteria, required capabilities, limits and an understandable trigger policy.

Start with **Save as workflow** from completed useful work. Manual runs, schedules
and scoped events instantiate the same task and attempt machinery. Preview inputs,
effects and placement before activation. Ordinary tasks retain a direct path;
workflow authoring is an additional capability.

Eligible onboarded machines can execute work according to their capabilities,
credentials, locality and reserved capacity. Keep harness/model choice separate
from machine placement and provisioning. The coordinating environment owns the
plan and dispatch record; each executor owns its observed process and workspace.
Durable artifacts survive an executor's lifetime. No silent fallback or transfer
follows an uncertain launch or stop.

**Dependencies:** P1's reliable execution/recovery and the relevant P2 integration
contracts. #65 governs the first isolated linked-environment writer and cancellation
ownership. Reuse inspected linked-environment capabilities where available without
claiming that isolated Factory task placement is already qualified. Broad placement,
workflow portability and new sandbox provisioning retain historical M4's own gates;
Blaxel remains its preferred first sandbox candidate. Continuing schedules require
an available scheduling owner, not merely a remote worker.

**Exit evidence:** author a workflow from a completed task, pin a version, run it
manually, and instantiate it through one authorized schedule or event. Show one
local and one eligible remote execution with durable outputs. Change the workflow
without changing an admitted run, filter a duplicate event, refuse an incapable
target, and recover from disconnection. Demonstrate pause/resume of future dispatch
separately from stopping an active attempt, and show work that survives settlement.

## P4 — Refine optional git-platform CI/CD execution

**Outcome:** a suitable workflow can also run through a supported git platform,
with Factory retaining a coherent task and evidence view.

Add a platform adapter for workflow inputs, pinned definitions, execution identity,
results and receipts. A CI-only invocation has an external run identity; it does
not need a fabricated T3 thread. Preserve per-version input requirements, and keep
Factory-owned triggers distinct from platform-native configuration. Local save,
commit/push and observed hosted activation are different states. Pausing a Factory
binding cannot claim to disable an independently owned platform rule.

**Dependencies:** P3's versioned workflow and dispatch contract, plus explicit
platform capability and authority decisions. General tasks remain usable without
a repository or CI connection. Product authoring and adapter design do not activate
hosted automation. Preserve M0's manual-only checks/tests and separate manual
artifact/build/release path: exact-candidate local tests and builds precede either
hosted dispatch; no automatic tag, push, schedule or workflow-run release chain.
Future platform-event activation requires a separate policy decision and explicit
authorization. No hosted run or repository setting changes in this design pass.

**Exit evidence:** execute one authorized platform workflow against pinned inputs;
join its external result to the correct task/invocation; handle duplicate callbacks,
out-of-order results and missing receipts. Show hosted activation and cancellation
truthfully, and retain separate acceptance and publication authority. Expand to
additional platforms only after this end-to-end path is qualified.

## Decisions that constrain delivery

1. **Plan authority (#63):** reuse resolved #62 work identity; define additional
   plan-item/edge identity, revisions and how source-bound Work entries attach
   without rewriting their history. This extends the resolved contract.
2. **Standing authority:** specify which task creation, execution, spending and
   external actions may progress automatically, how that policy is inspected and
   revoked, and where a person must decide. Existing person-only service boundaries
   do not disappear implicitly.
3. **Result acceptance:** define reviewable artifacts and external-action receipts
   for each task domain, including partial completion and failed or unknown actions.
4. **Isolated execution (#65):** retain environment-owned execution while resolving
   admission, capacity, workspaces, attempts and cancellation fencing for linked
   writers. A future logical project/continuing-work owner needs an explicit choice;
   equal repository URLs do not establish one.
5. **Workflow portability:** define the supported capability subset and adapters
   before promising that every workflow can run on every machine or CI platform.

Measure time to first useful result and accepted outcome, necessary interventions,
review rework, duplicate actions, recovery success, cost per accepted outcome and
client responsiveness under realistic concurrency. Establish measured baselines
and agreed targets during qualification; do not substitute agent count, token
volume or invented maturity scores for useful results.
