"""Assemble bounded static journeys with explicit snapshot and return contexts.

Context variants encode only linked collection, review and lookup paths; they are
not an application state machine. External observations live in caption links.
"""

from copy import deepcopy

import delivery_graph
import operations_graph
import council_workflows
import council_evidence
import council_collections
import council_desktop
import council_parent


def _region(scene, region_id):
    for region in scene["regions"]:
        if region["id"] == region_id:
            return region
    raise ValueError(f"{scene['id']}: required region {region_id!r} is missing")


def _link(region, target, effect="navigation", kind="navigate", **context):
    region.setdefault("props", {})["link"] = {
        "to": target, "type": kind, "effect": effect, **context,
    }


def _unlink(region):
    region.get("props", {}).pop("link", None)


def _line(text, x=16, y=28, size=14, weight=400, color="FG", wrap=None):
    value = {"t": text, "x": x, "y": y, "s": size, "w": weight, "c": color}
    if wrap is not None:
        value.update(wrap=wrap, lh=20)
    return value


def _panel(region_id, box, lines, kind="card", style="panel"):
    return {"id": region_id, "kind": kind, "box": list(box),
            "props": {"style": style, "lines": lines}}


def _button(region_id, label, box, target=None, effect="navigation", variant="secondary"):
    region = {"id": region_id, "kind": "button", "box": list(box),
              "props": {"label": label, "size": 14, "variant": variant}}
    if target is not None:
        _link(region, target, effect)
    return region


def _static(scene, region, reason):
    _unlink(region)
    if region["kind"] == "button":
        region["props"]["variant"] = "disabled"
    scene.setdefault("staticControls", []).append(f"{region['id']}: {reason}")


def _clone(scene, scene_id):
    value = deepcopy(scene)
    value["id"] = scene_id
    return value


def _study(scene, label, target):
    scene.setdefault("studyLinks", []).append(
        _button("later-observation", label, [1280, 950, 296, 32], target, "history-read")
    )


def _strip_navigation(scene):
    scene["shell"]["navTargets"] = {}
    for region in scene["regions"]:
        _unlink(region)


def _layouts(scenes, targets):
    for view, scene_id in targets.items():
        scene = scenes[scene_id]
        for index, label in enumerate(("Board", "Table", "List")):
            region_id = "layout-" + label
            existing = next((r for r in scene["regions"] if r["id"] == region_id), None)
            if existing is None:
                existing = _button(region_id, label, [730 + index * 78, 118, 72, 32])
                scene["regions"].append(existing)
            existing["props"]["variant"] = "primary" if label == view else "secondary"
            if label == view:
                _unlink(existing)
            else:
                _link(existing, targets[label])


def _unselected(scenes):
    mappings = []
    inspector_ids = {"selected-inspector", "resizable-divider", "review-source",
                     "run-workflow", "run-scope", "edit-stage"}
    for planned, board, suffix in ((False, "F5-C00", "BEFORE"), (True, "F5-C01", "ADDED")):
        targets = {"Board": board, "Table": f"F5-C03-{suffix}", "List": f"F5-C04-{suffix}"}
        for view, source in (("Table", "F5-C03"), ("List", "F5-C04")):
            scene = _clone(scenes[source], targets[view])
            scene["title"] = f"Work · {view} · {'item added' if planned else 'before triage'} · no selection"
            scene["state"] = deepcopy(scenes[board]["state"])
            scene["state"].update(view=view, returnOrigin=None)
            records = deepcopy(scenes[source]["state"]["records"])
            if not planned:
                records = [r for r in records if r["planItemRef"]["id"] != "plan-237"]
            scene["state"]["records"] = records
            scenes[board]["state"]["records"] = deepcopy(records)
            scene["shell"] = deepcopy(scenes[board]["shell"])
            scene["shell"]["navTargets"]["Work"] = scene["id"]
            scene["shell"]["navTargets"].pop("Intake", None)
            scene["regions"] = [r for r in scene["regions"] if r["id"] not in inspector_ids]
            count = len(records)
            for region in scene["regions"]:
                _unlink(region)
                props = region.setdefault("props", {})
                if props.get("style") == "row-selected":
                    props["style"] = "row"
                if region["id"] == "record-count":
                    region["props"]["lines"][0]["t"] = f"{count} project items · stage order"
                if region["id"] == "table-count":
                    region["props"]["lines"][0]["t"] = f"{count} rows · no selection"
                if region["id"].startswith(("table-", "list-")):
                    region["box"][2] = 1238
            if not planned:
                removed = _region(scene, ("table-" if view == "Table" else "list-") + "plan-237")
                y, height = removed["box"][1], removed["box"][3]
                scene["regions"].remove(removed)
                if view == "Table":
                    scene["regions"] = [r for r in scene["regions"] if r["id"] != "table-rule-0"]
                for region in scene["regions"]:
                    if region["id"].startswith(("table-", "list-")) and region["box"][1] > y:
                        region["box"][1] -= height
            else:
                _link(_region(scene, ("table-" if view == "Table" else "list-") + "plan-237"), source)
            scene["caption"] = "Same project query and planning records; changing layout selects nothing and starts nothing."
            scene["staticControls"] = ["Companion selection, query editing and sorting are static in this bounded study; Intake is linked from the unselected Board."]
            scenes[scene["id"]] = scene
        scenes[board]["staticControls"] = ["Companion selection, query editing and sorting are static in this bounded study."]
        _layouts(scenes, targets)
        mappings.append(targets)
    return mappings


def _ci_layouts(scenes):
    result = {}
    for board, label in (("F5-C14", "CI-QUEUED"), ("F5-C15", "CI-COMPLETE")):
        targets = {"Board": board, "Table": f"F5-C03-{label}", "List": f"F5-C04-{label}"}
        for view, source in (("Table", "F5-C03"), ("List", "F5-C04")):
            scene = _clone(scenes[source], targets[view])
            state = deepcopy(scenes[board]["state"])
            state.update(view=view, returnOrigin=scene["id"])
            records = deepcopy(scene["state"]["records"])
            execution = "CI queued" if board == "F5-C14" else "CI completed"
            for record in records:
                if record["planItemRef"]["id"] == "plan-237":
                    record.update(executionLabel=execution, invocationRef=state["invocationRef"],
                                  externalRunId=state["externalRunId"], nativeThreadId=None,
                                  retainedWorkRef=None)
            state["records"] = records
            scenes[board]["state"]["records"] = deepcopy(records)
            scene["state"] = state
            scene["title"] = f"Work · {view} · {execution}"
            scene["shell"]["navTargets"] = {"Work": scene["id"], "Workflows": "F5-W03"}
            scene["regions"] = [r for r in scene["regions"] if r["id"] not in
                                {"review-source", "run-workflow", "run-scope"}]
            row = _region(scene, ("table-" if view == "Table" else "list-") + "plan-237")
            for line in row["props"]["lines"]:
                if line["t"] == "Not started":
                    line["t"] = execution
            _region(scene, "selected-inspector")["props"] = deepcopy(_region(scenes[board], "selected-inspector")["props"])
            scene["regions"].append(deepcopy(_region(scenes[board], "invocation")))
            scene["staticControls"] = ["Companion selection, sorting, filters and resize are static; CI has no native thread."]
            scenes[scene["id"]] = scene
        _layouts(scenes, targets)
        scenes[board]["staticControls"] = ["Intake, companion selection, filters and resize are static for this CI snapshot."]
        result[board] = targets
    return result


def _thread(scenes, template, scene_id, work, receipt):
    scene = _clone(scenes["F5-W08"], scene_id)
    scene["regions"] = deepcopy(template)
    scene["state"].update(deepcopy(scenes[work]["state"]))
    scene["state"]["threadContext"] = {"returnTarget": work, "composer": "ordinary native thread",
                                          "owner": "Factory", "provider": "Codex"}
    scene["shell"].update(mode="thread", breadcrumb="Review change · #237", navTargets={})
    _link(_region(scene, "return-working-work"), work, "return")
    _link(_region(scene, "thread-receipt"), receipt, "history-read")
    _static(scene, _region(scene, "working-history-study"), "Run-history expansion is static in this native thread context.")
    scene["staticControls"] += ["Composer typing/send, attachment, provider/model, approvals, tools, changes and native shell controls are static."]
    scene["caption"] = "Ordinary native thread body; the pinned manual review returns to the same Work layout and selection."
    scenes[scene_id] = scene


