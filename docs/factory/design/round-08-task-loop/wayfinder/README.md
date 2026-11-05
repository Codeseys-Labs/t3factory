# Task wayfinders

These maps refine two product questions: **where do I go to move this task forward?** and **how does one task reach a reviewed outcome?** They are proposed Round-08 design, with the inspected foundations labeled separately. They are not application architecture acceptance or runtime evidence.

The canonical [Wayfinder decision map (#2)](https://github.com/Codeseys-Labs/t3factory/issues/2) owns the decision frontier; the [delivery roadmap (#66)](https://github.com/Codeseys-Labs/t3factory/issues/66) owns milestones, vertical slices and exit evidence. These two navigation/lifecycle views complement those records. Their **P1–P4 labels describe proposed November 4 priority sequencing**, and do not rename or renumber the tracker's existing M0–M5 milestones or W1–W5 slices.

| Map | Reader takeaway | Editable source | Static export |
| --- | --- | --- | --- |
| R8-WF01 · Navigation | Capture and Intake lead to one local task. Its conversation, children, results and attention retain context; connections, workflows and machines remain secondary. | [Graph data](maps.json), [Mermaid](01-task-navigation.mmd) | [SVG](01-task-navigation.svg), [PNG](01-task-navigation.png) |
| R8-WF02 · Lifecycle and ownership | Analysis uses the smallest useful plan. Dependency-ready child work gets an admitted assignment and owned attempts; evidence returns for review and observed actions. | [Graph data](maps.json), [Mermaid](02-task-lifecycle.mmd) | [SVG](02-task-lifecycle.svg), [PNG](02-task-lifecycle.png) |

## Navigation contract

Capture accepts an outcome and context, with separate analyze-now and save-for-later actions, and opens its local task directly. Imported candidates can be deduplicated and reviewed in Intake before admission; a source item does not become an execution merely because it arrived. The task is the persistent place to inspect the outcome, next action, plan, attempts, evidence and uncertainty. The proposed stable task extends local planning identity; it does not assert that a universal task identifier already exists in the runtime.

Work's board, table and list retain the same selected task, filter and layout on return. A question in Needs your decision opens that task at the relevant blocker. Conversation, child task and result details close back to the parent task. Optional Connections, Workflows and Machines retain their originating task when opened from it. Opening a surface grants no execution or external-action authority.

Sources, tasks and threads are separate records: a task may link source revisions and several attempts; an ordinary linked outcome thread can coordinate the work. A project coordinator remains optional. A child dependency graph expresses readiness; an execution lineage describes which attempts actually ran. The maps do not replace those with a second hierarchy.

## Lifecycle contract

Investigate, deep-dive, architect, plan, act and review are adaptive phases. A simple note summary can run directly. Complex work creates child tasks with criteria and dependencies; only dependency-ready work is eligible for routing. Auto placement selects model, harness and execution environment separately, then makes the admitted assignment visible. Routine results can advance the accepted plan within its policy without repeated human scheduling.

The coordinating environment owns task, plan and dispatch records. Each executor owns its processes, workspace and observed evidence. Attempts retain their own identity, and a late result cannot replace a newer attempt. Pause future starts and stop active work are distinct controls. Stop requested, an offline executor and an unknown result do not establish that a writer stopped. Replacement waits for acknowledgement or an established fence, and uncertain external requests are reconciled before retry. These are proposed semantics constrained by actual provider capabilities, not a promise of universal pause/resume support.

Review assembles artifacts, conflicting evidence and failures. An email draft differs from an observed send receipt; a proposed meeting change differs from a confirmed event. Action execution follows the granted scope and records what was observed. Completion, acceptance, delivery and settlement remain separate. Replanning preserves the existing task and its attempt history.

## Proposed priority sequence and tracker crosswalk

| Priority | Role in the maps | Existing tracker relationship |
| --- | --- | --- |
| P1 · Core factory | Capture, one task, adaptive analysis, dependency-aware child tasks, assignment, owned attempts, results, attention and recovery. Existing linked execution targets are reused. | Builds on M1 Unified Work and its W1/W2 evidence; coordination extends M2, especially W4/W5. W3's bounded read-only prerequisite view already has its own evidence. Plan/dependency writes retain the #63 decision gate. |
| P2 · Integrations | Optional source and action adapters, including Linear, review findings, email, calendar and knowledge. Their input or tracker state does not establish completion or authorize an action. | Prioritizes selected M5 source/context/destination lanes. Existing source-authority, exact-artifact acceptance and delivery decisions remain in force. |
| P3 · Reusable workflows and machines | Promote a successful plan into a versioned workflow with inputs and policy; each run enters the same task machinery on an eligible onboarded machine. | Corresponds to M3 repeatability and the relevant M4 placement capabilities. Isolated linked-environment ownership remains the separate #65 frontier; the view does not select a sandbox or reopen that decision. |
| P4 · Optional git-native CI/CD | CI can become an additional execution target with its own invocation and observed receipts. A platform-owned trigger has one dispatch owner; it does not duplicate the factory scheduler or fabricate a T3 thread. | A later workflow-target proposal, not a renaming of M4 remote execution. M0's current exact-candidate manual validation and separate build/publication gates remain intact; this map enables no trigger or hosted run. |

Read-through of #2 and #66 preserves their recorded M1 local alpha, existing W1/W2/W3 work, resolved #62/#64 decisions and the assigned #58 gate. A new P1 label does not make those foundations unimplemented. The maps illustrate user navigation and task progression; they do not claim to resolve #63/#65, close a milestone, or replace native tracker ownership/dependency state.

The [task journey](../task-journey/) owns screen IDs R8-T01–R8-T08 referenced in graph data. These references identify intended design counterparts, not verified prototype wiring. The [product roadmap](../../../roadmap.md) owns delivery scope and exit evidence.

## Foundations and provenance

- [Vision](../../../vision.md): one composer, simple direct work, collapsible plans, optional project coordinator, task/attempt distinction and separate placement choices.
- [Experience contract](../../round-05/spec/experience-contract.md): Work layouts preserve identity and origin; source review, planning and execution have distinct lifecycles; CI can have an invocation without a T3 thread.
- [Optional-Linear decisions](../../round-07-optional-linear/refined/design-decisions.md): local identity survives linking; source status, planning, execution and human ownership remain distinct.
- [Current work contract](../../../../../packages/contracts/src/factoryWork.ts): current work kinds and null planning stage demonstrate that the generalized task loop remains an extension. The link is provided for source inspection, not to claim implementation.
- [Existing diagram atlas](../../../diagrams/diagrams.json): JSON canonical graph plus SVG/Mermaid exports is the reused authoring convention.

The sources above were inspected for this revision. “Design foundation” refers to reviewed source designs; “ordinary thread foundation” refers to the existing T3 thread model. Neither label promotes every proposed edge to implemented behavior.

## Regeneration and evidence

Run from the repository root:

```powershell
python docs/factory/design/round-08-task-loop/wayfinder/generate.py
```

[maps.json](maps.json) is canonical. The generator checks references, coordinate bounds, text height, node overlap and edge/node intersections, then emits editable SVG shapes/text and conservative Mermaid flowcharts with accessibility descriptions. This follows the existing atlas pattern; Mermaid selects its own layout rather than inheriting SVG coordinates.

The two SVGs were converted locally to PNG with `rsvg-convert` and opened for visual inspection. A separate Pillow/Arial measurement found no node-title, badge or body-text width overflow. The Mermaid authoring skill's structural audit passed both flowcharts with adjacent `accTitle` and `accDescr`; no pinned Mermaid parser/renderer was available, so Mermaid syntax/layout rendering remains unverified.

SVG rendering and source checks are local design evidence only. They do not establish native Figma structure, prototype navigation, accessibility conformance, responsiveness, execution, integration behavior or persistence. The precise Mermaid destination/version is unpinned; structural audit is distinct from a successful parse/render in that destination.
