"""Connect illustrative operations readers without changing source execution records.

The parent loads operations.json, then calls integrate after configuration/catalog
assembly and before source-return/finalize/reachability. No IO or renderer imports.
Native Back is used only inside read-only readers with one explicit origin.

Reference mechanisms: build_workspace.py:144-202 supplies the region/link IR;
experience-contract.md:60-70 supplies kinds, effects and origin-return semantics.
No executable vendor templates or source from another checkout are reused.
"""
from copy import deepcopy


TOOLCHAIN_ROOT = "F5-O-00"
ATTENTION_ROOT = "F5-O-10"
_TOOLCHAIN_FAMILY = ("F5-O-00", "F5-O-01", "F5-O-02", "F5-O-03")
_OPERATIONS_BASE = "58f2e10000000000000000000000000000000000"


def _line(text, y, size=14, color="FG", weight=400, x=16):
    return {"t": str(text), "x": x, "y": y, "s": size, "c": color, "w": weight}


def _region(identifier, kind, box, lines, style="panel"):
    return {"id": identifier, "kind": kind, "box": box,
            "props": {"style": style, "lines": lines}}


def _button(identifier, label, box, target, edge, effect="navigation", origin=None):
    link = {"edge": edge, "to": target, "type": "navigate", "effect": effect}
    if origin is not None:
        link.update(type="back", allowedOrigins=[origin])
    return {"id": identifier, "kind": "button", "box": box,
            "props": {"label": label, "size": 14, "variant": "secondary", "link": link}}


def _back(scene, origin):
    scene["regions"].append(_button(
        "ops-context-back", "Back", [1380, 818, 180, 32], origin,
        "F5-OE-" + scene["id"] + "-back", "return", origin))


def _rekey(scene):
    """Give every derived pin/control a stable scene-qualified edge identity."""
    for region in scene["regions"]:
        link = region.get("props", {}).get("link")
        if link:
            link["edge"] = "F5-OE-" + scene["id"] + "-" + region["id"]


def _version(base):
    entry = next(item for item in base["workflowCatalog"] if item["id"] == "wf-review-change")
    return {"environmentId": base["project"]["environmentId"],
            "projectId": base["project"]["id"], "workflowId": entry["id"],
            "version": entry["version"], "digest": entry["digest"],
            "sourceCommit": base["fixtures"]["workflowSourceCommit"]}


def _pins(base, identifier, fourth):
    version = _version(base)
    fixtures = base["fixtures"]
    return _region(identifier, "code", [360, 194, 1200, 120], [
        _line("wf-review-change v1 · definition commit " + version["sourceCommit"], 24, 12, "MUT"),
        _line("Definition SHA-256  " + version["digest"], 52, 12),
        _line("Candidate commit  " + fixtures["candidateCommit"], 80, 12),
        _line(fourth, 108, 12, "MUT"),
    ], "code")