def _execution_contexts(scenes, template, ci):
    contexts = {}
    originals = {key: deepcopy(scenes[key]) for key in ("F5-W07", "F5-W09", "F5-W10")}
    for index, view in enumerate(("Board", "Table", "List")):
        origin = ("F5-C02", "F5-C03", "F5-C04")[index]
        work = ("F5-C10", "F5-C11", "F5-C12")[index]
        receipt = "F5-W07" if index == 0 else f"F5-W07-{view.upper()}"
        queued = "F5-W09" if index == 0 else f"F5-W09-{view.upper()}"
        complete = "F5-W10" if index == 0 else f"F5-W10-{view.upper()}"
        for source, target, dest, return_region in (
            ("F5-W07", receipt, work, "return-accepted-work"),
            ("F5-W09", queued, ci["F5-C14"][view], "return-ci-queued"),
            ("F5-W10", complete, ci["F5-C15"][view], "return-ci-complete"),
        ):
            scene = _clone(originals[source], target)
            scene["state"].update(collectionOrigin=origin, returnOrigin=dest, view=view)
            scene["shell"]["navTargets"] = {} if source == "F5-W07" else {"Work": dest}
            _link(_region(scene, return_region), dest, "history-read" if source == "F5-W07" else "return")
            for region in scene["regions"]:
                if "history" in region["id"]:
                    _static(scene, region, "Additional history records are static in this bounded execution context.")
            scenes[target] = scene
        native = f"F5-P-THREAD-C{10 + index}"
        _thread(scenes, template, native, work, receipt)
        provider_observation = _region(scenes[receipt], "observe-provider")
        scenes[receipt]["regions"].remove(provider_observation)
        _study(scenes[receipt], "Later: provider thread", native)
        _link(_region(scenes[work], "invocation"), receipt, "history-read")
        _link(_region(scenes[work], "open-native-thread"), native)
        ci_observation = _region(scenes[queued], "observe-ci-result")
        scenes[queued]["regions"].remove(ci_observation)
        _study(scenes[queued], "Later: CI completion", complete)
        for board, target in (("F5-C14", queued), ("F5-C15", complete)):
            collection = scenes[ci[board][view]]
            _link(_region(collection, "invocation"), target, "history-read")
            if board == "F5-C14":
                later = next((r for r in collection["regions"] if r["id"] == "later-ci-result"), None)
                if later:
                    collection["regions"].remove(later)
                _study(collection, "Later: CI completion", complete)
        contexts[origin] = {"receipt": receipt, "queued": queued, "complete": complete}
    _thread(scenes, template, "F5-W08", "F5-C10", "F5-W07")
    return contexts


def _run_pair(scenes, origin, cancel, context, suffix, binding_state=None):
    ids = {"Factory": f"F5-W05-{suffix}", "CI": f"F5-W06-{suffix}"}
    for target, source in (("Factory", "F5-W05"), ("CI", "F5-W06")):
        scene = _clone(scenes[source], ids[target])
        scene["state"].update(collectionOrigin=origin, returnOrigin=cancel,
                              collectionContext=deepcopy(scenes[origin]["state"]))
        scene["state"].pop("automaticBindings", None)
        if binding_state is not None:
            scene["state"]["bindingSnapshot"] = deepcopy(binding_state)
            scene["state"]["collectionContext"]["bindingSnapshot"] = deepcopy(binding_state)
        scene["shell"]["navTargets"] = {}
        _link(_region(scene, "cancel-run"), cancel, "return")
        _link(_region(scene, "change-target"), ids["CI" if target == "Factory" else "Factory"])
        _link(_region(scene, "confirm-dispatch"), context["receipt" if target == "Factory" else "queued"], "dispatch")
        scenes[scene["id"]] = scene
    return ids


def _definition(scenes, base, workflow, scene_id, catalog, origin):
    if workflow["id"] == "wf-review-change":
        scene = _clone(scenes["F5-W04"], scene_id)
    else:
        name = workflow["name"]
        scene = {"id": scene_id, "title": name + " · version 1 · catalog",
                 "tag": "Proposed AB:66 · version lookup",
                 "caption": "Read-only pinned definition. Editing and additional dispatch journeys are static catalog controls, with no implied permission restriction.",
                 "shell": {"mode": "workspace", "section": "Workflows", "breadcrumb": name, "navTargets": {}},
                 "state": {}, "regions": [], "staticControls": []}
        implement = workflow["id"] == "wf-implement-issue"
        scene["regions"] = [
            _panel("page-title", [360, 118, 1200, 58], [_line(name, 0, 26, 20, 600)], "text", "none"),
            _panel("version-pin", [360, 194, 1200, 170], [
                _line(f"{name} · v{workflow['version']} · {workflow['id']}", y=28, weight=500),
                _line("Definition commit  " + base["fixtures"]["workflowSourceCommit"], y=64, size=13),
                _line("SHA-256  " + workflow["digest"], y=100, size=13),
                _line("Targets  Factory · CI", y=140),
            ]),
            _panel("definition", [360, 386, 1200, 250], [
                _line("Inputs", y=30, weight=500),
                _line("sourceRef, planItemRef, candidateCommit" if implement else "external run ref, job/step, failing head SHA, log evidence", y=70),
                _line("Implement the reviewed issue requirements in an isolated worktree." if implement else "Diagnose the failing CI job using its candidate and log evidence.", y=112),
                _line("Output: candidate change and validation evidence" if implement else "Output: diagnostic report with job/step and file/line evidence", y=154),
                _line("Merge and release require separate authority.", y=210, color="MUT"),
            ], "code", "code"),
            _button("workflow-list", "All workflows", [360, 818, 156, 32], catalog),
        ]
    scene["state"].pop("automaticBindings", None)
    scene["state"].update(workflowId=workflow["id"], workflowVersion=workflow["version"],
                          workflowDigest=workflow["digest"], workflowSourceCommit=base["fixtures"]["workflowSourceCommit"],
                          lookupOrigin=origin, collectionContext=deepcopy(scenes[origin]["state"]),
                          bindingSnapshot=deepcopy(scenes[origin]["state"]["bindingSnapshot"]))
    selection = scenes[origin]["state"].get("selection")
    selected_237 = isinstance(selection, dict) and selection.get("id") == base["fixtures"]["planItem"]["id"]
    if workflow["id"] == "wf-review-change" and not selected_237:
        _region(scene, "version-pin")["props"]["lines"] = [
            line for line in _region(scene, "version-pin")["props"]["lines"]
            if not line["t"].startswith("Candidate commit")
        ]
        _region(scene, "input-contract")["props"]["lines"] = [
            _line("Input contract", y=28, weight=500),
            _line("sourceRef · planItemRef · candidateCommit", y=60),
            _line("A run review binds concrete inputs separately.", y=86, size=12, color="MUT"),
        ]
    scene["shell"]["navTargets"] = {}
    _link(_region(scene, "workflow-list"), catalog)
    scenes[scene_id] = scene
    return scene


def _binding_rows(snapshot, destinations):
    rows = [_panel("bindings-heading", [360, 118, 1200, 58], [
        _line("Trigger bindings", 0, 26, 20, 600),
        _line("Snapshot: " + snapshot["id"], 0, 50, 12, color="MUT"),
    ], "text", "none")]
    for index, (key, record) in enumerate(snapshot["records"].items()):
        row = _panel("binding-" + key, [360, 186 + index * 72, 1200, 64], [
            _line(record["sourceType"] + " · " + record["bindingId"], y=24, weight=500),
            _line(record["workflowName"] + " v1 · " + record["target"] + " · " + record["dispatchOwner"],
                  y=49, size=12, color="MUT"),
            _line(record["bindingState"], x=930, y=30, size=13, wrap=250),
        ], "row", "row")
        _link(row, destinations[key])
        rows.append(row)
    return rows


def _binding_lookup(scenes, origin, return_to, scene_id):
    snapshot = deepcopy(scenes[origin]["state"]["bindingSnapshot"])
    scene = _clone(scenes["F5-T-CONFIG"], scene_id)
    scene["title"] = "Trigger bindings · current records"
    scene["shell"]["navTargets"] = {}
    scene["state"] = {"readOnly": True, "lookupOrigin": origin,
                      "collectionContext": deepcopy(scenes[origin]["state"]),
                      "bindingSnapshot": snapshot,
                      "bindings": {key: record["bindingState"] for key, record in snapshot["records"].items()}}
    destinations = {}
    for key, record in snapshot["records"].items():
        status_id = record["bindingState"].upper().replace(" / ", "-").replace(" ", "-")
        detail_id = "F5-T-RECORD-" + key + "-" + status_id
        destinations[key] = detail_id
        if detail_id in scenes:
            detail = scenes[detail_id]
            _region(detail, "lookup-return")["props"]["link"]["allowedOrigins"].append(scene_id)
            continue
        detail = _clone(scenes["F5-T-EDIT-" + key], detail_id)
        detail["title"] = record["sourceType"] + " · " + record["bindingState"]
        detail["state"] = {**deepcopy(record), "readOnly": True,
                           "returnPolicy": "Native history for read-only record inspection; caller retains its complete snapshot"}
        detail["shell"]["navTargets"] = {}
        detail.pop("studyLinks", None)
        detail["regions"] = [r for r in detail["regions"] if r["id"] not in {"back", "review", "manual-run"}]
        _region(detail, "title")["props"]["lines"][1]["t"] = record["bindingId"] + " · " + record["bindingState"]
        if record["bindingState"] == "Paused":
            _region(detail, "review-effects")["props"]["lines"] = [
                _line("Paused: future admissions held; active work is not cancelled. Manual available; independent host rules unaffected.", y=14, size=13)]
        elif record["bindingState"] == "Pending host activation":
            _region(detail, "review-effects")["props"]["lines"] = [
                _line("Saved locally; pending commit / push / host observation. The native CI rule is not active; no invocation.", y=14, size=13)]
        back = _button("lookup-return", "Back to bindings", [360, 836, 210, 32])
        _link(back, scene_id, "return", "back", allowedOrigins=[scene_id])
        detail["regions"].append(back)
        detail["caption"] = ("Read-only binding record · " + record["bindingState"] + ". Configuration changes and another run are not linked in this prototype. The complete caller and binding snapshot are retained.")
        scenes[detail_id] = detail
    scene["regions"] = _binding_rows(snapshot, destinations) + [
        _button("lookup-return", "Back to workflows", [360, 818, 210, 32], return_to, "return"),
    ]
    scene["caption"] = "Current project binding records, independent of layout and execution. Configuration changes and another run are not linked in this prototype."
    scene["staticControls"] = ["Configuration changes and another run are prototype-static, not a permission or eligibility restriction."]
    scenes[scene_id] = scene
    return scene_id


