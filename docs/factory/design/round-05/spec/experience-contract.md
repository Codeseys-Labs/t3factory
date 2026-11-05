# F5 · T3 project workspace — integration contract

Read `../brief.md`, `../ground/t3-ui-baseline.md`, `../ground/inspiration-patterns.md` and `base.json` first. Latest direct user direction wins over the older manual-only CI assumption: workflows may run manually OR automatically, in Factory OR CI, through platform/native/custom triggers, integrations and webhooks. No real job or integration is changed in this design.

## 1. Parent decisions

One T3 Code shell, not Factory/Sessions branding. Keep native search, project/thread cards, Working/Settled, footer, breadcrumb, ordinary timeline/composer and contextual panels. Factory lives in a project workspace with compact **Work / Intake / Workflows** tabs. A More/project menu and source-owner actions retain Issues, Briefs, Research, Sources/settings and the ordinary coordinator thread; do not invent a separate hierarchy. Parent owns this shell and its reusable renderer.

Board/Table/List are layouts of the same project Work query. Keep scope, selected complete identity, filter and return origin. A new project-owned planning stage may organize work; it never changes forge issue status, starts execution, accepts output, merges or releases. Show execution/source state separately. No fake drag-to-start. Use ordinary rows/cards/table columns, not explanatory lecture cards or a workflow graph as the main experience.

**Critical identity correction:** the Issue inbox can show an unstarted forge Issue, but the candidate unified Work projection at3a4ef2e4 retains issue/feed admissions keyed by original launch-thread roots. An unstarted Issue is NOT thereby an existing retained WorkRef (`research/current-code-seams.md:15-25`). The new #63 project plan uses a separate **PlanItemRef** with optional SourceRef/retained WorkRef links. This is not a universal TaskId. The canonical fixture `plan-237` links source GitHub acme/factory#237 rev3. Before Factory admission it has no retained WorkRef or native thread; after admission its optional linked WorkRef/root is8b42f1d3. CI-only execution has an InvocationRef and external run id, not a fabricated T3 thread. Board/Table/List preserve the PlanItemRef, including environment/project, before and after its execution associations appear.

Existing feed **Admit and start** launches an isolated-worktree agent. Do not relabel it as non-executing Add to plan. New Add to plan is a separate #63 operation and may link a reviewed source candidate without launching. Preserve own-forge Issues versus RSS/Atom sources; no duplicated source record or implicit source close.

## 2. Main journeys and source ownership

1. Per-project workflow initialization reviews detected project/repo, chosen templates, existing guidance/validation, runtime targets and configuration diffs. Initialize does not run an agent or enable automation. Git-backed definitions and CI configuration distinguish local save from committed/pushed/host-observed activation.
2. Intake reviews an incoming source revision and possible existing/canonical work; Add to plan links a project item, starts nothing, and removes that candidate from the needs-triage view. Return to the added item in Work.
3. Inspect that same project item as Board, Table and List, including a source-specific review and ordinary T3 thread handoff once an execution exists. Restore the originating view/selection. Plan moves have an explicit reverse and do not launch or mutate the source.
4. A manual workflow run reviews the pinned workflow bytes/version AND candidate code revision, inputs, target, owner and effects. Both Factory and CI are real intended execution targets under AB:66, not CI merely meaning a later validation check. Factory uses existing orchestration/launch service; CI uses a proposed portable adapter/receipt contract. No second scheduler or imported executable DAG. Dispatch accepted, provider working, completion, findings, acceptance and delivery remain distinct.
5. Trigger bindings are first-class. A workflow version can have Manual plus automatic bindings. Cover new issue, PR-status change, CI-job-status change, integrations, custom events/webhooks, schedule and platform-native triggers. Each binding has one dispatch owner, pinned version, target, filters, input mapping and activation state. Source matching does not expand authority. Preview examples and effects before enabling.
6. T3-owned bindings and platform-native CI configuration differ. Saving local YAML/JSON does NOT activate a GitHub-owned trigger until commit/push and host observation. Do not portray T3's Pause as instantly disabling an independently owned native platform rule. Show pending activation/change where needed. T3-owned pause stops future dispatch, not already running work; manual binding remains independent.
7. Event history explains matched/filtered/duplicate/rejected/held and links to exactly one resulting invocation, if any. Ignore self-origin/echo events; duplicate delivery does not create another run. Missing input/signature/permissions or unavailable target holds before launch—no silent fallback. These are necessary trigger semantics, not a new telemetry dashboard.

