# Task journey refinement

Eight editable desktop design scenes refine the local-first Work/Intake experience around one outcome. They preserve the current T3 shell, compact Inter controls, optional integrations and separate execution/acceptance/delivery states. They are design sources, not application implementation.

## Decisions

1. Capture needs only an outcome and useful context. **Capture and analyze** admits analysis under the displayed scope; **Save for later** creates local work without starting an agent. Human ownership defaults to the capturing person, with deadline and budget optional.
2. T-084 stays the same task through capture, analysis, children, attempts, review and completion. `scene-manifest.json` uses a proposed namespace-qualified local identity; it does not assert a shipped universal TaskRef contract. Source references, provider turns and workflow invocations remain associated records.
3. A focused missing-context question preserves useful work already underway. The factory proposes a plan when decomposition helps. Investigate, deep-dive, architect, plan, act and review organize the view; they are not compulsory gates.
4. Ready children advance under the standing **Research and drafts** policy. T04's primary control reads the later running state; it does not grant the same authority again. Child rows expose expected output, state, agent and dependencies. Model, harness, environment and attempt details expand when a decision needs them. The manifest holds concrete fictional assignment records for all four children.
5. Stop requested remains distinct from acknowledged stop. T06 preserves saved results and holds replacement while the earlier calendar attempt is unacknowledged. Choosing a meeting time does not acknowledge that stop or authorize an external write. T07 is an explicitly later fixture after acknowledgement and dependent drafting complete.
6. Preparation can be accepted without external actions. The alternate optional action path reviews the complete reply, recipient, subject, private calendar owner/time and absence of customer invitations. Its combined action explicitly accepts the assembled outcome and approves the reviewed actions, recording separate acceptance and approval identities. The exact fictional action envelope and its SHA-256 binding are stored in the manifest. T08 illustrates later observed receipts, rather than treating approval as proof of completion.
7. Reopening a task and promoting a successful plan into a workflow remain separate actions. Neither replays a prior send. A workflow definition alone does not enable a trigger or grant standing authority.

## Scenes and source navigation

| Scene | Purpose | Main continuation |
| --- | --- | --- |
| R8-T01 | Capture in Intake | Analyze → T03; save for later → T02 |
| R8-T02 | Durable saved task | Analyze existing T-084 → T03 |
| R8-T03 | Analysis and focused context question | Supply the illustrated time zone → T04 |
| R8-T04 | Four child tasks and dependencies | Read automatically admitted running work → T05 |
| R8-T05 | One result complete, two workers active | Open the recorded decision → T06 |
| R8-T06 | Meeting choice and stop-pending attempt details | Later assembled result → T07 |
| R8-T07 | Assembled review and optional action approval | Later confirmed receipt fixture → T08 |
| R8-T08 | Accepted outcome, artifacts and confirmed fixture receipts | Fresh capture, reopen and workflow promotion remain out of slice |

Each named control has an absolute product-coordinate box, purpose and effect in `scene-manifest.json`. Nine controls have explicit in-slice source destinations. Other controls are marked `out-of-slice`, editable design text or another explicit non-navigation kind. They must not be counted as working prototype interactions. Header navigation preserves context in the product proposal; its complete destination variants are not modeled here.

The simple direct branch is specified as capture → analysis → review → completion with no child tasks or external actions. It is **not rendered as separate input/result fixtures**. Likewise, accepting preparation only, reopening, full child readers, plan editing and workflow promotion need additional state variants before native wiring. Do not route those controls into fixtures that falsely create sends, erase state or replay prior work.

## Source and verification

The renderer imports the unmodified Round-07 `Canvas` and Round-05 native SVG/shell helpers, overrides only this slice's product content and writes only this directory. Originals remain unchanged. SVGs contain editable text and vector geometry; component/auto-layout reuse in Figma is unverified.

Run from the repository root:

```powershell
python docs/factory/design/round-08-task-loop/task-journey/build.py
python docs/factory/design/round-08-task-loop/task-journey/build.py --render
```

`--render` uses local `rsvg-convert`, not an interactive browser. `validation.json` records XML parsing, unique groups, native-text/raster inspection, measured Inter text bounds/pair intersections, control/group existence and in-slice destination existence. The focused checks passed for 8 scenes, 57 named control regions and 9 source edges. Eight local PNGs were rendered and visually opened by the source author. Parent review corrected fresh-capture identity reuse and made outcome acceptance explicit alongside action approval; the generated sources were rebuilt afterward.

This does not qualify native import, Figma wiring or actual pointer journeys, functional inputs, live responsiveness, execution/persistence, external connectors, accessibility or mobile. All task, assignment, time, person, source and receipt values are fictional. No real provider, source, email, calendar, CI job or integration was invoked.