def _source_contexts(scenes):
    for origin in ("F5-C02", "F5-C03", "F5-C04"):
        source_id = "F5-C08-FROM-" + origin.removeprefix("F5-")
        source = _clone(scenes["F5-C08"], source_id)
        source["state"]["returnOrigin"] = origin
        source["state"]["collectionContext"] = deepcopy(scenes[origin]["state"])
        source["shell"]["navTargets"] = {"Workflows": "F5-W03"}
        _link(_region(source, "return-origin"), origin, "return")
        view = scenes[origin]["state"]["view"]
        _region(source, "view-plan")["props"]["label"] = "Show selected " + view
        _link(_region(source, "view-plan"), origin, "return")
        scenes[source_id] = source
        _link(_region(scenes[origin], "review-source"), source_id)
    scenes["F5-C08"]["state"]["returnOrigin"] = "F5-C02"
    _link(_region(scenes["F5-C08"], "return-origin"), "F5-C02", "return")


def _catalogs(scenes, base, execution):
    origins = [s["id"] for s in scenes.values() if s["id"].startswith("F5-C")
               and s["shell"].get("navTargets", {}).get("Workflows") == "F5-W03"]
    for origin in origins:
        catalog_id = "F5-W03-FROM-" + origin.removeprefix("F5-")
        catalog = _clone(scenes["F5-W03"], catalog_id)
        catalog["state"].pop("automaticBindings", None)
        catalog["state"].update(lookupOrigin=origin, collectionContext=deepcopy(scenes[origin]["state"]))
        catalog["shell"]["navTargets"] = {}
        _link(_region(catalog, "return-work-context"), origin, "return")
        scenes[catalog_id] = catalog
        scenes[origin]["shell"]["navTargets"]["Workflows"] = catalog_id
        initial = {"F5-C02": "F5-T-CONFIG", "F5-C03": "F5-T-CONFIG-C03", "F5-C04": "F5-T-CONFIG-C04"}
        binding = initial.get(origin)
        if binding is None:
            binding = scenes[origin]["state"].get("currentBindingList")
        if binding is None:
            binding = _binding_lookup(scenes, origin, catalog_id, catalog_id + "-BINDINGS")
        catalog["state"]["bindingSnapshot"] = deepcopy(scenes[binding]["state"]["bindingSnapshot"])
        detail_ids = {}
        for workflow in base["workflowCatalog"]:
            key = workflow["id"]
            detail_id = catalog_id + "-" + key.removeprefix("wf-").upper()
            detail = _definition(scenes, base, workflow, detail_id, catalog_id, origin)
            detail_ids[key] = detail_id
            if key == "wf-review-change":
                if origin in execution:
                    runs = _run_pair(scenes, origin, detail_id, execution[origin], "CAT-" + origin)
                    _link(_region(detail, "review-factory"), runs["Factory"])
                    _link(_region(detail, "review-ci"), runs["CI"])
                else:
                    for name in ("review-factory", "review-ci"):
                        _static(detail, _region(detail, name), "Another dispatch is static in this read-only lookup; no business restriction is implied.")
                trigger = _region(detail, "triggers")
                trigger["props"]["label"] = "Triggers"
                _link(trigger, binding)
        for region_id, workflow_id in (("review-row", "wf-review-change"),
                                       ("implement-row", "wf-implement-issue"), ("diagnose-row", "wf-diagnose-ci")):
            _link(_region(catalog, region_id), detail_ids[workflow_id])
        catalog["regions"] = [r for r in catalog["regions"] if r["id"] != "open-review"]
        control = _region(catalog, "open-trigger-bindings")
        control["props"]["label"] = "View bindings"
        _link(control, binding)
    return origins


def _nested_lookups(scenes, base):
    workflow_ids = {"F5-T02": "wf-implement-issue", "F5-T04": "wf-diagnose-ci"}
    workflows = {w["id"]: w for w in base["workflowCatalog"]}
    for number in (2, 3, 4, 5, 11):
        origin = f"F5-T{number:02d}"
        scene = scenes[origin]
        region = _region(scene, f"t{number:02d}-open-wf")
        workflow = workflows[workflow_ids.get(origin, "wf-review-change")]
        detail_id = origin + "-VERSION-LOOKUP"
        detail = _definition(scenes, base, workflow, detail_id, origin, origin)
        _region(detail, "workflow-list")["props"]["label"] = "Back to binding"
        _link(_region(detail, "workflow-list"), origin, "return")
        for control in detail["regions"]:
            if control["id"] in {"triggers", "review-factory", "review-ci"}:
                _static(detail, control, "Static in this historical version lookup; the calling binding snapshot is preserved.")
        _link(region, detail_id, "history-read")
    ci_record = _clone(scenes["F5-W10"], "F5-T07-CI-RECORD")
    ci_record["state"].update(readOnlyRecord=True, lookupOrigin="F5-T07")
    ci_record["shell"]["navTargets"] = {}
    _region(ci_record, "return-ci-complete")["props"]["label"] = "Back to history"
    _link(_region(ci_record, "return-ci-complete"), "F5-T07", "return")
    _static(ci_record, _region(ci_record, "run-history"), "Additional history navigation is static inside this external CI record lookup.")
    ci_record["caption"] = "Read-only external run19541 record explains the ignored echo; returning restores automatic event history, without changing plan-238 or creating a thread."
    scenes[ci_record["id"]] = ci_record
    _link(_region(scenes["F5-T07"], "t07-row-7746"), ci_record["id"], "history-read")
    root = scenes["F5-W03"]
    root["shell"]["navTargets"] = {}
    _static(root, _region(root, "return-work-context"), "Standalone configured catalog has no collection origin; use a collection entrypoint to restore Work.")
    bindings = _binding_lookup(scenes, "F5-W03", "F5-W03", "F5-W03-BINDINGS")
    _region(root, "open-trigger-bindings")["props"]["label"] = "View bindings"
    _link(_region(root, "open-trigger-bindings"), bindings)
    _link(_region(root, "review-row"), "F5-W04")
    root["regions"] = [r for r in root["regions"] if r["id"] != "open-review"]
    for workflow_id, region_id in (("wf-implement-issue", "implement-row"), ("wf-diagnose-ci", "diagnose-row")):
        detail_id = "F5-W03-" + workflow_id.removeprefix("wf-").upper()
        _definition(scenes, base, workflows[workflow_id], detail_id, "F5-W03", "F5-W03")
        _link(_region(root, region_id), detail_id)
    detail = scenes["F5-W04"]
    detail["shell"]["navTargets"] = {}
    _region(detail, "triggers")["props"]["label"] = "Triggers"
    _link(_region(detail, "triggers"), "F5-W04-BINDINGS")
    _binding_lookup(scenes, "F5-W04", "F5-W04", "F5-W04-BINDINGS")
    for region_id in ("review-factory", "review-ci"):
        _static(detail, _region(detail, region_id), "Standalone version catalog; linked run reviews begin at the selected project item.")
    _region(detail, "input-contract")["props"]["lines"] = [
        _line("Input contract", y=28, weight=500),
        _line("sourceRef · planItemRef · candidateCommit", y=60),
        _line("Choose a planned item before binding concrete run inputs.", y=86, size=12, color="MUT"),
    ]
    _region(detail, "version-pin")["props"]["lines"] = [
        line for line in _region(detail, "version-pin")["props"]["lines"]
        if not line["t"].startswith("Candidate commit")
    ]
    for scene_id in ("F5-W05", "F5-W06"):
        scenes[scene_id]["state"]["returnOrigin"] = "F5-W04"
        _link(_region(scenes[scene_id], "cancel-run"), "F5-W04", "return")
    for owner in ("F5-P-MORE", "F5-P-ISSUES", "F5-P-BRIEFS", "F5-P-RESEARCH", "F5-P-SOURCES", "F5-P-SETTINGS"):
        for control in scenes[owner]["regions"]:
            link = control.get("props", {}).get("link")
            if link and link.get("to") in ("F5-W03", "F5-W04", "F5-W05", "F5-W06", "F5-T00"):
                _static(scenes[owner], control, "This nested source-owner control is static; use the context-bound collection workflow entrypoint.")


def _input_example(base, automatic=False):
    source = {key: base["fixtures"]["sourceIssue"][key]
              for key in ("provider", "repository", "number", "revision")}
    plan = deepcopy(base["fixtures"]["planItem"])
    if automatic:
        source.update(number=base["fixtures"]["automaticSourceIssue"], revision=1)
        plan["id"] = base["fixtures"]["automaticPlanItemId"]
    return {"sourceRef": source, "planItemRef": plan,
            "candidateCommit": base["fixtures"]["candidateCommit"],
            "candidateRepository": base["project"]["repository"]}


