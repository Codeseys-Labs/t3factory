# Factory with and without Linear

This revision preserves the reviewed Round-05 product structure and adds optional source behavior. It is proposed desktop design, not application implementation or a live connector.

## Product decisions

1. Work is usable with local items. Creating a local item requires a title, local brief, human owner and local planning stage; no Linear account, issue or connection is required.
2. Connections are optional and scoped. Authorization, team/project selection, linking an existing issue, and enabling outbound status updates are separate actions.
3. Local-only collections hide Source and Source status columns. Mixed collections expose both, alongside the local Planning stage and Execution. Source status retains the tracker's exact label.
4. Linking preserves local identity, title, brief, planning and history. L-041 remains L-041 when linked to ENG-244. Unrelated L-040 also remains in the collection. A separate linked-local editor demonstrates that local content stays editable.
5. Source properties start read-only. The local brief is independent of the source description. Editing a local planning stage never silently changes a tracker status. Outbound status writes require explicit opt-in and review; they do not grant execution or delivery authority.
6. A disconnected source leaves local work and saved source details available. A timed-out request remains unknown until checked. Reconnection review is not evidence of successful authorization, a refreshed snapshot or a completed write. No automatic resend is represented.
7. Back restores the originating review context. Shared connection and brief screens use Figma's native Back action in the bounded prototype. Unmodeled context-changing routes are unwired, rather than routed to fixtures that drop or link records.

## Future integration mapping

| Factory concept                    | Linear relationship                                           | UX boundary                                                                  |
| ---------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Environment-local project          | Explicit connection scope; not a Linear team/project identity | The environment still owns local files, providers and execution              |
| Local plan item                    | Optional issue association                                    | Works without a source; retains identity after linking                       |
| Source link                        | Workspace UUID + issue UUID; identifier is display text       | Linking an existing issue does not create or authorize an issue              |
| Local title and brief              | Independent of issue title/description                        | Remain editable locally; source properties begin read-only                   |
| Planning stage                     | Separate from exact issue workflow state                      | No automatic equivalence between Ready, In Review or Done                    |
| Human owner                        | Distinct from assigned agent and execution environment        | Source owner and local owner are labeled in their own contexts               |
| Execution, acceptance and delivery | Factory-owned evidence and authority                          | A tracker status never proves execution, acceptance or permission to deliver |
| Source status update               | Explicit, scoped outbound action                              | Review baseline/current/requested; no atomic conflict-prevention claim       |
| Unknown request outcome            | Recovery state on the connection and affected item            | Preserve intent; check before deciding, without automatic replay             |

The technical integration proposal and primary research remain in `../../round-06-linear/`; this document records the design's use of those constraints.

## Bounded examples

- Standalone: R7F-01 → create R7F-02 → local inspector R7F-03 → five-item Work R7F-12. Optional setup and empty Intake return by history.
- Already connected: R7F-22 → existing issue review R7F-10 → linked local brief R7F-13 → seven-item Work R7F-04. Cancel keeps L-041 unlinked.
- Mixed creation: R7F-04 → R7F-18 → R7F-20. Cancel preserves seven items; create adds fresh L-044 while keeping linked L-041. The eight-item result is a terminal fixture.
- Recovery: R7F-16 → R7F-09 → R7F-17 → Back. The saved In Progress value and unknown Ready to Merge request stay visible.
- Local brief: 1600px R7F-05 and 1280px R7F-11 both open the separate R7F-19 editor, whose Back returns to its caller.

## Qualification boundaries

All form fields are editable Figma text, not functional prototype inputs. Save controls do not simulate successful persistence. OAuth, real source reads/writes, Intake admission, filtering, external issue URLs, full disconnected editing, other layouts, mobile, accessibility and runtime behavior remain outside this slice. No native component, variable or auto-layout reuse claim is made for the imported SVG compositions.

R7F names identify the corrected revision. Earlier R7-01 through R7-11 are preserved draft evidence and must not be used as the current journey specification. Round-05 originals and application source were not replaced.
