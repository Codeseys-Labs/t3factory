"""Council collection corrections on assembled round05 scenes; no IO.

Call integrate after _refine_layouts and before _finalize/_export_reachable.
Uses the existing region/link IR from build_workspace.py:122-203 and context
copies from workspace_graph.py:143-235. No application or vendor code is used.
"""
from copy import deepcopy


_VERSION = "council-collections-01"
_STAGES = ("Backlog", "Ready", "In progress", "Done")


def _line(text, y, x=16, size=14, color="FG", weight=400, **extra):
    return dict(t=text, x=x, y=y, s=size, c=color, w=weight, **extra)


def _panel(identifier, box, lines, kind="card", style="panel"):
    return dict(id=identifier, kind=kind, box=list(box), props=dict(style=style, lines=lines))


def _button(identifier, label, box, target, effect="navigation", variant="secondary"):
    props = dict(label=label, size=14, variant=variant)
    if target:
        props["link"] = dict(to=target, type="navigate", effect=effect)
    return dict(id=identifier, kind="button", box=list(box), props=props)


def _regions(scene):
    return {r["id"]: r for r in scene["regions"]}


def _put(scene, region):
    scene["regions"] = [r for r in scene["regions"] if r["id"] != region["id"]]
    scene["regions"].append(region)


def _copy(scenes, source, target, role):
    value = deepcopy(scenes[source])
    value.update(id=target, councilCollections=dict(version=_VERSION, role=role, origin=source))
    scenes[target] = value
    return value


def _collection(scene):
    return (scene["id"].startswith("F5-C")
            and scene["state"].get("view") in ("Board", "Table", "List")
            and (_inspector(scene) is not None or any(
                r["id"].startswith(("column-", "table-plan-", "list-plan-")) for r in scene["regions"])))


def _inspector(scene):
    return next((r for r in scene["regions"] if r["id"] in ("selected-inspector", "auto-inspector")), None)


def _selection(scene):
    return (scene["state"].get("selection") or {}).get("id")


def _layout_links(scenes, targets):
    for view, sid in targets.items():
        for index, label in enumerate(("Board", "Table", "List")):
            _put(scenes[sid], _button("layout-" + label, label,
                 [730 + index * 78, 118, 72, 32], targets[label] if view != label else None,
                 variant="primary" if view == label else "secondary"))


def _automatic_layouts(scenes):
    board = scenes["F5-C13"]
    targets = dict(Board=board["id"], Table="F5-C13-TABLE", List="F5-C13-LIST")
    for view in ("Table", "List"):
        scene = _copy(scenes, board["id"], targets[view], "automatic-layout")
        scene["title"] = "Work · " + view + " · automatic source 238"
        scene["state"].update(view=view, returnOrigin=scene["id"])
        scene["regions"] = [r for r in scene["regions"] if not r["id"].startswith(("column-", "card-plan-"))]
        scene["shell"]["navTargets"] = deepcopy(board["shell"].get("navTargets", {}))
    _layout_links(scenes, targets)