def _binding_records(base):
    workflows = {w["id"]: w for w in base["workflowCatalog"]}
    choices = [
        ("MANUAL", "Manual", "wf-review-change", "Factory / CI", "Mara · reviewed invocation",
         "Explicit actor review; concrete source, plan and candidate required"),
        ("ISSUE", "Platform-native · new issue", "wf-implement-issue", "Factory", "T3 trigger service",
         "repository=acme/factory; action=opened; labels=any; exclude self-origin"),
        ("PR", "Platform-native · PR status", "wf-review-change", "CI", "GitHub Actions native rule",
         "repository=acme/factory; action=ready_for_review; draft=false; exclude self-origin"),
        ("CI", "Platform-native · CI job status", "wf-diagnose-ci", "Factory", "T3 trigger service",
         "repository=acme/factory; conclusion=failure; exclude T3 invocation run echoes"),
        ("SCHEDULE", "Schedule", "wf-review-change", "Factory", "ScheduledTasksManager",
         "0 9 * * *; timezone=America/Los_Angeles; project-factory"),
        ("INTEGRATION", "Integration event", "wf-review-change", "Factory", "T3 trigger service",
         "adapter=forge-connector; project=project-factory; event=review-requested"),
        ("CUSTOM", "Custom event", "wf-review-change", "Factory", "T3 trigger service",
         "adapter=docs-tool; event=docs-rebuild-requested; project=project-factory"),
        ("WEBHOOK", "Signed webhook", "wf-review-change", "Factory", "T3 trigger service",
         "HMAC-SHA-256 X-Signature-256; project=project-factory; type=docs-rebuild-requested"),
    ]
    mappings = {
        "MANUAL": {
            "sourceRef": "explicit reviewed source revision",
            "planItemRef": "explicit qualified plan linked to that source",
            "candidateCommit": "explicit full commit in acme/factory",
        },
        "ISSUE": {
            "sourceRef": "1. Resolve event provider / repository / issue number / revision",
            "planItemRef": "2. Resolve existing or reserve non-executing plan under reviewed issue-admission authority",
            "candidateCommit": "3. Resolve repository default branch before dispatch; freeze full starting commit",
        },
        "PR": {
            "sourceRef": "Resolve the PR reviewed source-revision link (example: issue #237 revision 3)",
            "planItemRef": "Resolve the qualified existing plan linked to that source in env-ws / project-factory",
            "candidateCommit": "Resolve pull_request.head.sha as a full commit in acme/factory before dispatch",
        },
        "CI": {
            "externalRunRef": "run.id + repository + owner → external run reference",
            "jobStep": "job / step → diagnostic focus",
            "candidateCommit": "Resolve head_sha in acme/factory; freeze failing commit",
            "logEvidence": "Resolve log_url to retained run / job / step evidence",
        },
        "SCHEDULE": {
            "sourceRef": "Fixed reviewed github / acme/factory / #237 / revision 3",
            "planItemRef": "Fixed planned / env-ws / project-factory / plan-237",
            "candidateCommit": "Resolve acme/factory refs/heads/main at each occurrence, before dispatch",
        },
        "INTEGRATION": {
            "sourceRef": "Resolve event.sourceRef to its immutable source revision",
            "planItemRef": "Resolve payload.planItemRef in env-ws / project-factory; verify its source link",
            "candidateCommit": "Resolve payload.head_sha as a full commit in acme/factory before dispatch",
        },
        "CUSTOM": {"sourceRef": "payload.sourceRef", "planItemRef": "payload.planItemRef",
                   "candidateCommit": "payload.candidateCommit"},
        "WEBHOOK": {"sourceRef": "$.payload.sourceRef", "planItemRef": "$.payload.planItemRef",
                    "candidateCommit": "$.payload.candidateCommit"},
    }
    records = {}
    for key, label, workflow_id, target, owner, filters in choices:
        workflow = workflows[workflow_id]
        record = {
            "bindingId": "binding-" + key.lower(), "sourceType": label,
            "bindingState": "Available" if key == "MANUAL" else "Draft / Off",
            "workflowId": workflow_id, "workflowName": workflow["name"], "workflowVersion": workflow["version"],
            "workflowDigest": workflow["digest"], "workflowSourceCommit": base["fixtures"]["workflowSourceCommit"],
            "target": target, "dispatchOwner": owner, "filters": filters,
            "inputMapping": mappings[key], "requiredInputs": list(mappings[key]),
            "resolvedExample": _input_example(base, key == "ISSUE"), "exampleOnly": True,
            "exampleValidation": "Source revision resolves; qualified plan belongs to project and links to source; commit resolves in authorized repository",
            "failurePolicy": "Held · missing, unresolved or mismatched required input · no invocation; name the offending input",
            "invalidConfiguration": "Draft / Off; Enable unavailable with inline mapping/example reason",
            "laterInvalidDelivery": "Held with reason and no invocation; valid binding remains Enabled",
            "selectionFallback": False, "invocationRef": None, "nativeThreadId": None,
            "manualAvailable": True, "independentHostRules": "unaffected",
            "dedupe": "bindingId + " + ("occurrence.id" if key == "SCHEDULE" else "delivery.id" if key == "WEBHOOK" else "event.id"),
            "reviewedEffects": "Future authorized matches dispatch once. No run now. No merge or release grant.",
        }
        if key == "MANUAL":
            record["reviewedEffects"] = "Explicit actor confirmation only; automatic bindings may be paused. Cancel creates no invocation. No merge or release grant."
        elif key == "ISSUE":
            record.update(
                planAdmissionAuthority="Reviewed proposed #63 issue-admission policy: resolve or reserve a non-executing plan before dispatch",
                resolutionOrder=["resolve source revision", "resolve or reserve qualified plan", "resolve starting commit", "freeze input snapshot", "dispatch"],
                candidateProvenance={"repository": "acme/factory", "selector": "repository default branch",
                                     "resolvedBranch": "refs/heads/main", "resolvedCommit": base["fixtures"]["candidateCommit"],
                                     "resolvedBeforeDispatch": True, "fixtureOnly": True},
                reviewedEffects="For each authorized matching issue, resolve or create its plan item, admit and start Implement issue from the resolved starting commit. No merge or release grant.")
        elif key == "SCHEDULE":
            record.update(fixedSourceRef=deepcopy(record["resolvedExample"]["sourceRef"]),
                          fixedPlanItemRef=deepcopy(record["resolvedExample"]["planItemRef"]),
                          candidateSelector="refs/heads/main", resolveCandidate="at each occurrence before dispatch",
                          reviewedEffects="Review the selected planned item at the scheduled branch revision. Each occurrence freezes its own inputs before dispatch; no merge or release.")
        elif key == "WEBHOOK":
            record.update(signaturePolicy="Invalid signature · rejected before mapping · no invocation",
                          endpoint="https://hooks.example.invalid/t3/factory")
        elif key == "CI":
            record["exampleValidation"] = "External run owner and repository resolve; job/step and failing commit resolve; retained log evidence matches the run and step"
            record["resolvedExample"] = {
                "externalRunRef": {"owner": "GitHub Actions", "repository": "acme/factory", "id": "19553"},
                "jobStep": "build / compile", "candidateCommit": base["fixtures"]["candidateCommit"],
                "candidateRepository": "acme/factory", "logEvidence": "retained run 19553 / build / compile log",
            }
        records[key] = record
    return {"id": "initial-reviewed-fixture", "records": records}


def _changed_snapshot(initial, key, status):
    snapshot = deepcopy(initial)
    snapshot["id"] = "binding-" + key.lower() + "-" + status.lower().replace(" ", "-")
    snapshot["records"][key]["bindingState"] = status
    if key == "PR":
        snapshot["records"][key].update(localSave=True, committed=status == "Enabled",
                                        pushed=status == "Enabled", hostObserved=status == "Enabled")
    return snapshot


def _binding_form(record, key):
    mapping = [_line("Required input mapping · resolve and freeze before dispatch", y=24, weight=500)]
    mapping += [_line(name + " ← " + rule, y=50 + index * 24, size=13)
                for index, (name, rule) in enumerate(record["inputMapping"].items())]
    if len(record["inputMapping"]) == 3:
        mapping.append(_line("Validate source revision, plan project/source link and repository commit; hold missing, unresolved or mismatched inputs.",
                             y=124, size=12, color="MUT"))
    metadata = "Type is a filter; " + record["dedupe"] + " deduplicates. Title/path are optional context, never workflow inputs."
    if key == "ISSUE":
        metadata = "Default-branch example: refs/heads/main. Resolve source → reserve plan → freeze starting commit before dispatch."
    elif key == "SCHEDULE":
        metadata = "Example only. Each occurrence resolves and records its own commit before dispatch. No collection-selection fallback."
    elif key == "CI":
        metadata = "Ignore self-origin run echoes; missing candidate or log evidence: Held · no invocation."
    mapping.append(_line(metadata, y=148, size=12, color="MUT"))
    example = record["resolvedExample"]
    preview = [_line("Resolved example · no event sent · no invocation", y=24, weight=500)]
    if key == "CI":
        preview += [
            _line("External run: GitHub Actions / acme/factory / 19553 · build / compile", y=48, size=13),
            _line("Evidence: retained run 19553 / build / compile log", y=72, size=13),
        ]
    else:
        source, plan = example["sourceRef"], example["planItemRef"]
        preview += [
            _line(f"Source: {source['provider']} / {source['repository']} / #{source['number']} / revision {source['revision']}", y=48, size=13),
            _line(f"Plan: {plan['kind']} / {plan['environmentId']} / {plan['projectId']} / {plan['id']}", y=72, size=13),
        ]
    candidate_label = "Resolved example commit" if key == "SCHEDULE" else "Starting commit" if key == "ISSUE" else "Candidate"
    preview.append(_line(candidate_label + ": acme/factory @ " + example["candidateCommit"], y=96, size=13))
    result = "All required inputs resolve. A matching authorized delivery would dispatch one " + record["workflowName"] + " invocation."
    failure = "Held · missing or unresolved required input (e.g. candidateCommit), or sourceRef / planItemRef mismatch · no invocation"
    if key == "SCHEDULE":
        result = "At 09:00, resolve acme/factory refs/heads/main, freeze the inputs, then dispatch one Review change invocation if all inputs resolve."
        failure = "Held · selected source/plan or branch revision cannot be resolved · no invocation"
    elif key == "PR":
        result = "PR #236 ready_for_review links reviewed source #237 rev 3 and plan-237; head resolves. One CI review after host activation."
    elif key == "MANUAL":
        result = "Source revision, plan-source link and repository commit resolve. Explicit actor confirmation dispatches one invocation; Cancel dispatches none."
    elif key == "CI":
        failure = "Held · unresolved failing commit or log evidence · no invocation; passed jobs and T3-origin run echoes are ignored."
    preview += [_line(result, y=120, size=13, wrap=1168),
                _line(failure, y=160, size=13, color="MUT")]
    if key == "WEBHOOK":
        preview.append(_line("Policy: invalid signatures are rejected before mapping; no invocation", y=180, size=13, color="WARN"))
    fields = [
        _panel("title", [360, 118, 1200, 58], [_line(record["sourceType"], 0, 26, 20, 600),
               _line(record["bindingId"], 0, 50, 12, color="MUT")], "text", "none"),
        _panel("filters", [360, 184, 760, 108], [
            _line("Source / filters", y=24, size=12, color="MUT"),
            _line(record["filters"], y=48, size=14, wrap=724),
            _line("Authorized repository: acme/factory · env-ws / project-factory", y=92, size=12),
        ]),
        _panel("owner", [1140, 184, 420, 108], [
            _line("Target: " + record["target"], y=26),
            _line("Owner: " + record["dispatchOwner"], y=54, size=13),
            _line("Manual independent · no target fallback", y=88, size=12, color="MUT"),
        ]),
        _panel("version", [360, 304, 1200, 104], [
            _line(record["workflowName"] + " · v1", y=26, weight=500),
            _line("SHA-256  " + record["workflowDigest"], y=56, size=13),
            _line("Definition commit  " + record["workflowSourceCommit"], y=86, size=13, color="MUT"),
        ]),
        _panel("mapping", [360, 420, 1200, 160], mapping, "code", "code"),
        _panel("preview", [360, 592, 1200, 196], preview),
        _panel("review-effects", [360, 792, 1200, 36], [
            _line(record["reviewedEffects"], y=14, size=13, wrap=1168),
        ], "text", "none"),
    ]
    if key == "WEBHOOK":
        _region({"regions": fields}, "filters")["props"]["lines"][-1]["t"] = "Endpoint: " + record["endpoint"]
        _region({"regions": fields}, "owner")["props"]["lines"][-1]["t"] = "Signing credential  ••••••••"
    return fields


