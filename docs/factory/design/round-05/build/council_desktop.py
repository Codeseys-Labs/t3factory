"""Bounded desktop SOURCE specimens using existing region/link IR; no IO.

Call after council_collections.integrate, before council_parent and _finalize.
Horizontal positions are explicit static scenes, not a clipping/scroll engine.
"""
from copy import deepcopy


VERSION = "council-desktop-01"
CANONICAL = ("F5-C02", "F5-C09", "F5-C10", "F5-C10-PLANNING", "F5-C13", "F5-C13-PLANNING",
             "F5-C15", "F5-C10-BINDING-ISSUE-ENABLED-MANUAL")
STAGES = ("Backlog", "Ready", "In progress", "Done")


def _text(identifier, box, text, size=12, color="MUT"):
    return dict(id=identifier, kind="text", box=list(box), props=dict(style="none",
        lines=[dict(t=text, x=0, y=size+2, s=size, c=color)]))


def _button(identifier, box, label, target=None, effect="navigation"):
    props = dict(label=label, size=12, variant="secondary" if target else "disabled")
    if target:
        props["link"] = dict(to=target, type="navigate", effect=effect)
    return dict(id=identifier, kind="button", box=list(box), props=props)


def _default(scene):
    return 1 if scene["state"]["planningStage"] == "In progress" else 0


def _id(origin, width, position, closed, default):
    if width == 1600 and position == default and not closed:
        return origin
    return f"{origin}-D{width}-{'SCAN' if closed else 'P'}{position}"


def _specimen(source, width, position, closed):
    scene = deepcopy(source)
    origin, default = source["id"], _default(source)
    sid = _id(origin, width, position, closed, default)
    scene["id"] = sid
    scene["canvas"] = dict(width=width, height=1040)
    start = 340 if width == 1600 else 68
    inspector_x = width - 442
    capacity = (4 if width == 1600 else 3) if closed else 2
    end = width - 20 if closed else inspector_x - 18
    original_inspector = next(r for r in source["regions"] if r["id"] in ("selected-inspector", "auto-inspector"))
    old_x = original_inspector["box"][0]
    selected = source["state"]["selection"]["id"]
    scene["shell"]["mode"] = "workspace" if width == 1600 else "narrow"
    scene["shell"].setdefault("navTargets", {})["Work"] = sid
    if sid != origin:
        scene["shell"]["projectNavigationStatic"] = True
        scene["shell"]["navTargets"].pop("More", None)
    if closed:
        scene["state"]["selection"] = None
        scene["shell"]["navTargets"] = {"Work": sid}
    scene["councilDesktop"] = dict(version=VERSION, origin=origin, role="scan" if closed else "selected",
        viewportWidth=width, sidebar="expanded" if width == 1600 else "collapsed",
        position=position, visibleStages=list(STAGES[position:position+capacity]),
        columnWidth=298, columnPitch=314, inspectorWidth=0 if closed else 420,
        inspectorOpen=not closed, canonicalReturn=origin,
        selectionContext=deepcopy(source["state"]["selection"]),
        qualification="Authored viewport and horizontal-position specimen; not responsive or scrolling behavior.")
    regions = []
    for original in source["regions"]:
        r = deepcopy(original)
        rid = r["id"]
        if rid in ("planning-heading", "record-count", "resizable-divider"):
            continue
        if rid.startswith(("column-", "card-plan-")):
            index = (r["box"][0] - 340) // 314
            if not position <= index < position + capacity:
                continue
            r["box"][0] += start - 340 - position * 314
            if rid.startswith("card-plan-") and closed:
                r["props"]["style"] = "panel"
                r["props"].pop("link", None)
                if rid == "card-" + selected:
                    open_position = min(max(STAGES.index(source["state"]["planningStage"])-1, 0), 2)
                    r["props"]["link"] = dict(to=_id(origin, width, open_position, False, default),
                        type="navigate", effect="navigation")
            regions.append(r)
            continue
        if r["box"][0] >= old_x and r["box"][1] >= 176:
            if closed:
                continue
            r["box"][0] += inspector_x - old_x
        else:
            r["box"][0] += start - 340
        if rid.startswith("layout-") and closed:
            r["props"].pop("link", None)
        if rid == "query-filter":
            r["box"][2] = 180
        if rid == "project-scope":
            r["box"][3] = 44
        regions.append(r)
    regions.append(_text("planning-heading", [start, 152, 612, 22], "Planning stage · Execution is labelled on every card"))
    if not closed:
        regions.append(dict(id="resizable-divider", kind="rule", box=[inspector_x-12, 176, 1, 678], props={}))
    count_x = end-300 if closed else inspector_x
    regions.append(_text("record-count", [count_x, 152, 300, 22],
                         f"{len(source['state']['records'])} project items · stage order"))
    target_position = min(position, 0 if width == 1600 else 1)
    regions.append(_button("desktop-inspector-toggle", [width-156, 118, 134, 32],
        "Show details" if closed else "Close details",
        _id(origin, width, default if closed else target_position, not closed, default)))
    maximum = 4-capacity
    label = f"Stages {position+1}–{position+capacity} of 4"
    regions.append(_text("desktop-position", [start+118, 865, 440, 24],
                         label + (" · Scroll horizontally" if maximum else " · All stages visible")))
    regions.append(_button("desktop-earlier", [start, 860, 100, 32], "← Earlier",
        _id(origin, width, position-1, closed, default) if position else None))
    regions.append(_button("desktop-later", [end-100, 860, 100, 32], "Later →",
        _id(origin, width, position+1, closed, default) if position < maximum else None))
    if maximum:
        track_width = end-start
        regions.append(dict(id="desktop-scroll-track", kind="card", box=[start, 842, track_width, 6],
            props=dict(style="field", shapes=[dict(type="rect", x=track_width*position/4, y=0,
                w=track_width*capacity/4, h=6, style="selected")])))
    rail_x = start + capacity*314
    rail_width = end-rail_x
    if maximum and rail_width >= 100:
        regions.append(_text("desktop-offscreen", [rail_x, 184, rail_width, 26], "Offscreen stages"))
        for row, index in enumerate(i for i in range(4) if not position <= i < position+capacity):
            regions.append(_button("desktop-stage-"+str(index), [rail_x, 224+row*42, rail_width, 32],
                STAGES[index] + (" →" if index > position else " ←"),
                _id(origin, width, min(index, maximum), closed, default)))
    scene["regions"] = regions
    other_width = 1280 if width == 1600 else 1600
    other_position = min(position, (1 if other_width == 1280 else 0) if closed else 2)
    scene["studyLinks"] = [_button("desktop-viewport-specimen", [width-250, 982, 226, 32],
        f"Study: {other_width}px viewport", _id(origin, other_width, other_position, closed, default), "history-read")]
    scene["title"] = "Work · " + source["state"]["planningStage"] + (" · scan" if closed else " · details")
    scene["tag"] = f"{width}px VIEWPORT SPECIMEN"
    scene["caption"] = "Static positions; no live scrolling or resizing. Existing readers return to the canonical 1600px selection."
    scene["staticControls"] = deepcopy(source.get("staticControls", [])) + [
        "Earlier/Later and offscreen-stage controls navigate authored horizontal positions; the scrollbar is static, not draggable.",
        "Viewport study links switch explicitly authored frames, not responsive breakpoints. The 1280px specimen uses the existing collapsed sidebar shell.",
        "Original workflow, layout, source, removal and execution links retain their exact canonical destinations and returns; pan/viewport is reset on return.",
        "Close details removes selection and inspector only; Show details or the former selected card restores that same record. Other card selections remain static.",
    ]
    if closed:
        scene["staticControls"].append("Scan Table/List and Workflows are outside this bounded no-selection corridor; no hidden selection is passed to them.")
    return scene