def _operation_records(scenes, base):
    project = base["project"]
    fixtures = base["fixtures"]
    source = fixtures["sourceIssue"]
    input_refs = {
        "sourceRef": {"provider": source["provider"], "repository": source["repository"],
                      "number": source["number"], "revision": source["revision"]},
        "planItemRef": deepcopy(fixtures["planItem"]),
        "linkedWorkRef": deepcopy(fixtures["retainedWorkAfterFactoryAdmission"]),
    }
    original_invocation = {"environmentId": project["environmentId"],
                           "projectId": project["id"], "id": "inv-f5-ops-remote-01"}
    writer = {"environmentId": "env-mac", "threadId": "th-f5-ops-remote-01",
              "runId": "run-f5-ops-remote-01", "writerEpoch": 12}
    snapshot = {
        "id": "ops-snapshot-01", "evidenceClass": "illustrative retained snapshot, not runtime attestation",
        "workflowVersionRef": _version(base), "candidateCommit": fixtures["candidateCommit"],
        "comparisonBaseCommit": _OPERATIONS_BASE, "targetBaseCommit": _OPERATIONS_BASE,
        "inputs": deepcopy(input_refs), "configurationSnapshotRef": "ops-config-snapshot-01",
        "policySnapshotRef": "ops-review-only-policy-01",
        "coordinatorBinding": {"environmentId": project["environmentId"], "projectId": project["id"],
                               "threadId": "th-f5-ops-coordinator-01", "revision": 7,
                               "kind": "ordinary-native-thread", "additionalAuthority": []},
        "requiredBytes": ["definition", "inputs", "candidate", "base", "configuration", "policy", "coordinator-binding"],
        "availability": "complete in this illustrative branch; missing or digest-mismatched bytes hold in the product contract",
        "carriedAuthority": [], "credentialsIncluded": False,
    }
    for identifier in ("F5-O-20", "F5-O-21", "F5-O-22", "F5-O-23", "F5-O-24"):
        scene = scenes[identifier]
        state = scene["state"]
        state.update(projectId=project["id"], environmentId=project["environmentId"],
                     workflowVersionRef=_version(base), evidenceClass="illustrative-control-record")
        state["bindingRef"] = {"environmentId": project["environmentId"], "projectId": project["id"],
                               "id": state["bindingId"]}
        state["priorAdmissionRecords"] = [
            {"environmentId": project["environmentId"], "projectId": project["id"],
             "bindingId": state["bindingId"], "window": "window1", "id": "ops-window1-admission-0" + str(n)}
            for n in (1, 2, 3)
        ]
        state["survivors"] = ["queued-messages", "active-writers", "authorized-corrections",
                              "started-hosted-jobs", "independent-pr-watch-wakes", "ordinary-coordinator"]
        state["sharedGuardCapability"] = "not-established"
        state["definitionDigestUnchanged"] = _version(base)["digest"]
        scene["regions"].insert(1, _pins(base, "ops-binding-pin",
            "BindingRef  env-ws / project-factory / ops-timer-study · separate version-scoped control record"))
        scene["staticControls"] = ["Bound values are the reviewed fixture, not a general text editor",
                                     "No run-level brake, global cancellation or spending-stop control"]
    disabled = {
        "id": "F5-O-25", "title": "Operations · Binding disabled after review",
        "shell": {"mode": "workspace", "section": "Workflows",
                  "breadcrumb": "Admission bound / Disabled", "navTargets": {}},
        "tag": "Illustrative control receipt · AB:66",
        "caption": "Alternative terminal decision after reviewing the held bound. Disable clears this binding's capacity attention reason, not execution ownership. No route reopens an earlier actionable snapshot. Restart the study for another branch.",
        "state": {**deepcopy(scenes["F5-O-20"]["state"]), "phase": "disabled",
                  "bindingState": "disabled", "controlRevision": 2,
                  "attentionClearingFact": "explicit owner disable", "invocationsStartedByControl": []},
        "regions": [
            _region("ops-title", "text", [360, 118, 1200, 58], [
                _line("This binding is disabled", 24, 20, weight=600, x=0),
                _line("Mara · alternative reviewed decision · 11:11 UTC", 50, 12, "MUT", x=0)], "none"),
            _pins(base, "ops-disabled-pin", "BindingRef  env-ws / project-factory / ops-timer-study"),
            _region("ops-disabled-receipt", "notice", [360, 336, 1200, 188], [
                _line("No future automatic dispatch from this binding", 30, 18, weight=600),
                _line("Window1 stays retained at 3/3 with its original 18:00 UTC expiry. No count or definition digest resets.", 70),
                _line("Manual workflow runs remain separate, subject to their own prerequisites and permission.", 110),
                _line("Disabling does not stop active/queued work, corrections, hosted jobs, PR watches or the coordinator.", 150)]),
            _region("ops-disabled-boundary", "notice", [360, 548, 1200, 110], [
                _line("The uncertain remote writer keeps its ownership record and attention reason.", 30, 14, "WARN"),
                _line("Independent host rules remain active under their own owners. No global cancellation or budget stop.", 70)]),
        ],
    }
    scenes[disabled["id"]] = disabled
    scenes["F5-O-20"]["regions"].append(_button("ops-disable-held-binding",
        "Disable this binding", [524, 818, 238, 32], disabled["id"],
        "F5-OE-20-disable", "configuration-change"))
    for identifier in ("F5-O-30", "F5-O-31", "F5-O-32", "F5-O-33"):
        scene = scenes[identifier]
        state = scene["state"]
        state.update(projectId=project["id"], environmentId=project["environmentId"],
                     workflowVersionRef=_version(base), candidateCommit=fixtures["candidateCommit"],
                     inputRefs=deepcopy(input_refs), originalInvocationRef=deepcopy(original_invocation),
                     originalWriter=deepcopy(writer), evidenceClass="illustrative-recovery-record")
        state["invocationQualifiedRef"] = {"environmentId": project["environmentId"],
            "projectId": project["id"], "id": state.get("invocationRef", original_invocation["id"])}
        state["replayCannotReplaceUncertainWriter"] = True
        if identifier in ("F5-O-32", "F5-O-33"):
            state["frozenSnapshot"] = deepcopy(snapshot)
        scene["regions"].insert(1, _pins(base, "ops-recovery-pin",
            "Comparison/target base  " + _OPERATIONS_BASE + " · independent operations fixture"))
        scene["staticControls"] = ["No duplicate stop, replacement or retry-elsewhere command",
                                     "No hosted cancellation or real external acknowledgement action"]
    # The replay input links Work, Source and Plan without making any of them its native thread.
    scenes["F5-O-33"]["state"]["replayOfQualifiedRef"] = deepcopy(original_invocation)
    # Detailed retained snapshot text is an ordinary read-only nested record.
    detail = {
        "id": "F5-O-34", "title": "Recovery · Frozen replay inputs",
        "shell": {"mode": "workspace", "section": "Workflows", "breadcrumb": "Recovery / Frozen inputs", "navTargets": {}},
        "tag": "Read-only illustrative snapshot · AB:66",
        "caption": "Snapshot references identify illustrative retained inputs, not measured file hashes or proof that real bytes exist. Product replay must verify all required bytes/digests and hold on missing data. No authority is restored.",
        "state": {"readOnly": True, "operationsKind": "replay-inputs", "frozenSnapshot": deepcopy(snapshot)},
        "regions": [
            _region("ops-title", "text", [360, 118, 1200, 58], [
                _line("Frozen replay inputs", 24, 20, weight=600, x=0),
                _line("ops-snapshot-01 · separate illustrative recovery branch", 50, 12, "MUT", x=0)], "none"),
            _pins(base, "ops-snapshot-pin", "Comparison/target base  " + _OPERATIONS_BASE),
            _region("ops-snapshot-inputs", "card", [360, 336, 1200, 180], [
                _line("Input references remain qualified and separate", 30, 18, weight=600),
                _line("SourceRef  github / acme/factory / #237 / revision3", 70),
                _line("PlanItemRef  env-ws / project-factory / plan-237", 108),
                _line("Linked WorkRef  v1 / env-ws / issue / 8b42f1d3 · input only, not the remote/replay thread", 146)]),
            _region("ops-snapshot-config", "card", [360, 536, 1200, 230], [
                _line("Configuration and policy are frozen with the invocation", 30, 18, weight=600),
                _line("Configuration snapshot  ops-config-snapshot-01 · no installer, hook change or credential", 70),
                _line("Policy snapshot  ops-review-only-policy-01 · read candidate and write evidence report only", 108),
                _line("Coordinator  env-ws / project-factory / th-f5-ops-coordinator-01 / binding revision7", 146),
                _line("The coordinator is an ordinary thread. Its binding is context, not an execution engine or extra authority.", 180),
                _line("Verify retained definition, input, candidate, base, configuration, policy and binding bytes before launch.", 214, 12, "WARN")]),
        ], "staticControls": ["Frozen bytes are illustrative records, not executable runtime inputs"]}
    _back(detail, "F5-O-32")
    scenes[detail["id"]] = detail
    scenes["F5-O-32"]["regions"].append(_button("ops-inspect-snapshot", "Inspect frozen inputs", [360, 818, 248, 32],
        detail["id"], "F5-OE-32-inputs"))
    replay_thread = {
        "id": "F5-O-35", "title": "Thread · Evidence-only replay",
        "shell": {"mode": "thread", "section": "Workflows",
                  "breadcrumb": "Evidence-only replay", "navTargets": {}},
        "tag": "Illustrative ordinary native thread",
        "caption": "Native thread geometry follows the existing F5 working thread. This new evidence-only invocation has no observed provider start, output, acceptance or delivery. Opening it starts nothing. Back reads the current accepted replay receipt, never the earlier launch preview.",
        "state": {**deepcopy(scenes["F5-O-33"]["state"]), "readOnly": True,
                  "nativeExecution": "dispatch-accepted", "retainedWorkRef": None,
                  "threadContext": {"owner": "env-ws", "composer": "ordinary native thread"}},
        "regions": [
            _region("ops-native-user", "row", [432, 140, 736, 150], [
                _line("Mara · 11:18 UTC · explicit evidence-only replay", 28, 12, "MUT"),
                _line("Inspect the frozen candidate and inputs. Return new evidence only.", 66),
                _line("Do not replace a writer or reuse acceptance and delivery authority.", 104)]),
            _region("ops-native-dispatch", "row", [432, 320, 736, 126], [
                _line("Dispatch accepted", 30, 14, weight=600),
                _line("Provider start has not yet been observed. No output is available.", 70),
                _line("inv-f5-ops-replay-01 · th-f5-ops-replay-01", 104, 12, "MUT")]),
            _region("ops-native-evidence", "card", [432, 478, 736, 104], [
                _line("Fresh evidence receipts: none", 30, 14, weight=600),
                _line("Original receipts remain comparison only. This execution has no verdict.", 70)]),
            _region("ops-native-composer", "composer", [416, 716, 768, 144], [
                _line("Follow-up message", 34, 14, "MUT"),
                _line("Native composer shown read-only in this bounded study", 118, 12, "MUT")], "composer"),
            _region("ops-native-environment", "card", [1280, 116, 280, 140], [
                _line("Environment", 28, 14, weight=600),
                _line("Workstation · env-ws", 64, 12),
                _line("Isolated replay worktree", 100, 12, "MUT")]),
            _region("ops-native-context", "card", [1280, 272, 280, 264], [
                _line("Invocation context", 28, 14, weight=600),
                _line("inv-f5-ops-replay-01", 66, 12),
                _line("Thread th-f5-ops-replay-01", 102, 12),
                _line("replayOf inv-f5-ops-remote-01", 138, 12),
                _line("Factory · evidence only", 174, 12),
                _line("Acceptance / grant: none", 210, 12, "MUT"),
                _line("No production replacement", 242, 12, "WARN")]),
        ],
        "staticControls": ["Native composer, attachments and send are not connected"],
    }
    _back(replay_thread, "F5-O-33")
    scenes[replay_thread["id"]] = replay_thread
    scenes["F5-O-33"]["regions"].append(_button("ops-open-replay-thread",
        "Open native replay thread", [360, 818, 284, 32], replay_thread["id"], "F5-OE-33-thread"))
    for identifier in ("F5-O-22", "F5-O-23", "F5-O-24", "F5-O-25",
                       "F5-O-31", "F5-O-32", "F5-O-33", "F5-O-34"):
        record = scenes[identifier]
        record["shell"]["projectNavigationStatic"] = True
        record["caption"] += " Project navigation is prototype-static here; only named current-state continuations are linked."


