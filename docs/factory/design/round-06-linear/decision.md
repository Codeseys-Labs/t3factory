# Linear alignment — decision and UI/UX crosswalk

Research date: 2026-11-04. Design proposal only. No Figma, repository, Linear workspace or integration settings changed. Linear observations are from current official documentation and a published screenshot, which may lag the shipped UI; Factory observations are from the reviewed Round-05 native exports. This is not an authenticated usability test.

## Recommendation

Make Factory a familiar issue-management surface with a distinct execution and evidence layer. Define a loss-aware mapping before copying labels. A Linear issue is an external tracked issue; Factory plan membership, native thread, workflow invocation, candidate acceptance and delivery retain separate identities.

## Proposed crosswalk

| Linear                                       | Factory counterpart                                               | Proposed sync treatment                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace / organization                     | External integration connection                                   | Namespace remote IDs; not a T3 environment.                                                                                                    |
| Team                                         | External ownership/workflow scope                                 | Preserve team ID and its workflow states; not a repository or execution host.                                                                  |
| Issue                                        | External source record plus optional admitted planned item        | Link by workspace and issue UUID; display issue key. Linking/importing does not admit or start work.                                           |
| Title and description                        | Linked issue title/body                                           | Inbound in the initial pilot; later bidirectional candidates after format/conflict policy qualification.                                       |
| Issue status                                 | Linked source status; optional explicit planning-stage projection | Use exact team-specific state IDs. No automatic mapping to run, acceptance or delivery.                                                        |
| Assignee / agent delegate                    | Human assignee / separately identified delegated agent            | Human identity mapping is separate from the environment that owns execution. AgentSession integration is a separate phase.                     |
| Project / milestone / cycle                  | External planning metadata                                        | Do not equate a Linear project with a T3 directory, milestone with a gate, or cycle with a scheduled workflow. Preserve/filter metadata first. |
| Labels, priority, due date                   | Linked issue properties                                           | Qualified IDs and typed values, not names/ordinal guessing; expose only supported writes.                                                      |
| Parent/sub-issue, blocks, related, duplicate | Typed source relationships                                        | Read and explain first; do not turn a tracker relation into dispatch or a universal execution DAG.                                             |
| Comments and attachments                     | Issue discussion and deliberately shared evidence links           | Keep separate from agent thread messages. No transcript replication or automatic artifact acceptance.                                          |
| Triage                                       | Similar interaction pattern to Intake                             | Accepting tracker work differs from Factory admission; deferring locally does not decline/cancel the issue.                                    |
| Saved views / list / board                   | Work filters, grouping and display preferences                    | View configuration remains local initially; same underlying record across layouts.                                                             |
| Archive, cancel, delete                      | External lifecycle state                                          | Preserve local execution/evidence and plan history. Removing from plan does not mutate remote lifecycle.                                       |

## Highest-value design changes

1. Add a recognizable issue key and source icon near every linked title; keep internal plan IDs in details. The human-readable key can change after a team move, so bind by UUID. Selection, filters and scroll position survive external handoffs. Keep local environment/project scope distinct from external workspace/team/project scope; browsing a different scope never moves an issue.
2. Keep Work/Intake/Workflows navigation but add one consistent Filter and Display area for grouping, order and visible properties. A layout toggle must not change the selected record or sync behavior.
3. Simplify routine rows to key, title, explicitly named status, priority and assignee; show agent/execution and sync exceptions as secondary signals. A planning board says Group: Planning stage, not an ambiguous Status. Keep the detailed three-state explanation in the inspector rather than repeating every invariant on every row. Offer an inspector-closed scan view and a full detail reader before shrinking the already-reviewed inspector geometry.
4. Give linked items an issue-properties section followed by Execution and Review/Evidence. Show human assignee, agent delegate and execution environment with different labels.
5. Add a small “Linear · ENG-237” connection row with Open in Linear and sync details. Expand it only for pending changes, conflict, missing mapping, lost access or uncertain write outcome.
6. Design an explicit connection flow: choose workspace and team, optional project filter, owning T3 environment, read/sync scope and field/status mappings; preview changes before enablement. Preview must name affected remote fields and may not offer dispatch implicitly.

Keep notifications separate from admission and tracker triage. Local Add to plan, Defer this revision, Mark notification read and Accept in Linear require distinct copy and effects. Relations need explicit Parent, Blocks, Blocked by, Related and Duplicate of directions. Keyboard proposals must be checked against the T3 dispatcher; navigation, peek and selection never dispatch work.

## Status mapping must be reversible or stop

Linear teams can have several Started states such as In Progress, In Review and Ready to Merge. Collapsing them all into Factory In progress loses information. Preserve the exact remote state alongside any coarse planning projection. A reverse write requires one explicitly configured destination or a user choice; a round trip must not overwrite an untouched remote In Review with In Progress. Unknown, renamed, deleted or moved-team statuses require review rather than a default guess.

Recommended starting mode: synchronize the linked issue properties, keep plan membership local, and keep local planning-stage mirroring off until that team's mapping is reviewed. Expose “Planning stage” and “Linear status” clearly when independent. If a later linked-stage mode is enabled, label its shared status as such and explain the destination in its picker; never silently create two independently editable copies.

Ordinary supported property edits should stay quick: name the Linear destination in the picker/editor and show pending/confirmed feedback, without adding a confirmation dialog to every edit. Use review only where scope or consequences warrant it. An unmapped field blocks that outbound field change; it does not erase the source, hide the item or freeze unrelated navigation.

