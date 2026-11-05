# Task return wayfinders

These proposed Round-09 maps extend the [Round-08 wayfinders](../../round-08-task-loop/wayfinder/) and [task journey](../../round-08-task-loop/task-journey/) with completion and return paths. Scene counterparts are generic design references; these maps do not assert prototype links. Existing Round-08 native evidence is bounded to its own inspected frames and controls; it does not verify these additions.

Both maps were separately imported and visually inspected in Figma on November 5.
The [Round-09 evidence](../native-evidence.json) binds their native frame IDs and
source hashes. Its fifteen verified controls belong to the task screens; map
edges remain explanatory relationships rather than clickable prototype controls.

| Map | Question | Canonical source | Exports |
| --- | --- | --- | --- |
| R9-WF01 · Navigation | Where do I return after a task? | [maps.json](maps.json) | [Mermaid](01-task-navigation.mmd), [SVG](01-task-navigation.svg), [PNG](01-task-navigation.png) |
| R9-WF02 · Lifecycle | How does the same task return a result? | [maps.json](maps.json) | [Mermaid](02-task-lifecycle.mmd), [SVG](02-task-lifecycle.svg), [PNG](02-task-lifecycle.png) |

A direct local-note task needs no forced children. Mixed work may use dependency-ready children within a valid preparation scope, without a separate approval at every phase. Accepting an exact preparation revision does not send email or change a calendar; if delivery was required, the accepted outcome must be narrowed visibly or delivery remains outstanding. An external action requires separate approval of its exact intent and an observed receipt. Unknown actions are reconciled before a duplicate.

New task opens an unassigned draft; only capture assigns a distinct identity. The old task and its history remain accessible. Reopen clears settlement on the same task while retaining prior acceptance, artifacts and receipts. It is idle without a new attempt or action until explicit new intent and valid scope; a changed result is a new revision awaiting acceptance. Reopening does not release a stop-requested writer. A child reader is read-only and returns to its exact parent context; model, harness, environment and attempt remain separate.

The [vision](../../../vision.md) and [roadmap](../../../roadmap.md) retain P1 core, P2 integrations, P3 workflows and machines, and P4 optional CI. [Decision map #2](https://github.com/Codeseys-Labs/t3factory/issues/2) and [roadmap #66](https://github.com/Codeseys-Labs/t3factory/issues/66) retain the M0–M5 and W1–W5 crosswalk. Plan and dispatch authority #63 and isolated writer ownership #65 remain separate decisions. These maps do not create another scheduler or establish runtime behavior.

## Regeneration and limits

From the repository root, run `python docs/factory/design/round-09-task-return/wayfinder/generate.py`, then convert each generated SVG to PNG with `rsvg-convert -o <png> <svg>`. The generator validates references, XML, bounds, node overlap, and edge/node intersections. SVG uses canonical coordinates; Mermaid chooses its own layout. PNG inspection and static checks are design evidence only, not native Figma navigation, accessibility conformance, implementation or qualification. A Mermaid parser and destination version were not verified.