def _reader_family(scenes, templates, origin):
    """Clone the four read-only toolchain pages for an exact entry snapshot."""
    mapping = {key: key + "-FROM-" + origin for key in _TOOLCHAIN_FAMILY}
    for key in _TOOLCHAIN_FAMILY:
        scene = deepcopy(templates[key])
        scene["id"] = mapping[key]
        scene["state"]["readerOrigin"] = origin
        scene["state"]["sourceContextSnapshot"] = deepcopy(scenes[origin]["state"])
        scene["caption"] += " Read-only lookup; Back restores the exact entry snapshot."
        for region in scene["regions"]:
            link = region.get("props", {}).get("link")
            if link:
                if link["to"] in mapping:
                    link["to"] = mapping[link["to"]]
                if "allowedOrigins" in link:
                    link["allowedOrigins"] = [mapping.get(item, item) for item in link["allowedOrigins"]]
        if key == TOOLCHAIN_ROOT:
            _back(scene, origin)
        _rekey(scene)
        scenes[scene["id"]] = scene
    return mapping[TOOLCHAIN_ROOT]


def _setup_diff_reader(scenes, origin, toolchain_target):
    source = scenes.get("F5-W02")
    if source is None:
        return
    scene = deepcopy(source)
    scene["id"] = "F5-O-04-FROM-" + origin
    scene["title"] = "Toolchain · Reviewed initialization diff · read-only"
    scene["shell"] = {"mode": "workspace", "section": "Workflows", "breadcrumb": "Toolchain / Reviewed diff", "navTargets": {}}
    scene["state"] = {"operationsKind": "initialization-diff-reader", "readOnly": True,
                      "readerOrigin": toolchain_target, "sourceContextSnapshot": deepcopy(source["state"])}
    scene["regions"] = [region for region in scene["regions"] if region["kind"] != "button"]
    for region in scene["regions"]:
        region.get("props", {}).pop("link", None)
    scene["caption"] = "Read-only copy of the actual authored initialization diff. This does not save, commit, push, enable tooling or reopen setup. Existing guidance/hooks remain unchanged. Back returns to the same Toolchain lookup."
    _back(scene, toolchain_target)
    _rekey(scene)
    scenes[scene["id"]] = scene
    scenes[toolchain_target]["regions"].append(_button(
        "ops-reviewed-setup-diff", "Read initialization diff", [632, 818, 264, 32], scene["id"],
        "F5-OE-" + toolchain_target + "-diff"))