def integrate(scenes, base):
    """Preserve original IDs, fixtures, state identities and existing action targets."""
    if all(scenes[sid].get("councilDesktop", {}).get("version") == VERSION for sid in CANONICAL):
        return _summary(scenes)
    if any(scenes[sid].get("councilDesktop") for sid in CANONICAL):
        raise ValueError("Partial desktop integration: reassemble the unmodified input graph first")
    for sid in CANONICAL:
        if not scenes[sid].get("councilCollections"):
            raise ValueError("council_desktop requires council_collections first: " + sid)
    sources = {sid: deepcopy(scenes[sid]) for sid in CANONICAL}
    pending = {}
    for source in sources.values():
        for width in (1600, 1280):
            for closed in (False, True):
                capacity = (4 if width == 1600 else 3) if closed else 2
                for position in range(5-capacity):
                    scene = _specimen(source, width, position, closed)
                    if scene["id"] in scenes and scene["id"] not in CANONICAL:
                        raise ValueError("Desktop specimen ID already owned: " + scene["id"])
                    pending[scene["id"]] = scene
    scenes.update(pending)
    return _summary(scenes)


def _summary(scenes):
    ids = sorted(sid for sid, s in scenes.items() if s.get("councilDesktop", {}).get("version") == VERSION)
    return dict(version=VERSION, canonical=list(CANONICAL), affectedSceneIds=ids,
        affectedSceneCount=len(ids), newSceneCount=len(ids)-len(CANONICAL),
        integration="after council_collections; before council_parent and _finalize",
        qualification="Static desktop source and viewport specimens only; no native/runtime acceptance.")
