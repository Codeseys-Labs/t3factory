# General task loop refinement

Capture an outcome, keep the same local task through analysis and delegated child
work, then review the assembled result. This Round-08 slice preserves the existing
Factory studies and optional-Linear designs.

- [Native Figma walkthrough](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=319-87&scaling=scale-down&content-scaling=fixed&page-id=4%3A80)
- [Native design entry](https://www.figma.com/design/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=319-87)
- [Navigation map](https://www.figma.com/design/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=319-1320)
- [Lifecycle map](https://www.figma.com/design/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=319-1447)
- [Self-contained source gallery](review.html)
- [Roadmap refinement and tracker crosswalk](../../roadmap.md)

## Design sources

The [task journey](task-journey/decisions.md) contains eight editable SVG screens,
their fixture/interaction manifest and measured source checks. The
[wayfinders](wayfinder/README.md) contain navigation and lifecycle graph data with
SVG, PNG and Mermaid exports. The Mermaid exports have structural/accessibility
checks; exact Mermaid rendering remains unverified.

P1–P4 express the requested priorities: core task factory, integrations, workflow
authoring with eligible machines, then optional platform CI/CD. The canonical
[Wayfinder #2](https://github.com/Codeseys-Labs/t3factory/issues/2) and
[roadmap #66](https://github.com/Codeseys-Labs/t3factory/issues/66) retain existing
milestone identities, accepted evidence and unresolved decision ownership. These
files refine their direction without publishing tracker changes or enabling work.

## Native evidence and limits

Ten native frames were imported additively below the existing studies: eight task
states and two maps. Nine in-slice prototype controls have stored reactions.
[Native evidence](native-evidence.json) binds their source hashes, Figma IDs and
the actual pointer journeys checked by the parent.

The source captions preserve their authoring-time qualification limits; the native
evidence supersedes import/navigation limits only for the named frames and controls.
Other visible controls remain outside the bounded prototype. The simple direct
task, preparation-only completion, fresh capture after completion, reopen, full
child readers, plan editing and workflow promotion still need their own state
variants. They are deliberately not wired to an unrelated successful fixture.

Functional inputs, provider execution, source writes, email/calendar actions,
persistence, responsiveness, component/auto-layout reuse, keyboard/accessibility
and mobile are not qualified. All identities, results and action receipts in the
journey are fictional. No real task, integration, hosted CI or publication ran.

## Regeneration

Run the task and map generators documented in their directories, then:

```powershell
python docs/factory/design/round-08-task-loop/build-native.py
python docs/factory/design/round-08-task-loop/build-review.py
```

The native package contains an additive Scripter import with page and duplicate
guards. It preserves the existing page nodes and puts prototype destinations at
page level. Do not run it again over the recorded R8 import. A native import or
recovery requires new inspection and evidence; regenerated source alone does not
update the existing Figma frames.