## Small first integration

One explicitly scoped Linear team, one durable owning T3 environment, existing/new remote-issue import into Intake, explicit source-status updates and an optional T3-owned backlink. Import does not admit a planned item. Linear owns title, description, assignee, priority and planning metadata in this first pilot; Factory observes them. Keep broad field editing, outbound issue creation, relation changes, comment mirroring and AgentSession orchestration for later phases. A backlink requires a stable authorized T3 resource URL, contains minimal explicitly shared information, and must not publish local paths or credentials.

For the status pilot, compare baseline/current/requested state and serialize local commands per issue. A changed title alone does not conflict with a status-only intent. If the remote state changed, offer Use Linear or Review and submit again. For later broader field sync, preserve a last common snapshot and both drafts; disjoint-field merge and same-field resolution are proposed policies, not API guarantees.

The API review found no documented issue-update CAS, expected revision, If-Match or generic exactly-once contract in the inspected official SDK schema. Pre-read and readback cannot close the race with a human or another integration between those operations. If lossless concurrent writes are a hard requirement, leave outbound status edits disabled pending a documented conditional API. After a timed-out mutation, reconcile rather than blindly retry: seeing the desired value does not prove our write caused it, and seeing the old value does not prove the old request cannot still commit. Unknown outcome remains visibly uncertain.

Offer polling-only sync for local/tailnet-only environments, labeled with last checked time and stale/offline state. A publicly reachable, signed webhook receiver is optional for an always-on environment; a T3 pairing URL alone does not establish that capability. Webhooks need durable receipt, deduplication and canonical re-reads plus paginated repair scans. These are proposed requirements, not implemented behavior or a delivery SLA.

If GitHub and Linear already mirror a linked issue, choose one write route for every shared field. Preserve source identities and their explicitly verified relationship; avoid independent Factory→GitHub and Factory→Linear writes for the same logical edit. Hold source-status writeback for an already-mirrored issue by default until its consequences are reviewed. Existing Linear automation may also change issue status or linked PR state; do not present tracker cancellation as a harmless local removal. Lack of built-in sync metadata does not prove that other writers or automations are absent.

## Evidence and acceptance for a design follow-up

Six specimens are enough: linked issue inspector, compact Work list with Display, integration mapping review, same-field conflict, offline/uncertain-write recovery, and remote archived/unavailable issue with retained history. Test one navigation journey and reverse path per specimen. Do not expand this into another combinatorial scene matrix.

Contract checks before implementation signoff: renamed issue key retains UUID link; two Started states survive unchanged round trips; moved team requires remapping; remote Done does not accept an artifact; local Remove does not cancel Linear; offline edit plus remote edit preserves both versions; duplicate/out-of-order events do not duplicate an issue or comment; write timeout is reconciled; revoked access is not deletion; an existing GitHub mirror cannot create an echo loop.

## Sources

- [Linear concepts](https://linear.app/docs/conceptual-model): issue, team, project, milestone and workspace semantics.
- [Issue properties](https://linear.app/docs/issue-property): per-team workflow states and relationships.
- [Display options](https://linear.app/docs/display-options) and [custom views](https://linear.app/docs/custom-views): layout, grouping, properties and saved views.
- [Triage](https://linear.app/docs/triage): acceptance, declining, duplicate handling and snooze effects.
- [Assignment and delegation](https://linear.app/docs/assigning-issues): human responsibility and agent contribution.
- [Cycles](https://linear.app/docs/use-cycles): team planning cadence.
- [GitHub integration](https://linear.app/docs/github): existing issue sync, its visible connection state and status/PR automation.
- [Agent interaction](https://linear.app/developers/agent-interaction): session identity and activity lifecycle, separate from tracker status.
- Factory baseline: ../round-05/refinement-01/final-desktop-design.md and final-desktop-gallery.html.

## UI review disposition

The independent [UI comparison](ux-comparison/decision.md) supports the scope/identity, named-state, local-versus-upstream action, view-control, progressive-disclosure, relation and keyboard changes above. Its suggestion to shrink the inspector is deferred until a new 1280/1600 readability check; closing the inspector and a full reader can recover space without reopening validated widths. Its suggestion to include description writes in the first sync slice is deferred pending format round-trip proof.

The review also found inconsistent official guidance: Triage describes duplicate handling as Canceled, while Issue properties describes a reserved Duplicate status. Do not encode that ambiguity as a destructive status mapping; defer duplicate writes and consume actual workspace state metadata. Published image layouts and shortcut text are reference material, not live product verification.

## API review disposition and implementation gap

The independent [sync contract](sync-contract/decision.md) supplies exact entity/state mappings, the CAS investigation, failure cases, deployment choices and pinned official-schema references. Its [machine-readable contract](sync-contract/mapping.json) is conceptual, disabled example data. Adopt its smaller source-status/backlink pilot; defer the broader property writes suggested by the initial UI research. No implementation has been approved or performed here.

The current code inspected by that review uses repository-qualified numeric issue IDs and open/closed status. It does not establish a Linear adapter. A Linear UUID must not be coerced into a repository issue number. The external source identity boundary needs a deliberate extension before implementation, while preserving the existing expected-source-revision check separately from any remote concurrency guarantee.

The design follow-up is [the refined standalone and optional Linear design](../round-07-optional-linear/refined/design-decisions.md). Neither agent's research upgrades the reviewed Figma prototype into a running integration. Both research tasks used the requested high reasoning setting; Sol reviewed UX and Astra reviewed the synchronization contract.