def _execution_reader(scenes, base, source, templates):
    origin = source["id"]
    state = deepcopy(source["state"])
    identifier = "F5-O-40-FROM-" + origin
    target = state.get("target", "Factory")
    invocation = state["invocationRef"]
    project = state.get("projectId", base["project"]["id"])
    environment = state.get("environmentId", base["project"]["environmentId"])
    external_run = state.get("externalCIRun") or state.get("externalRunId")
    work = state.get("retainedWorkRef")
    work_label = "none" if not work else "v" + str(work["version"]) + " / " + work["environmentId"] + " / " + work["kind"] + " / " + work["id"]
    plan = state.get("selection")
    plan_label = "none bound" if not plan else plan["environmentId"] + " / " + plan["projectId"] + " / " + plan["id"]
    source_ref = state.get("sourceRef") or state.get("source")
    source_label = "none bound" if not source_ref else source_ref["provider"] + " / " + source_ref["repository"] + " / #" + str(source_ref["number"]) + " / rev" + str(source_ref["revision"])
    evidence = state.get("evidence", {})
    report = evidence.get("report", "not attached")
    provenance = evidence.get("origin", "No completed report source attached to this snapshot")
    stage = state.get("execution") or state.get("providerState") or state.get("dispatch", "unknown")
    scene = {
        "id": identifier, "title": target + " invocation · Checks & ownership",
        "shell": {"mode": "workspace", "section": "Workflows", "breadcrumb": "Invocation / Checks & ownership", "navTargets": {}},
        "tag": "Read-only exact-context evidence lookup",
        "caption": "Reads this invocation's existing snapshot only. Missing check/tool receipts are not green. Review output, provider completion, acceptance and delivery remain separate. Back restores the exact Factory/CI/thread entry without dispatch or mutation.",
        "state": {**state, "readOnly": True, "operationsKind": "invocation-evidence", "readerOrigin": origin,
                  "invocationQualifiedRef": {"environmentId": environment, "projectId": project, "id": invocation}},
        "regions": [
            _region("ops-title", "text", [360, 118, 1200, 58], [
                _line("Checks & ownership", 24, 20, weight=600, x=0),
                _line(environment + " / " + project + " / " + invocation + " · " + target + " · " + stage, 50, 12, "MUT", x=0)], "none"),
            _region("ops-exact-pins", "code", [360, 194, 1200, 120], [
                _line("Definition commit  " + state["workflowSourceCommit"], 24, 12, "MUT"),
                _line("Definition SHA-256  " + state["workflowDigest"], 52, 12),
                _line("Candidate commit  " + state["candidateCommit"], 80, 12),
                _line("Owner  " + ("GitHub Actions · external run " + str(external_run) if target == "CI" else "Factory orchestration · " + environment), 108, 12, "MUT")], "code"),
            _region("ops-input-identity", "card", [360, 336, 1200, 174], [
                _line("Qualified input and execution identities", 30, 18, weight=600),
                _line("SourceRef  " + source_label, 66),
                _line("PlanItemRef  " + plan_label, 100),
                _line("Retained WorkRef  " + work_label, 134),
                _line("Native T3 thread  " + str(state.get("nativeThreadId") or "none; an external CI run is not a thread"), 158, 12, "MUT")]),
            _region("ops-invocation-evidence", "card", [360, 530, 1200, 188], [
                _line("Evidence attached to this snapshot", 30, 18, weight=600),
                _line("Review report  " + report + " · acceptance " + str(state.get("acceptance", "not reviewed")), 68),
                _line("Source  " + provenance, 102, 12, "MUT"),
                _line("Local tests/build/secret scan receipts: not attached. Required host policy: unknown in this snapshot.", 140, 14, "WARN"),
                _line("A completed review report or a neutral/successful host check is not a clean verdict or permission to deliver.", 172, 12, "MUT")]),
        ],
        "staticControls": ["No installer, receipt generator, hosted request or delivery action"]}
    _back(scene, origin)
    scenes[identifier] = scene
    root = _reader_family(scenes, templates, identifier)
    scene["regions"].append(_button("ops-toolchain-detail", "Toolchain & checks", [360, 818, 244, 32], root,
        "F5-OE-" + identifier + "-toolchain"))
    return identifier