def _record_regions(scene, templates):
    state, view = scene["state"], scene["state"]["view"]
    records = state.get("records", [])
    selected = _selection(scene)
    width = 796 if selected else 1238
    prefix = {"Board": "card-", "Table": "table-", "List": "list-"}[view]
    originals = {r["id"].removeprefix(prefix): deepcopy(r) for r in scene["regions"]
                 if r["id"].startswith(prefix + "plan-")}
    scene["regions"] = [r for r in scene["regions"] if not r["id"].startswith(
        ("column-", "card-plan-", "table-plan-", "table-rule-", "list-plan-", "list-heading-"))
        and r["id"] != "table-heading"]
    ordered = sorted(records, key=lambda r: _STAGES.index(r["planningStage"]))
    if view == "Board":
        scene.setdefault("canvas", {}).update(width=2044 if selected else 1600, height=1040)
        for index, stage in enumerate(_STAGES):
            members = [r for r in ordered if r["planningStage"] == stage]
            x = 340 + index * 314
            scene["regions"].append(_panel("column-" + str(index), [x, 176, 298, 660], [
                _line(stage, 25, 12, weight=600), _line(str(len(members)), 25, 270, 12, "MUT")
            ], style="neutral"))
            height = 136 if len(members) > 3 else 160
            for row, record in enumerate(members):
                pid = record["planItemRef"]["id"]
                template = deepcopy(originals.get(pid) or templates[pid])
                template["id"] = "card-" + pid
                template["box"] = [x + 8, 220 + row * (height + 12), 282, height]
                props = template["props"]
                props["style"] = "row-selected" if pid == selected else "panel"
                lines = props["lines"]
                lines[0].update(x=12, y=25, wrap=258)
                for line, y in zip(lines[1:], (height - 69, height - 48, height - 21)):
                    line.update(x=12, y=y)
                    line.pop("wrap", None)
                lines[-1]["t"] = "Execution: " + record["executionLabel"]
                lines[-1]["wrap"] = 258
                scene["regions"].append(template)
    elif view == "Table":
        scene["regions"].append(_panel("table-heading", [340, 176, width, 40], [
            _line("Work item", 25, 12, 12, "MUT", 600),
            _line("Planning stage", 25, 310, 12, "MUT", 600),
            _line("Source", 25, 430, 12, "MUT", 600),
            _line("Execution", 25, 606, 12, "MUT", 600),
        ], "row", "header"))
        y = 216
        for record in ordered:
            pid = record["planItemRef"]["id"]
            source = templates[pid]["props"]["lines"]
            original = originals.get(pid)
            props = deepcopy(original["props"]) if original else dict(style="row", lines=[
                _line(source[0]["t"], 22, 12, 14, weight=600, wrap=282, lh=20),
                _line(pid + " · " + source[2]["t"].split(" · ")[-1], 58, 12, 12, "MUT"),
                _line(record["planningStage"], 27, 310, 12),
                _line(source[1]["t"], 21, 430, 12, "MUT"),
                _line(record["sourceState"], 43, 430, 12, "MUT"),
                _line(record["executionLabel"], 27, 606, 12, "BLUE_TEXT"),
            ])
            props["style"] = "row-selected" if selected == pid else "row"
            props["lines"][1]["y"] = 58
            props["lines"][2]["t"] = record["planningStage"]
            props["lines"][-1]["t"] = record["executionLabel"]
            scene["regions"].append(dict(id="table-" + pid, kind="row", box=[340, y, width, 70], props=props))
            y += 70
            scene["regions"].append(dict(id="table-rule-" + str(y), kind="rule", box=[340, y, width, 1], props={}))
    else:
        y = 176
        for stage in _STAGES:
            members = [r for r in ordered if r["planningStage"] == stage]
            scene["regions"].append(_panel("list-heading-" + stage, [340, y, width, 34], [
                _line("Planning stage · " + stage, 23, 12, 12, "MUT", 600),
                _line("Execution", 23, 610, 12, "MUT", 600)], "row", "header"))
            y += 34
            for record in members:
                pid = record["planItemRef"]["id"]
                source = templates[pid]["props"]["lines"]
                props = deepcopy(originals[pid]["props"]) if pid in originals else dict(style="row", lines=[
                    _line(source[0]["t"], 22, 12, 14, weight=600, wrap=540, lh=20),
                    _line(source[1]["t"] + " · " + record["sourceState"], 46, 12, 12, "MUT"),
                    _line(record["executionLabel"], 23, 610, 12, "BLUE_TEXT"),
                    _line(source[2]["t"].split(" · ")[-1], 45, 610, 12, "MUT"),
                ])
                props["style"] = "row-selected" if pid == selected else "row"
                props["lines"][2]["t"] = record["executionLabel"]
                scene["regions"].append(dict(id="list-" + pid, kind="row", box=[340, y, width, 58], props=props))
                y += 58


