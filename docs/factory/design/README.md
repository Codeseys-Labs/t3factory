# T3 Factory product design

T3 Factory is the application we are building from T3 Code. Work, conversations,
Intake, workflows, evidence and connections belong to that one product. Linear is
optional. A local work item retains its identity and history when linked to an issue.

The display name is **T3 Factory**; the repository/product slug is `t3factory`.
The shared screen renderer and the 21 current optional-Linear SVGs use this wordmark.
T3 Code remains the upstream attribution and the name of the pinned reference file.
This naming decision does not change runtime storage, protocol or installation identities.

## Open the design

- [Task completion and return refinement](round-09-task-return/README.md): direct tasks, preparation acceptance, fresh capture, reopened history and child reading; 13 native frames inspected and all 15 named prototype links pointer-verified.
- [General task loop and wayfinders](round-08-task-loop/README.md): the current refinement for intake, analysis, delegated child tasks and outcome review, with its native walkthrough and roadmap crosswalk.
- [Product and Interface](https://www.figma.com/design/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=180-12713)
- [Standalone and optional Linear walkthrough](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=301-86&scaling=scale-down&content-scaling=fixed&page-id=4%3A80)
- [FigJam research, flows and data hub](https://www.figma.com/board/EAR1WfaOUnegQz5aqlT2R1/T3-Factory-Research-Flows-Data?node-id=32-309)
- [Flow and authority map](https://www.figma.com/design/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=172-86)
- [Data relationships](https://www.figma.com/design/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=173-86)

These files belong to Codeseys-Labs, in the T3 Factory project. Figma keeps the native
prototype connections; Git keeps the editable SVGs, source fixtures and generators.
The Figma frames and original review captures still show the earlier wordmark.
The source branding change does not retroactively qualify new Figma exports.

## Design source

- [Experience and authority contract](round-05/spec/experience-contract.md)
- [Flow and data contract](round-05/spec/figjam.md)
- [Workflow, collection and evidence fixtures](round-05/spec/base.json), with the seven
  documents consumed by [the assembler](round-05/build/workspace_graph.py)
- [Linear UX decision](round-06-linear/decision.md) and [sync mapping](round-06-linear/sync-contract/mapping.json)
- [Standalone and optional Linear decisions](round-07-optional-linear/refined/design-decisions.md)
- [Optional-Linear baseline SVG screens](round-07-optional-linear/refined/screens)
- [Native frame bindings](round-07-optional-linear/refined/native-bindings.json) and
  [39 configured prototype interactions](round-07-optional-linear/refined/wiring-ledger.json)

The round numbers preserve source dependencies and stable frame identifiers; they are
not application modes. The earlier diagram helpers and licensed Inter fonts are retained
under `round-04/build`. The original unrefined optional-Linear generator remains a
dependency of its correcting assembler, not the current design entry point.

The [Round-08 task journey](round-08-task-loop/task-journey/decisions.md) and
[wayfinder maps](round-08-task-loop/wayfinder/README.md) extend that baseline.
Their [native evidence](round-08-task-loop/native-evidence.json) records the bounded
import and pointer checks separately from the earlier qualification history below.

## Regenerate

Use Python with Pillow installed. The bundled renderers use Chrome at its standard
Windows installation path, with `rsvg-convert` as fallback. Run from the repository root:

```powershell
python docs/factory/design/round-07-optional-linear/parent-build/refine.py
python docs/factory/design/round-05/build/build_workspace.py F5-C00
python docs/factory/design/round-05/build/build_f5_diagrams.py --svg-only
```

The first command regenerates the 21 corrected source screens and local PNGs. The
second renders one core screen; omit its ID to regenerate every core variant. The
complete assembled scene JSON and PNGs are generated output and are not checked in.
The SVGs remain editable text and geometry. Font licensing is in
`round-04/build/fonts/LICENSE.txt`.

## Evidence and limits

Before the branding change, the optional-Linear slice passed 49 actual presentation
clicks across all 39 configured controls. Twenty-one native PNGs were saved; independent
review opened 20 and the parent inspected the remaining frame. The core desktop pass
qualified its 42 requested states plus one catalog entry. These counts concern specific
static exports and fictional prototype journeys, not every generated variant.

Source branding is revised here. The original research archive retains the screenshots,
logs, exact hashes and reviews; `source-provenance.json` identifies the imported source
bytes. Debug captures, personal machine paths, temporary scripts and superseded exports
are not the product design source.

Inputs, OAuth, real Linear reads/writes, bidirectional sync, execution and persistence
are not implemented by these designs. Native components/auto-layout, live responsiveness,
keyboard/accessibility and mobile remain separately unqualified. The installed applications
still have legacy display names; their rename must preserve compatibility identities and
be verified on each client. No application rename or release is implied by this design commit.