def integrate(scenes, base) -> None:
    """Mutate only the supplied scene map; preserve all original state dictionaries."""
    templates = {key: deepcopy(scenes[key]) for key in _TOOLCHAIN_FAMILY}
    _operation_records(scenes, base)
    # Parent owns More/catalog navigation. These roots merely close their read-only entry.
    if "F5-P-MORE" in scenes:
        _back(scenes[TOOLCHAIN_ROOT], "F5-P-MORE")
        _back(scenes[ATTENTION_ROOT], "F5-P-MORE")
    for source in list(scenes.values()):
        identifier = source["id"]
        if identifier.startswith("F5-O-") or identifier.startswith("F5-W03"):
            continue
        state = source.get("state", {})
        is_setup = identifier in ("F5-W00", "F5-W01", "F5-W02", "F5-W12")
        is_version = identifier == "F5-W04"
        is_receipt = any(identifier == key or identifier.startswith(key + "-")
                         for key in ("F5-W07", "F5-W09", "F5-W10"))
        is_thread = identifier.startswith("F5-P-THREAD-") and source["shell"].get("mode") == "thread"
        if is_setup or is_version:
            target = _reader_family(scenes, templates, identifier)
            if is_setup:
                _setup_diff_reader(scenes, identifier, target)
            source["regions"].append(_button("ops-toolchain-mount", "Toolchain & checks", [1300, 130, 260, 32], target,
                "F5-OE-" + identifier + "-toolchain"))
        elif (is_receipt or is_thread) and all(key in state for key in (
                "invocationRef", "workflowSourceCommit", "workflowDigest", "candidateCommit")):
            target = _execution_reader(scenes, base, source, templates)
            box = [1296, 772, 248, 32] if is_thread else [1300, 130, 260, 32]
            source["regions"].append(_button("ops-evidence-mount", "Checks & ownership", box, target,
                "F5-OE-" + identifier + "-evidence"))