def _thread_stage(scene):
    if scene["shell"].get("mode") != "thread":
        return
    prefix = (_selection(scene) or "") + " · "
    for region in scene["regions"]:
        for line in region.get("props", {}).get("lines", []):
            if line["t"] in (prefix + "Ready", prefix + "In progress"):
                line["t"] = prefix + "Planning: " + scene["state"]["planningStage"]


def _native_thread(scenes, scene):
    control = _regions(scene).get("open-native-thread")
    if not control or control["props"].get("link") or not scene["state"].get("nativeThreadId"):
        return
    target = scene["id"] + "-THREAD"
    thread = _copy(scenes, "F5-P-THREAD-C10", target, "native-thread")
    thread["state"].update(deepcopy(scene["state"]))
    thread["state"]["threadContext"]["returnTarget"] = scene["id"]
    _thread_stage(thread)
    thread["shell"]["navTargets"] = {}
    thread["caption"] = "Existing native thread and invocation; exact binding and planning snapshot retained. Opening the thread does not dispatch new work."
    regions = _regions(thread)
    regions["return-working-work"]["props"]["link"] = dict(to=scene["id"], type="navigate", effect="return")
    regions["thread-receipt"]["props"]["link"]["to"] = _regions(scene)["invocation"]["props"]["link"]["to"]
    for region in thread["regions"]:
        link = region.get("props", {}).get("link")
        if link and link["to"] in scenes:
            _allow_back(scenes[link["to"]], target)
    control["props"]["link"] = dict(to=target, type="navigate", effect="navigation")


def _source_reader(scenes, scene):
    if scene["id"] in ("F5-C02", "F5-C03", "F5-C04"):
        return "F5-C08-FROM-" + scene["id"].removeprefix("F5-")
    sid = scene["id"] + "-SOURCE"
    source_ref = scene["state"]["sourceRef"]
    if source_ref["number"] == 237:
        template = "F5-C08-FROM-C02"
        reader = _copy(scenes, template, sid, "source-reader")
        reader["state"] = deepcopy(scene["state"])
        reader["state"].update(view="Source review", returnOrigin=scene["id"], collectionContext=deepcopy(scene["state"]))
        regions = _regions(reader)
        match = regions["possible-existing"]["props"]["lines"]
        match[2]["t"] = "plan-237 · " + scene["state"]["planningStage"]
        regions["source-effects"]["props"]["lines"] = [
            _line("Source and execution stay independent", 30, 20, weight=600),
            _line("GitHub #237 revision 3 remains Open.", 65, 20, 12, "MUT"),
            _line("Planning: " + scene["state"]["planningStage"], 92, 20, 12, "MUT"),
            _line("Review does not start, stop or undo work.", 121, 20, 12, "MUT"),
        ]
        for identifier in ("return-origin", "view-plan"):
            regions[identifier]["props"]["link"] = dict(to=scene["id"], type="navigate", effect="return")
        regions["view-plan"]["props"]["label"] = "Return to selected " + scene["state"]["view"]
    else:
        reader = _copy(scenes, scene["id"], sid, "source-reader")
        reader.pop("canvas", None)
        reader["state"].update(view="Source review", returnOrigin=scene["id"])
        reader["regions"] = [
            _panel("source-heading", [360, 118, 1200, 64], [
                _line("GitHub #238 · immutable revision 1", 28, 0, 20, weight=600),
                _line("Handle an interrupted index refresh", 54, 0, 14, "MUT")], "text", "none"),
            _panel("source-context", [360, 204, 1200, 180], [
                _line("github / acme/factory / #238 / revision 1", 32, weight=500),
                _line("Source remains Open. plan-238 is distinct from plan-237.", 68),
                _line("Delivery d-7741 retains the immutable source revision reference.", 104),
                _line("This source reader does not fabricate a source-body or revision-history observation.", 146, size=13, color="MUT")]),
            _button("return-origin", "Return to selected " + scene["state"]["view"], [360, 420, 260, 32], scene["id"], "return"),
        ]
    reader["shell"]["navTargets"] = {}
    reader["caption"] = "Read-only source revision; return preserves the exact query, selection, planning stage, binding snapshot and execution."
    return sid