### Scene ownership and cross-slice anchors

- Collections/Intake: `F5-C00` onward. Stable anchors: C00 pre-triage Board; C01 post-plan Board; C02 selected Board; C03 selected Table; C04 selected List; C05 Intake queue; C06 source triage. Use further C ids for after-triage, source review, stage-change/reverse and post-run variants as needed.
- Project workflows/execution: `F5-W00` onward. Stable anchors: W00 project workflow setup entry; W03 configured workflow list; W04 Review change v1 detail; W05 manual Factory run review; W06 manual CI run review. Define subsequent receipt/native-thread/CI result ids in the file and report them immediately to parent/siblings. Keep a source/target-consistent cancel/return. Local configuration versus shared/CI-ready can be explicit later-record state, not a Save that magically pushes.
- Triggers: `F5-T00` onward. Stable anchors: T00 workflow trigger list; T01 source catalog; T02 new-issue rule; T03 PR-status/platform-CI rule; T04 CI-job rule; T05 custom webhook/event mapping. Further ids cover review/activation, event trace, pause/reverse and platform pending activation. All three example event classes must appear concretely, not only as a paragraph promising them. A custom-event adapter/catalog must not be a hard-coded three-event enum.
- Parent: common shell/base component, source/menu/coordinator/Settings coverage, narrow and phone studies and final integration. Do not draw/own parent chrome in scene bodies.

Prefer about10–12 focused desktop scenes per slice; combine relevant controls in real forms/tables, not dozens of slides. Add a necessary state variant rather than breaking the user journey. No filler or artificial frame-count target. Main flow can start at W00 for initialization; a second flow can start C00 for everyday work. Initial setup must not be re-offered on a normal configured-workflow return. Never navigate a post-change state back into an earlier actionable state as if the action were undone. Header `navTargets` is explicit per state; omit an unmodeled link rather than inventing a destructive return. Report any unresolved cross-slice target.

## 3. Frame anatomy / source format

Use base.json as the sole fixture/token source; read its literal hashes rather than inventing abbreviated identities. Desktop frame1600×1040: app0..900, caption900..1040. Native sidebar320px is the observed resized variant (default code256px); topbar52px. Parent adds workspace tabs below it. **Body area x340..1580, y108..876**. Leave20px side/bottom breathing room. Sidebar/chrome are parent-owned and repeated from one shared implementation. Body controls32px (compact28); radius8 (compact6). UI text14, secondary12, section title18–20, code13; weights400/500/600/700. Phone targets≥44. No continuously animated decoration.

The author writes ONE JSON file per slice: `spec/collections.json`, `spec/workflows.json` or `spec/triggers.json`:

```json
{
  "schema": "t3factory-workspace-scenes/1",
  "scenes": [
    {
      "id": "F5-C02",
      "title": "Work · Board · selected",
      "shell": {
        "mode": "workspace",
        "section": "Work",
        "breadcrumb": "Work",
        "navTargets": { "Work": "F5-C01", "Intake": "F5-C07", "Workflows": "F5-W03" }
      },
      "tag": "Proposed #63 · native T3 shell",
      "caption": "State/behavior/provenance and limits; keep it short enough for three caption lines.",
      "state": {
        "selection": "plan-237",
        "view": "Board",
        "planningStage": "Ready",
        "sourceRevision": 3,
        "nativeExecution": "none"
      },
      "regions": [
        {
          "id": "item-card",
          "kind": "card",
          "box": [360, 190, 250, 150],
          "props": {
            "style": "panel",
            "lines": [
              {
                "t": "Item title",
                "x": 16,
                "y": 28,
                "s": 14,
                "w": 500,
                "c": "FG",
                "wrap": 218,
                "lh": 20
              }
            ]
          }
        },
        {
          "id": "run",
          "kind": "button",
          "box": [1320, 790, 220, 32],
          "props": {
            "variant": "primary",
            "label": "Run workflow…",
            "size": 14,
            "link": {
              "edge": "F5-CE01",
              "to": "F5-W05",
              "type": "navigate",
              "effect": "navigation"
            }
          }
        }
      ],
      "staticControls": ["Controls intentionally not part of this prototype path"]
    }
  ],
  "notes": ["Authority/source facts, cross-slice dependencies and any state variant mappings"]
}
```

### Supported primitives

- `text`: no painted box; `props.lines` as above. Baseline coordinates are relative to region box. Multiline text uses explicit `wrap` and positive `lh`, or separate lines. No text truncation for necessary evidence.
- `card`, `row`, `inspector`, `notice`, `code`, `composer`, `menu`: rectangle + lines. Styles: panel, row, row-selected, inspector, neutral, warning, success, danger, code, composer, menu, field, header. Same native palette, no novel per-slice visual language.
- `button`: variants primary, secondary, ghost, disabled, danger, hotspot. Hotspot is only over an already visible control/row, never an invisible slab. Do not overlap clickable targets. Main button widths must fit measured text +24px.
- `tag`: props label/size/role(identity,status,warning); rectangle dimensions from box.
- `rule`: horizontal rule. For table grids use actual row/cell lines and aligned text columns rather than drawing card summaries labelled Table.
- `props.shapes`: optional local rectangles/rules for table separators, switches, radio/checkbox shapes. Each shape has type rect/rule, x/y/w/h and style. Use no unsupported custom renderer kind.
- Every visual region may have `props.link` with a unique edge id, target and effect. Prefix edge ids CE/WE/TE by slice. Parent generates the named native layer `${edge} · ${label}` (label defaults to button label or region id), draws transparent hit rect last, and produces the wiring ledger. Link type navigate is default. Read-only origin returns may use type back with documented allowedOrigins; never use Back across a mutation/dispatch/enable boundary. Prefer explicit destinations where state is fixed.
- Effects: navigation, plan-change, dispatch, configuration-change, history-read, return. Configuration-change/dispatch frames are illustrative receipts only, not real execution. Mark historical/later-state study links as history-read, not an action that secretly did the work.
- Add no manual prototypeLinks duplicate: parent derives them from regions plus declared shell navigation. Do not assign Figma node ids or placements.

Use individual named regions for actual cards/rows, forms, controls, diff/file rows, toolbars and menus. Table/List/Board must genuinely look different while preserving identity. Native-style field labels, short action verbs, source/context details on demand. Instructional architecture notes go in caption/notes, not big cards occupying the app.

## 4. Coverage / verification contract

Authors do not build/render/run tests/formatters or open Figma. Parent integrates, validates text/geometry/controls/targets and renders. Independent readers inspect actual source/native PNG captures; the parent performs the integrated Figma pointer journeys. A capture-based review does not imply reviewer-driven clicks. Permanent app tests are out of scope because no application implementation occurs. Static UI, narrow and phone evidence is not responsiveness, accessibility or native-mobile parity.

All event/source/connection/time/count/hash/run values are illustrative fixtures. Never use a real token, enable a webhook/integration, dispatch CI, run a provider, change app source/Git/tracker or upload the private native T3 capture. The earlier C1r2/C3/W4 states are not spliced into a current F5 decision or origin return.