def _snapshot_work(scenes, origin, snapshot, suffix):
    work_id = origin + "-BINDING-" + suffix
    work = _clone(scenes[origin], work_id)
    _strip_navigation(work)
    work.pop("studyLinks", None)
    work["state"].update(bindingSnapshot=deepcopy(snapshot), returnOrigin=work_id,
                         collectionOrigin=origin, prototypeReadOnlyClosure=True)
    work["shell"]["navTargets"] = {"Workflows": "F5-W03"}
    work["caption"] = "Current Work snapshot after binding change; query, selection, source and execution retained. Layout switching, further mutations and another run are prototype-static. Reopen Workflows → Triggers to inspect current bindings."
    for region in work["regions"]:
        if region["kind"] == "button" and region["props"].get("variant") != "hotspot":
            selected_layout = (region["props"].get("label") in ("Board", "Table", "List")
                               and region["props"].get("variant") == "primary")
            _static(work, region, "Prototype-static return closure; no permission restriction.")
            if selected_layout:
                region["props"]["variant"] = "primary"
    scenes[work_id] = work
    return work_id


def _configuration(scenes, base, execution):
    initial = _binding_records(base)
    for item in scenes.values():
        item["state"]["bindingSnapshot"] = deepcopy(initial)
    issue_enabled = _changed_snapshot(initial, "ISSUE", "Enabled")
    scenes["F5-C13"]["state"]["bindingSnapshot"] = deepcopy(issue_enabled)

    def scene(scene_id, title, origin, snapshot, regions, caption):
        value = {"id": scene_id, "title": title, "tag": "Proposed AB:66 · trigger configuration",
                 "shell": {"mode": "workspace", "section": "Workflows", "breadcrumb": "Trigger bindings", "navTargets": {}},
                 "state": {"projectId": base["project"]["id"], "environmentId": base["project"]["environmentId"],
                           "collectionContext": deepcopy(scenes[origin]["state"]), "bindingSnapshot": deepcopy(snapshot),
                           "invocationRef": None, "newIssueInvocation": None},
                 "regions": regions, "caption": caption, "staticControls": []}
        scenes[scene_id] = value
        return value

    for key, record in initial["records"].items():
        example_caption = (
            "External run owner/repository, job/step, failing commit and retained log evidence resolve in the fixture."
            if key == "CI" else "Source revision, plan-source link and repository commit resolve in the fixture."
        )
        draft = scene("F5-T-EDIT-" + key, record["sourceType"] + " · draft configuration", "F5-C02", initial,
                      _binding_form(record, key),
                      "Prefilled fictional configuration and complete successful example. " + example_caption + " Invalid mapping/example keeps Draft/Off with Enable unavailable and an inline reason. No selection fallback.")
        draft["state"].update(deepcopy(record))
        draft["staticControls"] = ["Typing, alternate mappings and malformed-form variants are prototype-static; only the valid reviewed example is linked."]

    def closure(record_scene, origin, snapshot, suffix):
        work_id = _snapshot_work(scenes, origin, snapshot, suffix)
        catalog_id = "F5-W03-FROM-" + work_id.removeprefix("F5-")
        list_id = record_scene["id"] + "-BINDINGS"
        scenes[work_id]["state"]["currentBindingList"] = list_id
        _binding_lookup(scenes, work_id, catalog_id, list_id)
        scenes[list_id]["regions"].append(_button("return-work", "Return to Work", [1350, 818, 210, 32], work_id, "return"))
        record_scene["regions"].append(_button("current-bindings", "Current bindings", [650, 836, 210, 32], list_id, "return"))
        record_scene["state"]["currentWork"] = work_id
        return work_id

    for origin in ("F5-C02", "F5-C03", "F5-C04"):
        suffix = "" if origin == "F5-C02" else "-" + origin.removeprefix("F5-")
        root, sources = "F5-T-CONFIG" + suffix, "F5-T-SOURCES" + suffix
        destinations = {key: "F5-T-EDIT-" + key + suffix for key in initial["records"]}
        listing = scene(root, "Trigger bindings · Draft / Off", origin, initial,
                        _binding_rows(initial, destinations),
                        "Initial project binding snapshot: Manual Available; seven automatic records Draft/Off. Configuration is project-scoped and independent of layout. No delivery or invocation exists.")
        listing["state"]["bindings"] = {key: record["bindingState"] for key, record in initial["records"].items()}
        listing["regions"] += [
            _button("source-catalog", "Add binding…", [360, 818, 180, 32], sources),
            _button("back-workflows", "Back to workflows", [580, 818, 210, 32], "F5-W03-FROM-" + origin.removeprefix("F5-"), "return"),
            _button("return-work", "Return to Work", [1350, 818, 210, 32], origin, "return"),
        ]
        source_rows = [_panel("title", [360, 118, 1200, 58], [_line("Choose trigger source", 0, 26, 20, 600)], "text", "none")]
        source_rows += [_button("source-" + key, record["sourceType"], [360, 186 + index * 72, 760, 48], destinations[key])
                        for index, (key, record) in enumerate(initial["records"].items())]
        source_rows.append(_button("back", "Back to bindings", [360, 818, 210, 32], root, "return"))
        scene(sources, "Trigger source catalog", origin, initial, source_rows,
              "Eight first-activation examples from one project snapshot. Registered custom adapters are extensible; alternate values and installation are prototype-static.")
        for key, record in initial["records"].items():
            edit = destinations[key]
            draft = _clone(scenes["F5-T-EDIT-" + key], edit)
            draft["state"]["collectionContext"] = deepcopy(scenes[origin]["state"])
            draft["regions"] = [r for r in draft["regions"] if r["id"] not in {"back", "review", "manual-run"}]
            draft["regions"].append(_button("back", "Back to bindings", [360, 836, 210, 32], root, "return"))
            scenes[edit] = draft
            if key == "MANUAL":
                runs = _run_pair(scenes, origin, edit, execution[origin], "CONFIG-MANUAL" + suffix, initial)
                draft["regions"].append(_button("manual-run", "Review manual run…", [1280, 836, 280, 32], runs["Factory"], variant="primary"))
                draft["title"] = "Manual binding · explicit run review"
                continue
            review, enabled = "F5-T-REVIEW-" + key + suffix, "F5-T-ENABLED-" + key + suffix
            draft["regions"].append(_button("review", "Review activation…", [1280, 836, 280, 32], review, variant="primary"))
            reviewed = _clone(draft, review)
            reviewed["title"] = record["sourceType"] + " · activation review"
            reviewed["state"].update(bindingState="Reviewing · Off", mappingValidated=True, enableAvailable=True)
            _region(reviewed, "back")["props"]["label"] = "Edit configuration"
            _link(_region(reviewed, "back"), edit, "return")
            _region(reviewed, "review")["props"]["label"] = "Save native CI config" if key == "PR" else "Enable binding"
            _link(_region(reviewed, "review"), enabled, "configuration-change")
            reviewed["caption"] = "Review the full mapping, qualified successful example and future authority. Enable/save creates no invocation. A later missing or mismatched delivery is Held with its offending input named, without changing this valid binding to Draft."
            scenes[review] = reviewed
            status = "Pending host activation" if key == "PR" else "Enabled"
            changed = _changed_snapshot(initial, key, status)
            active = _clone(draft, enabled)
            active["state"].update(bindingState=status, bindingSnapshot=deepcopy(changed), invocationRef=None)
            active["state"]["collectionContext"]["bindingSnapshot"] = deepcopy(changed)
            active["title"] = record["sourceType"] + " · " + status + " · no invocation"
            active["regions"] = [r for r in active["regions"] if r["id"] not in {"back", "review"}]
            _region(active, "title")["props"]["lines"][1]["t"] = record["bindingId"] + " · " + status + " · no invocation"
            active["caption"] = "Configuration changed; no invocation. Current bindings → Work → Workflows → Triggers retains this snapshot. Further changes and dispatches are prototype-static except the explicitly linked named studies."
            scenes[enabled] = active
            closure(active, origin, changed, key + "-ENABLED")
            if key == "PR":
                active["state"].update(localSave=True, committed=False, pushed=False, hostObserved=False)
                _region(active, "review-effects")["props"]["lines"] = [
                    _line("Saved locally; host rule is not active. Pending commit / push / host observation; no invocation.", y=14, size=13)]
            if origin != "F5-C02":
                continue
            if key == "PR":
                observed = _clone(active, "F5-T-HOST-ACTIVE-PR")
                observed["regions"] = [r for r in observed["regions"] if r["id"] != "current-bindings"]
                host_snapshot = _changed_snapshot(initial, key, "Enabled")
                observed["state"].update(bindingState="Enabled", bindingSnapshot=host_snapshot, committed=True, pushed=True, hostObserved=True)
                observed["state"]["collectionContext"]["bindingSnapshot"] = deepcopy(host_snapshot)
                observed["title"] = "PR status · host rule observed active"
                _region(observed, "title")["props"]["lines"][1]["t"] = "binding-pr · Enabled · no invocation"
                _region(observed, "review-effects")["props"]["lines"] = [
                    _line("Host configuration observed active: committed + pushed. No invocation; T3 Pause does not control this native rule.", y=14, size=13)]
                scenes[observed["id"]] = observed
                closure(observed, origin, host_snapshot, "PR-HOST-ACTIVE")
                _study(active, "Later: host observes config", observed["id"])
            else:
                paused_id = "F5-T-PAUSED-" + key
                active["regions"].append(_button("pause", "Pause future admissions", [360, 836, 260, 32], paused_id, "configuration-change"))
                paused = _clone(active, paused_id)
                paused["regions"] = [r for r in paused["regions"] if r["id"] != "current-bindings"]
                paused_snapshot = _changed_snapshot(initial, key, "Paused")
                paused["state"].update(bindingState="Paused", bindingSnapshot=paused_snapshot, activeWorkCancelled=False)
                paused["state"]["collectionContext"]["bindingSnapshot"] = deepcopy(paused_snapshot)
                paused["title"] = record["sourceType"] + " · paused · no invocation"
                _region(paused, "title")["props"]["lines"][1]["t"] = record["bindingId"] + " · Paused · no invocation"
                _region(paused, "review-effects")["props"]["lines"] = [
                    _line("Paused: future admissions held; active work is not cancelled. Manual remains available; independent host rules are unaffected.", y=14, size=13)]
                _region(paused, "pause")["props"]["label"] = "Resume future admissions"
                _link(_region(paused, "pause"), enabled, "configuration-change")
                scenes[paused_id] = paused
                closure(paused, origin, paused_snapshot, key + "-PAUSED")
                if key == "ISSUE":
                    _study(active, "Later: issue #238 delivery", "F5-T-AUTO-DELIVERY")
                    for config, phase in ((active, "ENABLED"), (paused, "PAUSED")):
                        snapshot = config["state"]["bindingSnapshot"]
                        context = _manual_binding_receipts(scenes, execution[origin], snapshot, phase)
                        runs = _run_pair(scenes, origin, config["id"], context, "CONFIG-" + phase, snapshot)
                        config["regions"].append(_button("manual-run", "Review manual run…", [1280, 836, 280, 32], runs["Factory"]))
    _automatic_delivery(scenes, base, issue_enabled)