def _replace_refs(value, mapping):
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_replace_refs(v, mapping) for v in value]
    if isinstance(value, dict):
        return {k: _replace_refs(v, mapping) for k, v in value.items()}
    return value


def _allow_back(scene, origin):
    for region in scene["regions"]:
        link = region.get("props", {}).get("link", {})
        if link.get("type") == "back" and origin not in link.get("allowedOrigins", []):
            link.setdefault("allowedOrigins", []).append(origin)
            scene.setdefault("councilCollections", dict(version=_VERSION, role="shared-reader-origins", origin=scene["id"]))
            if "allowedOrigins" in scene["state"] and origin not in scene["state"]["allowedOrigins"]:
                scene["state"]["allowedOrigins"].append(origin)


def _reader_return(scenes, target, origin, caller, cache=None):
    cache = {} if cache is None else cache
    if target in cache:
        return cache[target]
    reader = scenes[target]
    native = [r for r in reader["regions"] if r.get("props", {}).get("link", {}).get("type") == "back"]
    if native:
        _allow_back(reader, caller)
        return target
    clone_id = caller + "-READER-" + target.removeprefix("F5-")
    cache[target] = clone_id
    refs = {origin: caller}
    for control in reader["regions"]:
        link = control.get("props", {}).get("link", {})
        destination = scenes.get(link.get("to"))
        if destination and _collection(destination) and _selection(destination) == _selection(scenes[caller]):
            refs[destination["id"]] = caller
    clone = _replace_refs(deepcopy(reader), refs)
    clone.update(id=clone_id, councilCollections=dict(version=_VERSION, role="retained-reader", origin=target))
    clone["state"]["returnOrigin"] = caller
    clone["state"]["collectionContext"] = deepcopy(scenes[caller]["state"])
    if clone["state"].get("view") == "Source review":
        clone["shell"]["navTargets"] = {}
    if scenes[caller]["state"].get("planMembership") == "removed":
        clone["state"]["planMembership"] = "removed"
        clone["state"]["records"] = deepcopy(scenes[caller]["state"]["records"])
        for key in ("source237Planned", "source238Planned"):
            if key in scenes[caller]["state"]:
                clone["state"][key] = scenes[caller]["state"][key]
        existing = _regions(clone).get("possible-existing")
        if existing:
            existing["props"]["lines"][2]["t"] = _selection(scenes[caller]) + " · removed from active plan"
        effects = _regions(clone).get("source-effects")
        if effects:
            effects["props"]["lines"][0]["t"] = "Removed from active project plan"
        clone["caption"] += " History inspection does not restore plan membership."
    scenes[clone_id] = clone
    for region in clone["regions"] + clone.get("studyLinks", []):
        link = region.get("props", {}).get("link")
        if not link:
            continue
        if link["to"] == caller:
            if region["kind"] == "button":
                region["props"]["label"] = "Back to removed" if scenes[caller]["state"].get("planMembership") == "removed" else "Back to context"
            continue
        destination = scenes[link["to"]]
        if link["to"].startswith(("F5-W07", "F5-P-THREAD")):
            link["to"] = _reader_return(scenes, link["to"], origin, caller, cache)
        else:
            _allow_back(destination, clone_id)
    return clone_id


