# General task completion and return

Eleven editable screens and two wayfinders extend the Round-08 task loop. The
[interactive source review](review.html) includes fifteen links between authored
states. It runs locally without a server; its inputs, results and actions are
fictional design fixtures.

- [Task states, decisions and regeneration](task-journey/decisions.md)
- [Navigation and lifecycle wayfinders](wayfinder/README.md)
- [Roadmap and tracker crosswalk](../../roadmap.md)
- [Native import status](native-evidence.json)
- [New intake walkthrough](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=337-651&scaling=scale-down&content-scaling=fixed&page-id=4%3A80)
- [Mixed-task review and return](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=337-87&scaling=scale-down&content-scaling=fixed&page-id=4%3A80)
- [Native navigation map](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=337-1609&scaling=scale-down&content-scaling=fixed&page-id=4%3A80) and [lifecycle map](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=337-1695&scaling=scale-down&content-scaling=fixed&page-id=4%3A80)
- [Existing verified Round-08 walkthrough](https://www.figma.com/proto/y3onOFKZMZ84W1A5uL2FQn/T3-Factory-Product-Interface?node-id=319-87&scaling=scale-down&content-scaling=fixed&page-id=4%3A80)

## What changes

A simple supplied-note request uses a direct task path, without mandatory planning
or children. New task first opens an unassigned draft; capture creates T-085 and
the saved and immediate-analysis choices preserve that identity. Preparation-only
acceptance retains drafts while showing email not sent and calendar not changed.

Reopening T-084 retains its accepted revision, artifacts and consumed action
approval and receipts. It remains idle until a new request. Closing without new
work reuses neither approval nor external action. A completed child reader exposes
its full brief, uncertainty, dependencies, model, harness, environment and attempt,
then returns to the exact originating parent.

Independent Astra review found an omitted calendar title in the action review.
The parent added the exact existing title, retained the original envelope/hash,
regenerated the evidence and inspected the corrected preview. Other inspected
branch and identity invariants passed the static review. Sol authored the task
states; Terra refined the maps and P1 roadmap semantics. All used high effort.
An Opus review was attempted but produced no design result because Claude was
rate-limited. The staged native-agent work did not run a Claude Workflow.

## Evidence and limits

Task geometry and authored branch checks passed for 11 screens, 61 named regions
and 15 source edges. The source author inspected all eleven final task PNGs; the
parent inspected the critical completion, reopen, child-reader and corrected
approval previews. Both map PNGs were inspected. Task preview typography uses
temporary derivatives of the checked-in Inter glyphs; source SVGs retain editable
text. [Render evidence](task-journey/render-evidence.json) records that boundary.

Native design navigation was verified on **November 5, 2026** in the signed-in
dedicated browser. All 13 frames were imported through the visible Scripter editor
and its Run control after the editor source hash matched the prepared package.
The parent inspected all eleven native task frames and both native maps, then
verified all fifteen named prototype controls with actual pointer clicks and
observed destination URLs. The evidence records frame identities, source hashes,
stored reactions and each pointer result. Earlier connector quota and shared-browser
automation failures were resolved by this separate browser pass.

The 36-file Round-08 source inventory remains byte-identical. Before/after native
inspection also retained its ten frames' geometry, children and reactions. R9 is
additive; its importer rejects an existing R9 marker or frame. Do not rerun the
recorded import. Regenerated sources require their own import and native proof.
Authoring-time qualification captions remain in the source SVGs; the native evidence
supersedes their import/navigation uncertainty only for the named frames and controls.

Next-cycle T-085 capture/reopening, preparation-only reopening, continuation
submission, other child readers, plan editing and workflow promotion remain outside
this bounded prototype. Runtime/persistence, connectors, mobile, accessibility and
responsive layouts remain unqualified. The design enables no integration, hosted
automation, app implementation, tracker change or publication.

## Packaging

After regenerating sources and PNGs as documented in their directories:

```powershell
python docs/factory/design/round-09-task-return/build-native.py
python docs/factory/design/round-09-task-return/build-review.py
```

The guarded Scripter importer restores a shared SVG prefix losslessly to keep the
input small; its source digest binds the original complete SVGs and control data.
It targets the existing Factory studies page, uses page-level prototype frames,
and retains existing node identities. `native-package.json` is source packaging
evidence, not proof that Figma ran it.