def _manual_binding_receipts(scenes, execution, snapshot, phase):
    context = {}
    for key, source_work, return_region in (("receipt", "F5-C10", "return-accepted-work"),
                                            ("queued", "F5-C14", "return-ci-queued")):
        receipt_id = execution[key] + "-BINDING-" + phase
        receipt = _clone(scenes[execution[key]], receipt_id)
        work_id = _snapshot_work(scenes, source_work, snapshot, "ISSUE-" + phase + "-MANUAL")
        receipt["state"].update(bindingSnapshot=deepcopy(snapshot), returnOrigin=work_id)
        receipt["shell"]["navTargets"] = {"Work": work_id} if key == "queued" else {}
        receipt.pop("studyLinks", None)
        _link(_region(receipt, return_region), work_id, "history-read" if key == "receipt" else "return")
        control = _region(scenes[work_id], "invocation")
        control["props"]["variant"] = "secondary"
        _link(control, receipt_id, "history-read")
        receipt["caption"] = "Independent manual issue237 invocation; the issue binding snapshot survives dispatch and Work return. Further provider/thread and completion observations are prototype-static in this named branch."
        scenes[receipt_id] = receipt
        context[key] = receipt_id
    return context


def _automatic_delivery(scenes, base, snapshot):
    record = snapshot["records"]["ISSUE"]
    resolved = _input_example(base, True)
    provenance = deepcopy(record["candidateProvenance"])
    inputs = {**deepcopy(resolved), "bindingId": "binding-issue", "deliveryId": "d-7741",
              "dispatchOwner": "T3 trigger service", "target": "Factory",
              "workflowId": record["workflowId"], "workflowVersion": record["workflowVersion"],
              "workflowSourceCommit": record["workflowSourceCommit"], "workflowDigest": record["workflowDigest"],
              "invocationRef": base["fixtures"]["automaticInvocation"], "candidateProvenance": provenance,
              "sourceContentRef": {"sourceRef": deepcopy(resolved["sourceRef"]), "deliveryId": "d-7741",
                                   "immutableRevision": True, "fixtureOnly": True},
              "resolutionOrder": deepcopy(record["resolutionOrder"])}
    delivery = _clone(scenes["F5-T08"], "F5-T-AUTO-DELIVERY")
    delivery["shell"]["navTargets"] = {"Work": "F5-C13"}
    delivery["state"].update(deepcopy(inputs))
    delivery["state"].update(resolvedInputSnapshot=deepcopy(inputs), bindingSnapshot=deepcopy(snapshot),
                             bindingState="Enabled", manual237Invocation=None, nativeThreadId=None,
                             retainedWorkRef=None, externalRunId=None, providerObservation="not yet observed")
    delivery["regions"] = [
        _panel("t08-title", [360, 118, 1200, 58], [
            _line("Delivery d-7741 · matched", 0, 26, 20, 600),
            _line("binding-issue · T3 trigger service · Factory · accepted 09:12", 0, 50, 13, color="MUT"),
        ], "text", "none"),
        _panel("t08-source", [360, 184, 1200, 100], [
            _line("Source: github / acme/factory / #238 / revision 1", y=28, weight=500),
            _line("Handle an interrupted index refresh · immutable source revision retained with delivery d-7741", y=58, size=13),
            _line("Authenticated platform subscription · repository/action/labels matched · self-origin excluded", y=84, size=13, color="MUT"),
        ]),
        _panel("t08-mapping", [360, 296, 1200, 180], [
            _line("Resolved input snapshot · frozen before workflow dispatch", y=28, weight=500),
            _line("1. sourceRef = github / acme/factory / #238 / revision 1", y=60, size=13),
            _line("2. planItemRef = planned / env-ws / project-factory / plan-238", y=88, size=13),
            _line("3. Starting commit: acme/factory @ " + resolved["candidateCommit"], y=116, size=13),
            _line("Selector: repository default branch → observed refs/heads/main → full commit above", y=144, size=13),
            _line("Resolved source → plan reserved → starting commit resolved → snapshot frozen → invocation accepted", y=168, size=12, color="MUT"),
        ], "code", "code"),
        _panel("t08-dispatch", [360, 488, 1200, 160], [
            _line("Queued invocation " + inputs["invocationRef"] + " · Implement issue v1", y=28, weight=500),
            _line("Definition commit: " + record["workflowSourceCommit"], y=58, size=13),
            _line("Workflow SHA-256: " + record["workflowDigest"], y=88, size=13),
            _line("Provider/thread association not yet observed; no retained WorkRef or external CI run observed.", y=120, size=13),
            _line("Starting commit is input code, not an implemented output, completion or acceptance.", y=146, size=13, color="MUT"),
        ]),
        _panel("t08-linked", [360, 660, 1200, 136], [
            _line("Plan item resolved/created before workflow dispatch under this binding's admission authority", y=28, weight=500),
            _line("Reviewed #63 authority: resolve or reserve plan-238, then admit and start Implement issue. No merge or release grant.", y=58, size=13),
            _line("Source, plan or starting commit unresolved/mismatched → Held with named input · no invocation", y=88, size=13),
            _line("plan-237 remains independent and not started. Event dedupe uses binding + delivery, never candidate commit alone.", y=116, size=13, color="MUT"),
        ]),
        _button("t08-open-work", "Open Work item plan-238", [360, 818, 280, 32], "F5-C13"),
    ]
    delivery["caption"] = "Fictional resolved dispatch snapshot, including source revision reference and full starting commit. No provider/thread observation is implied. Broader event history and second dispatch are prototype-static; this is not resolver or source-store proof."
    scenes[delivery["id"]] = delivery
    work = scenes["F5-C13"]
    work["state"].update(candidateCommit=resolved["candidateCommit"], candidateRepository=resolved["candidateRepository"],
                          candidateProvenance=deepcopy(provenance), resolvedInputSnapshot=deepcopy(inputs),
                          bindingSnapshot=deepcopy(snapshot))
    for item in work["state"]["records"]:
        if item["planItemRef"]["id"] == resolved["planItemRef"]["id"]:
            item.update(candidateCommit=resolved["candidateCommit"], candidateRepository=resolved["candidateRepository"],
                        candidateProvenance=deepcopy(provenance), invocationRef=inputs["invocationRef"])
    control = _region(work, "auto-trigger-history")
    control["props"]["label"] = "Inputs / starting commit"
    control["box"][2] = 300
    _link(control, delivery["id"], "history-read")


