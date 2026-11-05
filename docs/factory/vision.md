# T3 Factory vision

T3 Factory evolves T3 Code into one product for software, research, and knowledge work: **launch a thread to settle an outcome**. It coordinates people, agents, models, tools, and compute, then brings back the decisions and results that deserve attention.

**Factory is the application identity, not an optional feature underneath T3 Code.** Work, conversations, Intake, workflows, evidence, and connections are views within T3 Factory. A user should not need to enter a separate Factory mode to use the product. Linear is an optional source integration; local work remains useful without it.

Use **T3 Factory** in the application shell, titles, onboarding, settings, and platform display names. Use `t3factory` for the repository/product slug. Keep T3 Code attribution and the pinned upstream reconstruction clearly labeled as upstream references. Historical captures retain their original branding. The [design library](design/README.md) records the current product design and its verification limits.

Display branding does not authorize a mechanical rename of storage directories, bundle IDs, URL schemes, credentials, package names, or wire contracts. Those are compatibility identities with separate migration requirements. The existing runtime still contains legacy display names; this design decision is not evidence that a rebuilt desktop or mobile app has been rebranded.

This is product direction, with delivery sequencing updated on 2026-11-04, not a release capability checklist. The [roadmap refinement](roadmap.md) maps the requested priorities to the existing tracker milestones and proposed exit evidence. [Sources and evidence](sources.md) distinguish inspected foundations from proposals. The [Wayfinder decision map](https://github.com/Codeseys-Labs/t3factory/issues/2) and [delivery roadmap](https://github.com/Codeseys-Labs/t3factory/issues/66) retain the active decisions, milestones and acceptance records.

## One experience, many kinds of work

Software factory, autoresearch factory, and knowledge-work factory describe what people accomplish. They are user stories, not separate application modes or mandatory agent teams. A customer outcome may need research, code, experiments, architecture diagrams, and a stakeholder brief together. Evidence requirements follow the work and its outputs.

| Person                    | Starts a thread to…                           | A useful result                                                      |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Software engineer         | Ship a change across services                 | Integrated change, verification evidence, and authorized delivery    |
| Research engineer         | Determine whether an idea improves a baseline | Reproducible finding, protocol, artifacts, and negative results      |
| Engineering manager       | Decide release scope and remove blockers      | Evidence-linked priorities and separately authorized follow-ups      |
| Solutions architect       | Choose a customer architecture                | Editable diagrams, alternatives, assumptions, and defended tradeoffs |
| Forward deployed engineer | Unblock a customer rollout                    | Tested solution and reviewable customer brief                        |
| Other knowledge worker    | Resolve a question or assemble a deliverable  | Useful artifact with provenance and explicit uncertainty             |

Start in one composer with the desired outcome and context; budget, deadline, and execution preferences are optional. Simple requests run directly. Complex requests grow a collapsible plan showing dependencies, ownership, blockers, and output links. Independent tasks run in parallel within the granted scope. Child work stays nested until it needs input, fails materially, or the user opens it.

The coordinating agent reconciles results and disagreements, requests independent review where useful, and presents the assembled outcome. Attention inbox, thread, plan/board, artifacts, and fleet are views of the same work. Mobile emphasizes decisions, evidence, and steering. Preserve the open core, responsive clients, remote operation, and existing provider choice that make T3 Code useful.

**Completion, acceptance, delivery, and settlement are separate.** A thread can be settled because the question is answered or no longer matters. Settlement is reversible and does not certify correctness, publish an artifact, stop a remote worker, or disable a standing watch. Those actions need their own visible state and authority.

## Every thread can orchestrate; project coordination is an optional role

Any ordinary outcome thread should be able to plan, delegate, collaborate, and assemble its result. A project can also designate one ordinary thread as its project coordinator for priorities, shared dependencies, recurring workflows, and unresolved decisions. Users can start useful work without creating that role first.

The role belongs to the durable T3 thread, not an immortal model session. Context can be summarized, handed off, or resumed with another provider. Keep individual outcomes bounded and link their plans and evidence from the project coordinator.

The Factory implementation binds one current coordinator thread to an environment-local project, creates it through the normal thread launcher, and reuses the bound thread through `ensure`. It also supports assigning or reassigning an eligible existing ordinary thread using a binding revision. Assignment sends no message and starts no turn, including for settled targets. Archived and missing current bindings remain visible and can be explicitly replaced; archived or deleted targets must first be restored through ordinary thread controls. A project role grants no additional execution, publication, scheduling, or spending authority.

The web/desktop Factory page and mobile orchestrator panel expose existing-thread assignment alongside opening and creating a coordinator. Assignment compares the reviewed binding revision; one concurrent writer wins and stale callers must refresh. Request replay retains the original assignment, even after A-to-B-to-A reassignment. Reassignment preserves outcome threads, active task claims and attempts, and existing schedules attached to concrete threads. Reassigning during a pending launch removes that launch's binding and resume authority, but does not cancel a launch that already began or stop a running turn. Binding mutation and launch acknowledgement use binding identity rather than thread identity. A **Use as project coordinator** thread action remains proposed.

| Coordinator state  | Intended behavior                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Busy               | Queue or deliberately steer the existing thread; independent outcome threads remain usable.                                |
| Settled            | Retain the role. Explicit work or an authorized workflow can wake it through normal rules. Opening its page sends nothing. |
| Archived           | Show the binding; restore or explicitly reassign. Do not silently wake or replace it.                                      |
| Deleted or missing | Preserve provenance and require explicit replacement; review affected workflows.                                           |
| Offline            | Show unavailable and reconcile recovery or transfer. Do not infer another leader from the same repository URL.             |
| Reassigned         | Preserve ongoing attempt ownership. Reject stale coordinator-binding mutations using the binding revision.                 |

Current project scope is a checkout record within one T3 environment. A future logical project spanning environments needs an explicit owning environment/thread; equal repository URLs do not establish a global leader. Existing scheduled definitions are thread-bound. A future “current project coordinator” target must freeze the resolved thread and binding revision when a dispatch is admitted, so retries cannot jump to a different coordinator. Current reassignment retains existing concrete-thread workflows. Future coordinator-targeted workflows need an explicit retain, pause, or retarget policy.

## Durable plans and useful parallelism

Reuse T3's Project, AppThread, Run, ExecutionNode, provider adapters, context transfer, and handoff. The model reasons about strategy and decomposition; the V2 command/event/outbox architecture records and executes accepted intent. A task dependency graph and an execution lineage tree answer different questions and must remain distinct.

Extend the model only where needed: versioned plans, task criteria and input references, dependency conditions, ownership, attempts, requirements, and evidence. A stable task can have multiple attempts. Late results from an old attempt cannot overwrite the current result. Phases organize the view; explicit dependencies decide readiness. Routine child results can unblock downstream work under existing authority without making the user operate the scheduler.

Maximize useful parallelism. Isolate incompatible writers, give shared outputs an integration owner, and account for resource contention. Git worktrees fit code; task-owned artifact directories and versioned snapshots fit other work. Research trials can be independent yet compete for the same GPU. Begin with bounded fan-out, explicit dependencies, configured capacity, and a small ready queue.

Adapt OMP's peer collaboration into task-scoped addressed messages with sender, recipient, task/attempt identity, reply linkage, and artifact references. Persist delivery and replay; wake agents for meaningful readiness changes or blocking questions, and coalesce routine progress. Discussion does not transfer ownership, accept a result, or revise a plan: typed service commands do. Native provider children remain observable, with control limited to the provider's actual capabilities; do not launch them twice through a second orchestration layer.

Children receive relevant context and source revisions instead of the entire project transcript. Results carry evidence and uncertainty. Contradictions should survive into the integration decision, not disappear inside a confident summary.

## Placement and remote sandboxes

Separate three choices: harness/model, execution environment, and environment provisioning. API/account routing does not move a workspace. Extend existing T3 resource scoring and linked delegation with destination-side admission, reservations, capability requirements, locality, quota, budget, and queue awareness. Configured slots are a useful first step; low CPU at one instant is not a capacity reservation.

**Blaxel, Modal, Daytona, E2B, and Baseten are candidates in one remote `SandboxProvider` category.** Compare their supported CPU/GPU resources, OS/architecture, lifetime, persistence, snapshots, network policy, previews, credentials, and runner setup. Optional job/batch execution is a capability, not a vendor identity or a research-only path. Unknown capability must remain unknown. Baseten's Hosted Tools introduction establishes a relevant offering; its exact integration API and account entitlement remain unverified.

Existing linked T3 environments remain execution targets. A sandbox may host a prepared T3 environment or serve as a subordinate execution resource. Either way, ephemeral worker lifetime must not determine durable conversation or artifact lifetime. Keep provider-specific lifecycle differences visible instead of promising a universal pause/resume guarantee.

The coordinating environment owns the plan and dispatch record; the executor owns its processes, workspace, and observed evidence. Keep execution sticky after launch and transfer explicitly. On disconnect or uncertain create/run/stop results, reconcile before replacement. A cancellation request does not release the write claim until stop is acknowledged or fencing is enforced. Idempotent control-plane receipts do not make arbitrary external side effects exactly-once. Remote concurrent writers require a supported isolated launch path; remote delegation against a shared checkout is insufficient.

## Workflows and continuing work

Promote successful plans into reusable versioned workflows. Manual requests, schedules, and scoped events instantiate the same task and thread machinery. A research workflow can bound experiments, capture baselines and negative results, and request independent replication. A delivery workflow can assemble code, documents, and review evidence together.

Adapt Junior's temporary watches, durable automations, pre-agent filtering, run limits, and resolution records. Deduplicate and apply the standing policy before waking an agent. Event content is input, not authority. No-op events should remain quiet. Make watch scope, expiration, stop controls, and any work surviving settlement visible. An always-on coordinator can advance continuing workflows while a laptop sleeps; remote workers alone do not supply that scheduling continuity.

## Delivery priorities and measures

1. Complete the general task factory: capture an outcome, retain a stable task, analyze and decompose when useful, delegate dependency-aware children, assemble and review results, and recover safely. Prove a simple direct request and a mixed coding/knowledge task using local or pasted inputs. Investigate, deep-dive, architect, plan, act and review are adaptive phases, not mandatory gates.
2. Connect complete work stories. Add optional Linear task intake/linking, CodeRabbit and Greptile review evidence, and scoped email, calendar and knowledge integrations through the same task lifecycle.
3. Make successful task plans reusable through workflow authoring, with versioned inputs, quiet scheduled/event work and execution on eligible onboarded machines. Reuse existing linked-machine capabilities earlier; qualify broader placement, provisioning and portability here.
4. Add optional git-platform-native CI/CD execution through adapters that preserve task, invocation and evidence identity. General work remains useful without a repository or hosted automation.

These P1–P4 priorities do not renumber the tracker's M0–M5 milestones or invalidate accepted local alpha evidence. The roadmap preserves the crosswalk, plan-write and remote-ownership decision gates, and current manual-only delivery controls. Measure time to useful result, interventions, review rework, duplicate work, recovery success, cost per accepted outcome, and responsiveness under realistic concurrency. Agent count and token consumption are not productivity measures.

## Visual contract

The [diagram atlas](diagrams/index.html) presents five complementary questions. The examples are illustrations, not a persona selector proposed for the product.

| Question                                                            | SVG                                                        | Mermaid                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| How does one outcome use many contributors?                         | [Experience](diagrams/01-one-experience.svg)               | [Source](diagrams/01-one-experience.mmd)      |
| How do reasoning and durable execution fit together?                | [Runtime](diagrams/02-runtime.svg)                         | [Source](diagrams/02-runtime.mmd)             |
| How is work placed without losing ownership?                        | [Fleet](diagrams/03-fleet.svg)                             | [Source](diagrams/03-fleet.mmd)               |
| How do repeatable workflows enter the same loop?                    | [Workflows](diagrams/04-workflow.svg)                      | [Source](diagrams/04-workflow.mmd)            |
| How can every thread orchestrate without competing project leaders? | [Project coordinator](diagrams/05-project-coordinator.svg) | [Source](diagrams/05-project-coordinator.mmd) |

[Editable draw.io](diagrams/t3factory.drawio) contains five native pages. [Canonical graph data](diagrams/diagrams.json) drives all formats through the [generator](diagrams/generate.py). Regenerate checked-in exports with `python docs/factory/diagrams/generate.py --format`, using the repository's installed `vp` formatter; omit `--format` for a Python-standard-library-only export. Edit the graph data rather than generated exports. The static SVG layout is generated directly from that graph, not by a Mermaid renderer. The accompanying prose carries the same decisions without requiring a diagram viewer.