def _context_copies(scenes, stage_targets, original_ids):
    # Copy explicit return corridors; native Back readers keep their shared record.
    mapping = dict(stage_targets)
    pending = ["F5-C00", "F5-W00", "F5-T-CONFIG", "F5-P-N0", "F5-P-M1"]
    reachable = set()
    while pending:
        sid = pending.pop()
        if sid in reachable:
            continue
        reachable.add(sid)
        scene = scenes[sid]
        if scene["shell"].get("mode", "workspace") in ("workspace", "settings", "narrow"):
            pending.extend(scene["shell"].get("navTargets", {}).values())
        for region in scene["regions"] + scene.get("studyLinks", []):
            link = region.get("props", {}).get("link", {})
            if link and link.get("type") != "back":
                pending.append(link["to"])
    candidates = {sid for sid in original_ids & reachable if not _collection(scenes[sid])
                  and sid != "F5-T-AUTO-DELIVERY"
                  and sid.startswith(("F5-W", "F5-T", "F5-P-THREAD"))}
    while True:
        new = []
        for sid in sorted(candidates - mapping.keys()):
            scene = scenes[sid]
            links = list(scene["shell"].get("navTargets", {}).values())
            links += [r["props"]["link"]["to"] for r in scene["regions"] + scene.get("studyLinks", [])
                      if r.get("props", {}).get("link", {}).get("type") != "back" and r.get("props", {}).get("link")]
            if any(target in mapping for target in links):
                new.append(sid)
        if not new:
            break
        mapping.update({sid: sid + "-PLANNING-CONTEXT" for sid in new})
    for source, target in list(mapping.items()):
        if source in stage_targets:
            continue
        clone = _replace_refs(deepcopy(scenes[source]), mapping)
        clone.update(id=target, councilCollections=dict(version=_VERSION, role="planning-return-context", origin=source))
        if clone["state"].get("planningStage") == "Ready":
            clone["state"]["planningStage"] = "In progress"
            for record in clone["state"].get("records", []):
                if record["planItemRef"]["id"] == _selection(clone):
                    record["planningStage"] = "In progress"
        _thread_stage(clone)
        scenes[target] = clone
    for target in stage_targets.values():
        scene = scenes[target]
        scene["shell"] = _replace_refs(scene["shell"], mapping)
        for region in scene["regions"] + scene.get("studyLinks", []):
            if region["id"] not in ("edit-stage", "reverse-stage"):
                region["props"] = _replace_refs(region["props"], mapping)
    for scene in list(scenes.values()):
        for region in scene["regions"]:
            link = region.get("props", {}).get("link", {})
            if link.get("type") == "back":
                for origin in list(link.get("allowedOrigins", [])):
                    if origin in mapping:
                        _allow_back(scene, mapping[origin])
    return mapping


def _removal(scenes, scene):
    origin = scene["id"]
    confirm_id, removed_id = origin + "-REMOVE", origin + "-REMOVED"
    pid = _selection(scene)
    state = scene["state"]
    for sid, role in ((confirm_id, "remove-confirmation"), (removed_id, "removal-receipt")):
        copy = _copy(scenes, origin, sid, role)
        copy.pop("canvas", None)
        copy.pop("studyLinks", None)
        copy["shell"]["navTargets"] = {}
        copy["state"].update(view="Plan membership", returnOrigin=origin)
        copy["title"] = ("Remove from plan · " if role == "remove-confirmation" else "Removed from plan · ") + pid
        copy["regions"] = [
            _panel("membership-heading", [360, 118, 1200, 64], [
                _line(copy["title"], 28, 0, 20, weight=600),
                _line("Factory / Workstation · " + state["view"] + " · exact project query retained", 54, 0, 13, "MUT")], "text", "none"),
            _panel("membership-effects", [360, 204, 1200, 244], [
                _line("Only active membership in this project plan changes.", 34, weight=500),
                _line("The source stays Open; its revision and admission history remain inspectable.", 74),
                _line("No agent or CI launch, cancellation, source close, or execution-history deletion.", 112),
                _line("Invocation, thread / external run, candidate and workflow-version bindings stay unchanged.", 150),
                _line("Restoring membership returns to the same planning stage, query and execution snapshot.", 188),
                _line("Undo admission is separate and is available only before execution starts.", 224, size=13, color="MUT")]),
        ]
        copy["caption"] = "Static plan-membership branch. Removing a plan item never deletes retained Work or erases source/execution history."
    confirm, removed = scenes[confirm_id], scenes[removed_id]
    confirm["regions"] += [
        _button("cancel-remove", "Keep in plan", [360, 476, 180, 32], origin, "return"),
        _button("confirm-remove", "Remove from plan", [1330, 476, 230, 32], removed_id, "plan-change", "danger"),
    ]
    removed["state"].update(planMembership="removed", removedPlanItemRef=deepcopy(state["selection"]),
        removedPlanRecord=deepcopy(next(r for r in state["records"] if r["planItemRef"]["id"] == pid)),
        records=[deepcopy(r) for r in state["records"] if r["planItemRef"]["id"] != pid],
        lastMutation=dict(operation="Remove from plan", sourceClosed=False, executionChanged=False,
                          retainedHistoryDeleted=False, launchesExecution=False))
    if pid in ("plan-237", "plan-238"):
        removed["state"]["source" + pid.removeprefix("plan-") + "Planned"] = False
    removed["regions"] += [_button("restore-membership", "Restore to plan", [360, 476, 208, 32], origin, "plan-change", "primary")]
    x = 588
    for identifier in ("review-source", "open-native-thread", "invocation", "delivery-review-evidence", "auto-trigger-history"):
        region = _regions(scene).get(identifier)
        if region and region["props"].get("link"):
            action = deepcopy(region)
            action["box"] = [x, 476, max(180, region["box"][2]), 32]
            action["props"]["variant"] = "secondary"
            action["props"]["link"]["to"] = _reader_return(
                scenes, action["props"]["link"]["to"], origin, removed_id)
            removed["regions"].append(action)
            x += action["box"][2] + 12
    return confirm_id