def _definitions_neutral(scenes):
    for scene in scenes.values():
        if not scene["id"].startswith(("F5-W03", "F5-W04")):
            continue
        scene["state"].pop("automaticBindings", None)
        for region in scene["regions"]:
            for line in region.get("props", {}).get("lines", []):
                replacements = {
                    "Shared configuration ready · automatic bindings off": "Shared configuration ready · bindings configured separately",
                    "Automation": "Bindings",
                    "Off": "View bindings",
                    "Automatic    No active bindings": "Automatic    View trigger bindings",
                    "targets: factory, ci    automaticBindings: []": "targets: factory, ci",
                }
                line["t"] = replacements.get(line["t"], line["t"])


def _caption_metadata(scenes):
    removed_regions = {"catalog-provenance", "other-profile", "t10-note"}
    for scene in scenes.values():
        scene["regions"] = [r for r in scene["regions"] if r["id"] not in removed_regions]
        for region in scene["regions"]:
            for line in region.get("props", {}).get("lines", []):
                text = line["t"]
                replacements = {
                    "2 illustrative manual records · immutable version and input bindings": "2 manual records · immutable version and input bindings",
                    "Illustrative finding · reviewer evidence attached in the CI report": "Reviewer evidence attached in the CI report",
                    "Illustrative finding · human disposition still required": "Human disposition still required",
                    "merge: false    release: false    autoBindings: []": "merge: false    release: false",
                }
                line["t"] = replacements.get(text, text)
    scenes["F5-W00"]["caption"] += " The brief-led setup profile is outside this linked study."
    scenes["F5-W11"]["caption"] += " The two records are independent examples, not two invocations from one dispatch."
    for scene in scenes.values():
        unlinked_runs = [r for r in scene["regions"]
                         if r["id"] in {"review-factory", "review-ci"} and not r.get("props", {}).get("link")]
        if unlinked_runs:
            for control in unlinked_runs:
                control["props"]["variant"] = "disabled"
            context = scene["state"].get("collectionContext", {})
            guidance = "Select a work item to run. " if not context.get("selection") else ""
            scene["caption"] = (guidance + "Read-only pinned definition. Configuration changes and another run are not linked in this prototype; no permission restriction is implied. Return preserves the caller snapshot. Supplied digest identifies the full definition, not this explanatory excerpt.")


def _historical(scenes):
    for number in range(12):
        scene = scenes[f"F5-T{number:02d}"]
        scene["state"]["readOnlyRecord"] = True
        scene["caption"] += " Separate historical study; mutation and another-invocation controls are static."
        scene["shell"]["navTargets"] = {"Work": "F5-C13"} if number not in (6, 10) else {}
        for region in scene["regions"]:
            link = region.get("props", {}).get("link")
            if not link:
                continue
            if (link.get("effect") == "configuration-change" or link["to"] in ("F5-W05", "F5-W06")
                    or region["id"] in {"t00-new-trigger", "t06-enable", "t06-dispatch", "t06-back"}
                    or region["id"].startswith("t01-btn-")):
                _static(scene, region, "Static historical control; additional configuration/dispatch is outside this record lookup.")
            elif number in (6, 10) and link["to"].startswith("F5-T"):
                _static(scene, region, "Later records are available through independent study starts, not a reset of this snapshot.")
        if number in (6, 10):
            scene["regions"].append(_button("history-back", "Back to history", [1250, 850, 280, 32], "F5-T00", "return"))
            _link(scene["regions"][-1], "F5-T00", "return", "back", allowedOrigins=["F5-T00", "F5-T02", "F5-T03", "F5-T07"])


def _source_returns(scenes):
    owner_ids = {"F5-P-MORE", "F5-P-ISSUES", "F5-P-BRIEFS", "F5-P-RESEARCH", "F5-P-SOURCES", "F5-P-SETTINGS"}
    for scene_id in owner_ids:
        scene = scenes[scene_id]
        scene["shell"]["navTargets"] = {}
        for region in scene["regions"]:
            link = region.get("props", {}).get("link")
            if link and link.get("to", "").startswith("F5-C"):
                _link(region, link["to"], "return", "back", allowedOrigins=sorted(
                    s["id"] for s in scenes.values() if s["shell"].get("mode") == "workspace"))
        if not any(r.get("props", {}).get("link", {}).get("type") == "back" for r in scene["regions"]):
            back = _button("source-history-back", "Back", [360, 830, 120, 32])
            _link(back, "F5-C00", "return", "back", allowedOrigins=sorted(
                s["id"] for s in scenes.values() if s["shell"].get("mode") == "workspace"))
            scene["regions"].append(back)


def _refine_layouts(scenes):
    stage_order = {
        region["props"]["lines"][0]["t"]: index
        for index, region in enumerate(scenes["F5-C00"]["regions"])
        if region["id"].startswith("column-")
    }
    for scene in scenes.values():
        regions = {region["id"]: region for region in scene["regions"]}
        records = {record["planItemRef"]["id"]: record for record in scene["state"].get("records", [])}
        rows = [region for region in scene["regions"] if region["id"].startswith("table-plan-")]
        if rows:
            top = min(row["box"][1] for row in rows)
            rows.sort(key=lambda row: stage_order[records[row["id"].removeprefix("table-")]["planningStage"]])
            for index, row in enumerate(rows):
                row["box"][1], row["box"][3] = top + index*66, 66
                row["props"]["lines"][1]["y"] = 62
            for region in scene["regions"]:
                if region["id"].startswith("table-rule-"):
                    index = int(region["id"].removeprefix("table-rule-"))
                    region["box"][1] = top + (index+1)*66
        if "review-source" in regions:
            inspector = _region(scene, "selected-inspector")
            source_y = next(line["y"] for line in inspector["props"]["lines"] if line["t"] == "Source")
            action = regions["review-source"]
            action["box"][0] = inspector["box"][0]+inspector["box"][2]-20-action["box"][2]
            action["box"][1] = inspector["box"][1]+source_y-20
        if scene["id"].startswith("F5-W03"):
            for region in scene["regions"]:
                lines = region.get("props", {}).get("lines")
                if lines:
                    region["props"]["lines"] = [line for line in lines if line["t"] not in ("Bindings", "View bindings")]
            if "open-trigger-bindings" in regions:
                regions["open-trigger-bindings"]["props"]["label"] = "Triggers"
                regions["open-trigger-bindings"]["box"] = [1350, 118, 210, 32]
                scene["regions"] = [region for region in scene["regions"] if region["id"] != "open-review"]
        if scene["id"] in ("F5-P-N0", "F5-P-N1"):
            query = _region(scene, "work-query")
            query["box"][3] = 78
            query["props"]["lines"] += [
                _line("Work item / source", 12, 72, 12, color="MUT"),
                _line("Stage", 590, 72, 12, color="MUT"),
                _line("Execution", 730, 72, 12, color="MUT"),
            ]
            for region in scene["regions"]:
                if region["id"].startswith("narrow-plan-"):
                    record = records[region["id"].removeprefix("narrow-")]
                    region["props"]["lines"].append(_line(record["planningStage"], 590, 39, 12, color="MUT"))
        if scene["id"] == "F5-P-M1":
            for region in scene["regions"]:
                if not region["id"].startswith("phone-plan-"):
                    continue
                plan_id = region["id"].removeprefix("phone-")
                record = records[plan_id]
                title, original = region["props"]["lines"]
                identity = original["t"].rsplit(" · ", 1)[0]
                if plan_id == "plan-237":
                    identity = "GitHub #237 · rev 3"
                elif record["sourceRef"].get("kind") in ("research", "feed"):
                    identity += " · review on desktop"
                height = region["box"][3]
                region["props"]["lines"] = [
                    title,
                    _line(record["planningStage"]+" · "+record["sourceState"]+" · "+record["executionLabel"],
                          12, height-23, 12, color="MUT"),
                    _line(identity, 12, height-6, 11, color="MUT"),
                ]
            scene["caption"] += " Every row keeps stage, source status and execution distinct; Research/RSS exact review is desktop-only."


def _finalize(scenes):
    for scene in scenes.values():
        nav = scene["shell"].setdefault("navTargets", {})
        mode = scene["shell"].get("mode")
        if (mode in ("workspace", "settings") and scene["id"] != "F5-P-MORE"
                and not scene["shell"].get("projectNavigationStatic")):
            nav["More"] = "F5-P-MORE"
        for label, target in list(nav.items()):
            if target == scene["id"]:
                del nav[label]
            elif target not in scenes:
                raise ValueError(f"{scene['id']}: shell {label!r} references missing scene {target!r}")
        seen_regions = set()
        for lane in ("regions", "studyLinks"):
            for index, region in enumerate(scene.get(lane, [])):
                if region["id"] in seen_regions:
                    raise ValueError(f"{scene['id']}: duplicate region {region['id']!r}")
                seen_regions.add(region["id"])
                props = region.setdefault("props", {})
                if region["kind"] == "text" and props.get("style") == "panel":
                    props["style"] = "none"
                if region["id"] == "project-scope" and region["box"][3] == 38:
                    region["box"][3] = 44
                link = props.get("link")
                if link and link.get("to") == scene["id"]:
                    _unlink(region)
                    link = None
                if link:
                    if link.get("to") not in scenes:
                        raise ValueError(f"{scene['id']}/{region['id']}: missing target {link.get('to')!r}; supply its owning document or fix the reference")
                    link["edge"] = f"F5-GE-{scene['id']}-{lane}-{index:03d}"
                    for key in ("preserveOriginThrough", "originMapping", "defaultOrigin"):
                        link.pop(key, None)
                elif region["kind"] == "button":
                    scene.setdefault("staticControls", []).append(region["id"] + ": static in this bounded scene")
        scene.setdefault("staticControls", []).append(
            "Unlinked native shell controls (search, sidebar cards, history, footer, terminal, panel and settings), fields and row controls are static; linked More opens the native project menu.")
        scene["staticControls"] = list(dict.fromkeys(scene["staticControls"]))