def _intake(scenes, base):
    source = scenes["F5-C06"]
    _put(source, _button("defer-revision", "Defer this revision", [1116, 790, 230, 32], "F5-C05-DEFERRED", "plan-change"))
    _put(source, _panel("defer-effects", [340, 748, 1238, 28], [
        _line("Defer removes revision 3 from Needs triage only. Restore is available; no plan, source close or launch.", 19, 0, 12, "MUT")], "text", "none"))
    deferred = _copy(scenes, "F5-C05", "F5-C05-DEFERRED", "deferred-intake")
    deferred["title"] = "Intake · GitHub #237 revision 3 deferred"
    deferred["state"].update(triageState="Deferred", deferredSourceRef=deepcopy(base["fixtures"]["sourceIssue"]),
        lastMutation=dict(operation="Defer revision", createsPlanItem=False, closesSource=False, launchesExecution=False))
    deferred["shell"]["navTargets"] = {}
    deferred["regions"] = [r for r in deferred["regions"] if r["id"] != "candidate-238"]
    heading = _regions(deferred)["intake-heading"]["props"]["lines"]
    heading[0]["t"] = "Deferred"
    heading[1]["t"] = "Factory · Workstation · 1 deferred revision"
    deferred["caption"] = "Revision 3 is outside Needs triage, not closed or planned. Restore returns it to Needs triage; no execution starts."
    candidate = _regions(deferred)["candidate-237"]
    candidate["props"].pop("link", None)
    candidate["props"]["lines"] = [
        _line("Deferred · GitHub #237 revision 3", 28, weight=600),
        _line("Source remains Open · no plan item · no execution · restorable", 58, size=13, color="MUT"),
    ]
    _put(deferred, _button("restore-triage", "Restore to Needs triage", [340, 496, 270, 32], "F5-C05", "plan-change", "primary"))
    needs = _copy(scenes, "F5-C05", "F5-C05-AFTER-DEFER", "deferred-needs-triage")
    needs["title"] = "Intake · Needs triage after deferring revision 3"
    needs["shell"]["navTargets"] = {}
    needs["state"].update(triageState="Needs triage", deferredSourceRef=deepcopy(deferred["state"]["deferredSourceRef"]))
    needs["regions"] = [r for r in needs["regions"] if r["id"] != "candidate-237"]
    _regions(needs)["candidate-238"]["box"][1] = 192
    _regions(needs)["intake-heading"]["props"]["lines"][1]["t"] = "Factory · Workstation · 1 candidate · 1 deferred"
    needs["caption"] = "GitHub #237 revision 3 is absent from Needs triage. Open Deferred to restore that exact revision; #238 is unchanged."
    _put(needs, _button("open-deferred", "View deferred revision", [340, 496, 270, 32], deferred["id"]))
    _put(deferred, _button("needs-triage", "View Needs triage", [630, 496, 230, 32], needs["id"]))
    undone = _copy(scenes, "F5-C05", "F5-C05-UNDONE", "undone-admission")
    undone["title"] = "Intake · unstarted admission undone"
    undone["state"].update(triageState="Needs triage", source237Planned=False,
        lastMutation=dict(operation="Undo unstarted admission", guard="no invocation, native thread or external run",
                          planItemRef=deepcopy(base["fixtures"]["planItem"]), sourceClosed=False,
                          launchesExecution=False, retainedHistoryDeleted=False))
    undone["state"]["admissionHistory"] = [deepcopy(scenes["F5-C07"]["state"]["lastMutation"])]
    _put(undone, _panel("undo-effects", [340, 496, 1238, 90], [
        _line("Admission undone · GitHub #237 revision 3 restored to Needs triage", 30, weight=600),
        _line("Unstarted plan-237 membership removed. Source remains Open; admission/source history retained.", 62, size=13, color="MUT")], "notice", "neutral"))
    _put(scenes["F5-C07"], _button("undo-admission", "Undo admission", [568, 404, 216, 32], undone["id"], "plan-change"))
    _put(scenes["F5-C07"], _panel("undo-guard", [340, 454, 1238, 40], [
        _line("Undo is available only while unstarted: no invocation, thread or CI run. Returns revision 3 to Needs triage.", 25, 0, 12, "MUT")], "text", "none"))
    scenes["F5-C07"]["caption"] = "Plan-only admission receipt. Work/item links preserve the added snapshot. Explicit Undo restores revision 3 to Needs triage only while unstarted."


def _summary(scenes):
    owned = {sid: s["councilCollections"] for sid, s in scenes.items() if s.get("councilCollections", {}).get("version") == _VERSION}
    roles = {}
    for sid, entry in owned.items():
        roles.setdefault(entry["role"], []).append(sid)
    return dict(corrections=["C01", "C04", "C05", "C06", "C07 collection portions", "C09", "C10", "C11"],
                affectedSceneIds=sorted(owned), affectedSceneCount=len(owned), roles=roles,
                integration="council_collections.integrate(scenes, base) after _refine_layouts and before _finalize/_export_reachable")


def integrate(scenes, base):
    """Mutate only the supplied assembled graph; retain all dispatch identities."""
    if scenes["F5-C00"].get("councilCollections", {}).get("version") == _VERSION:
        return _summary(scenes)
    original_ids = set(scenes)
    templates = {}
    for scene in scenes.values():
        if _collection(scene) and scene["state"]["view"] == "Board":
            for region in scene["regions"]:
                if region["id"].startswith("card-plan-"):
                    templates.setdefault(region["id"].removeprefix("card-"), deepcopy(region))
    _automatic_layouts(scenes)
    collections = [s for s in list(scenes.values()) if _collection(s)]
    stage_targets = {}
    for scene in collections:
        if not _selection(scene) or scene["id"] == "F5-C09":
            continue
        target = "F5-C09" if scene["id"] == "F5-C02" else scene["id"] + "-PLANNING"
        alternate = _copy(scenes, scene["id"], target, "planning-stage")
        alternate["state"].update(planningStage="In progress", returnOrigin=target,
            lastMutation=dict(operation="Set planning stage", before="Ready", after="In progress",
                              sourceStateChanged=False, executionChanged=False, launchesExecution=False))
        for record in alternate["state"]["records"]:
            if record["planItemRef"]["id"] == _selection(scene):
                record["planningStage"] = "In progress"
        stage_targets[scene["id"]] = target
        _put(scene, _button("edit-stage", "Move to In progress", [1356, 372, 202, 32], target, "plan-change"))
        alternate["regions"] = [r for r in alternate["regions"] if r["id"] != "edit-stage"]
        _put(alternate, _button("reverse-stage", "Move back to Ready", [1356, 372, 202, 32], scene["id"], "plan-change"))
    _context_copies(scenes, stage_targets, original_ids)
    collections = [s for s in list(scenes.values()) if _collection(s)]
    for scene in collections:
        scene.setdefault("councilCollections", dict(version=_VERSION, role="collection", origin=scene["id"]))
        inspector = _inspector(scene)
        if inspector:
            for line in inspector["props"]["lines"]:
                if line["t"] == "Stage":
                    line["t"] = "Planning stage"
                elif line["y"] == 222:
                    line["t"] = scene["state"]["planningStage"]
                elif line["y"] == 642:
                    line["y"] = 620
            shift = 444 if scene["state"]["view"] == "Board" else 0
            old_x = inspector["box"][0]
            inspector["box"][0] = 1158 + shift
            for region in scene["regions"]:
                if region is not inspector and region["box"][0] >= old_x:
                    region["box"][0] += shift
            divider = _regions(scene).get("resizable-divider")
            if divider:
                divider["box"][0] = 1146 + shift
            _native_thread(scenes, scene)
            source_id = _source_reader(scenes, scene)
            _put(scene, _button("review-source", "Review source", [1410 + shift, 423, 148, 32], source_id))
            if "auto-trigger-history" in _regions(scene):
                control = _regions(scene)["auto-trigger-history"]
                control["props"]["link"]["to"] = _reader_return(
                    scenes, control["props"]["link"]["to"], "F5-C13", scene["id"])
            removal_id = _removal(scenes, scene)
            _put(scene, _button("remove-from-plan", "Remove from plan…", [1178 + shift, 774 if inspector["id"] == "auto-inspector" else 812, 218, 32], removal_id))
            _put(scene, _panel("planning-effects", [1178 + shift, 810 if inspector["id"] == "auto-inspector" else 628, 376, 40], [
                _line("Planning edits do not start or stop execution.", 17, 0, 12, "MUT"),
                _line("Source status and history stay unchanged.", 36, 0, 12, "MUT")], "text", "none"))
            regs = _regions(scene)
            if "open-native-thread" in regs:
                regs["open-native-thread"]["props"]["variant"] = "primary"
                regs["open-native-thread"]["box"][1] = 696
                if "invocation" in regs:
                    regs["invocation"]["box"][1] = 738
            if "delivery-review-evidence" in regs:
                regs["delivery-review-evidence"]["props"]["variant"] = "primary"
                regs["delivery-review-evidence"]["box"][1] = 696
                if "invocation" in regs:
                    regs["invocation"]["box"][1] = 738
        _record_regions(scene, templates)
        if scene["state"]["view"] == "Board":
            _put(scene, _panel("planning-heading", [340, 152, 1240, 22], [
                _line("Planning stage · " + ("Expanded board · 298 px columns" if inspector else "Execution is labelled separately on every card"), 16, 0, 12, "MUT")], "text", "none"))
        if "open-intake" in _regions(scene):
            _regions(scene)["open-intake"]["box"] = [1360, 844, 214, 32]
        active = {r["id"] for r in scene["regions"] if r.get("props", {}).get("link")}
        scene["staticControls"] = [entry for entry in scene.get("staticControls", [])
                                   if entry.split(":", 1)[0] not in active
                                   and not entry.startswith("The trigger binding is read in its source-owned")]
        if _selection(scene) == "plan-238":
            scene["staticControls"].append("Intake, source editing, resize and companion selection remain static. No native thread association has been observed.")
    _intake(scenes, base)
    for sid in ("F5-C06", "F5-C07"):
        scenes[sid]["councilCollections"] = dict(version=_VERSION, role="intake-decision", origin=sid)
    for sid, scene in list(scenes.items()):
        if sid != "F5-P-MORE" and scene.get("councilCollections") and scene["shell"].get("mode", "workspace") in ("workspace", "settings"):
            _allow_back(scenes["F5-P-MORE"], sid)
    return _summary(scenes)