def _export_reachable(scenes):
    roots = ["F5-C00", "F5-W00", "F5-T-CONFIG", "F5-P-N0", "F5-P-M1"]
    pending = list(roots)
    reachable = set()
    while pending:
        scene_id = pending.pop()
        if scene_id in reachable:
            continue
        reachable.add(scene_id)
        scene = scenes[scene_id]
        if scene["shell"].get("mode") in ("workspace", "settings", "narrow"):
            pending.extend(scene["shell"].get("navTargets", {}).values())
        for region in scene["regions"] + scene.get("studyLinks", []):
            link = region.get("props", {}).get("link")
            if link and link.get("type", "navigate") != "back":
                pending.append(link["to"])
    for scene_id in reachable:
        scene = scenes[scene_id]
        back_origins = []
        for region in scene["regions"] + scene.get("studyLinks", []):
            link = region.get("props", {}).get("link")
            if link and link.get("type") == "back":
                link["allowedOrigins"] = [origin for origin in link.get("allowedOrigins", []) if origin in reachable]
                back_origins.extend(link["allowedOrigins"])
        if "allowedOrigins" in scene.get("state", {}):
            scene["state"]["allowedOrigins"] = list(dict.fromkeys(back_origins))
    return [scene for scene_id, scene in scenes.items() if scene_id in reachable], sorted(set(scenes)-reachable), roots


def assemble(documents, base):
    """Return a detached flat scene list and integration notes; perform no I/O."""
    scenes = {}
    author_notes = {}
    for name in ("collections", "workflows", "triggers", "parent", "sourceowners", "delivery", "operations"):
        if name not in documents or not isinstance(documents[name], dict):
            raise ValueError(f"assemble requires parsed documents[{name!r}]")
        document = deepcopy(documents[name])
        if not isinstance(document.get("scenes"), list):
            raise ValueError(f"documents[{name!r}] must contain a scenes list")
        author_notes[name] = document.get("notes", [])
        for scene in document["scenes"]:
            scene_id = scene["id"]
            if scene_id in scenes:
                raise ValueError(f"Duplicate author scene {scene_id!r} in {name}; resolve ownership before assembly")
            scenes[scene_id] = scene
    required = ([f"F5-C{i:02d}" for i in range(16)] + [f"F5-W{i:02d}" for i in range(13)]
                + [f"F5-T{i:02d}" for i in range(12)]
                + ["F5-P-MORE", "F5-P-ISSUES", "F5-P-BRIEFS", "F5-P-RESEARCH", "F5-P-SOURCES", "F5-P-SETTINGS"])
    for scene_id in required:
        if scene_id not in scenes:
            raise ValueError(f"Missing required scene {scene_id!r}; supply its frozen author/source-owner document")
    try:
        template = deepcopy(documents["parent"]["templates"]["nativeThreadRegions"])
    except KeyError as error:
        raise ValueError("parent.templates.nativeThreadRegions is required; supply the native parent thread body") from error
    if not template:
        raise ValueError("parent.templates.nativeThreadRegions must contain the native thread regions")
    base = deepcopy(base)
    for group, keys in (
        ("project", ("id", "environmentId")),
        ("fixtures", ("workflowSourceCommit", "planItem", "sourceIssue", "candidateCommit", "automaticInvocation",
                      "automaticSourceIssue", "automaticPlanItemId")),
    ):
        if not isinstance(base.get(group), dict):
            raise ValueError(f"base.{group} must contain the shared fixture fields")
        for key in keys:
            if key not in base[group]:
                raise ValueError(f"base.{group}.{key} is required; supply the complete base.json")
    if not isinstance(base.get("workflowCatalog"), list):
        raise ValueError("base.workflowCatalog is required; supply the complete base.json")
    workflow_ids = set()
    for workflow in base["workflowCatalog"]:
        for key in ("id", "name", "version", "digest"):
            if key not in workflow:
                raise ValueError(f"base.workflowCatalog entry is missing {key!r}")
        if workflow["id"] in workflow_ids:
            raise ValueError(f"Duplicate base.workflowCatalog id {workflow['id']!r}")
        workflow_ids.add(workflow["id"])
    for workflow_id in ("wf-review-change", "wf-implement-issue", "wf-diagnose-ci"):
        if workflow_id not in workflow_ids:
            raise ValueError(f"base.workflowCatalog is missing required definition {workflow_id!r}")
    _definitions_neutral(scenes)
    _historical(scenes)
    scenes["F5-C07"]["shell"]["navTargets"]["Work"] = "F5-C01"
    scenes["F5-C02"]["shell"]["navTargets"].pop("Intake", None)
    scenes["F5-C02"].setdefault("staticControls", []).append(
        "Selected Intake return is static; the bounded intake path begins on the unselected Board.")
    unselected = _unselected(scenes)
    ci = _ci_layouts(scenes)
    execution = _execution_contexts(scenes, template, ci)
    _source_contexts(scenes)
    for origin, context in execution.items():
        runs = _run_pair(scenes, origin, origin, context, origin.removeprefix("F5-"))
        _link(_region(scenes[origin], "run-workflow"), runs["Factory"])
    _configuration(scenes, base, execution)
    lookup_origins = _catalogs(scenes, base, execution)
    _definitions_neutral(scenes)
    for scene_id in ("F5-W05", "F5-W06"):
        scene = scenes[scene_id]
        scene["state"].pop("automaticBindings", None)
        scene["shell"]["navTargets"] = {}
    _nested_lookups(scenes, base)
    for scene in scenes.values():
        if scene["id"].startswith("F5-W"):
            scene["state"].pop("automaticBindings", None)
    delivery_graph.integrate(scenes, base)
    operations_graph.integrate(scenes, base)
    _source_returns(scenes)
    _caption_metadata(scenes)
    _refine_layouts(scenes)
    council_workflows.integrate(scenes, base)
    council_evidence.integrate(scenes, base)
    council_collections.integrate(scenes, base)
    council_desktop.integrate(scenes, base)
    council_parent.integrate(scenes, base)
    _finalize(scenes)
    exported, unused_templates, flow_roots = _export_reachable(scenes)
    notes = {
        "authorNotes": author_notes,
        "unselectedLayouts": unselected,
        "ciLayouts": ci,
        "executionContexts": execution,
        "workflowLookupOrigins": lookup_origins,
        "configurationStart": "F5-T-CONFIG",
        "sourceCatalog": "F5-T-SOURCES",
        "automaticObservation": "F5-T-AUTO-DELIVERY",
        "flowRoots": flow_roots,
        "sourceTemplatesNotExported": unused_templates,
        "assumptions": [
            "Frozen author documents and base fixtures are deep-copied; only the returned scene graph is transformed.",
            "Explicit context variants replace target-change Back and mutation returns. Shared read-only source/menu/binding record inspection alone may use native Back.",
            "Every workflow catalog row opens its pinned definition. Review change Run controls are linked in pre-run selected contexts; other dispatches and post-execution mutations are visibly prototype-static, not business-rule restrictions.",
            "C02/C03/C04 expose the same eight records and seven first-activation spines. One binding changes per branch; explicit changed lists and inspect-only Work/catalog returns preserve that snapshot. No per-layout event history or full execution graph is copied.",
            "Initial manual study bindings are Draft/Off; automatic issue238 has ISSUE Enabled. Named enabled/paused manual issue237 receipts and Work returns carry that binding snapshot, with further observations static.",
            "CUSTOM/WEBHOOK map all three required payload fields and reject missing/unresolved/mismatched inputs without selection fallback. Signature rejection precedes mapping. Invalid configuration is described but alternate malformed forms are not simulated.",
            "Schedule reviews fixed source237 revision3 / qualified plan237 and resolves explicit refs/heads/main per occurrence. Preview commit is an example, not a future pin. ISSUE resolves source238, resolves/reserves plan238 under reviewed #63 admission authority, resolves its starting commit, then freezes and dispatches.",
            "The PR example explicitly links PR236 to reviewed source237 revision3 and plan237; this is a fictional reviewed source-link policy, not a repository observation. Integration requires a qualified payload plan and matching source link. Both hold if any required reference or candidate cannot resolve.",
            "Full workflow digests and definition source commit come unchanged from base.json; no hash is derived from the abbreviated explanatory definition bodies. The same repository candidate may serve independent source237 and source238 invocations.",
            "Enable produces no invocation. A caption-only later delivery leads to Implement issue v1 / inv-f5-auto-01 / plan-238; manual237 and external CI19541 identities remain separate.",
            "Host-owned CI save is pending commit, push and host observation. T3 pause affects only future T3 admissions; it neither cancels work nor disables independent host rules. Manual review remains linked while enabled or paused.",
            "Historical T00–T11 and other unreachable author templates remain archived inputs, not duplicated native exports; ordinary configuration uses CONFIG/SOURCES/EDIT/REVIEW/ENABLED variants. Static input fields are prefilled fixture forms, not an input simulator.",
            "Parent supplies flow starts, caption study-link rendering, native shell and the only Figma writer. Assembly performs no browser, app, provider, CI or filesystem operation.",
        ],
        "verification": "Not run here; parent owns integrated smoke, rendering and native navigation evidence.",
    }
    return exported, notes
