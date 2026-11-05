"""Author F5-FLOW / F5-DATA using Round04's measured SVG and diagram helpers.

Parent command: python round-05/build/build_f5_diagrams.py
Use --svg-only to defer PNG rendering. This module has not been executed by its author.
No scene integration, prototype wiring, network, provider or application operations.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROUND = HERE.parent
HELPERS = ROUND.parent / "round-04" / "build"
sys.path.insert(0, str(HELPERS))

import svgkit as K
from build_diagrams import Board, TAG_STYLE, rects_hit
from render import render

WIDTH = 3000
MARGIN = 48
GAP = 160
PAD = 20
BODY = 14
SECONDARY = 12
LINE = 21
OUT = ROUND / "screens"


def interpolate(value, base):
    def replace(match):
        found = base
        for part in match.group(1).split("."):
            found = found[int(part)] if isinstance(found, list) else found[part]
        if isinstance(found, (dict, list)):
            raise ValueError(f"Fixture substitution must be scalar: {match.group(1)}")
        return str(found)

    if isinstance(value, str):
        return re.sub(r"\$\{([A-Za-z0-9_.]+)\}", replace, value)
    if isinstance(value, list):
        return [interpolate(item, base) for item in value]
    if isinstance(value, dict):
        return {key: interpolate(item, base) for key, item in value.items()}
    return value


def lines(cv, text, width, size=BODY, weight=400):
    wrapped = cv.wrap(text, width, size, weight)
    for line in wrapped:
        if K.text_width(line, size, weight) > width:
            raise ValueError(f"Unbreakable text exceeds measured width: {line}")
    return wrapped


def paragraph(cv, x, y, text, width, size=BODY, color=None, weight=400):
    wrapped = lines(cv, text, width, size, weight)
    leading = LINE if size <= BODY else 26
    for line in wrapped:
        cv.txt(x, y, line, size, color or K.MUT, weight)
        y += leading
    return y


def style(kind):
    if kind == "native":
        return TAG_STYLE["Existing"]
    if kind == "candidate":
        return TAG_STYLE["Refinement"]
    if kind in ("held", "unresolved"):
        return "#231414", "#784343", K.RED
    return TAG_STYLE["Gated"]


def card_lines(cv, obj, width):
    fields = [
        (obj["basisLabel"], SECONDARY, 600, "basis"),
        (obj["title"], 18, 700, "title"),
        (obj["body"], BODY, 400, "body"),
        ("Authored anchors: " + " · ".join(obj["anchors"]), SECONDARY, 400, "anchors"),
        ("Ground: " + " · ".join(obj["ground"]), SECONDARY, 400, "ground"),
    ]
    return [(lines(cv, text, width - PAD * 2, size, weight), size, weight, role)
            for text, size, weight, role in fields]


def card_height(fields):
    return PAD * 2 + sum(len(text) * (26 if size > BODY else LINE) + 8
                         for text, size, _, _ in fields)


def draw_card(cv, board, object_id, occurrence, obj, x, y, width, height, fields):
    fill, stroke, accent = style(obj["basis"])
    start = len(cv.svg)
    cv.rect(x, y, width, height, fill, stroke, 8)
    cursor = y + PAD + SECONDARY
    for text, size, weight, role in fields:
        color = accent if role == "basis" else K.FG if role == "title" else K.MUT
        for line in text:
            cv.txt(x + PAD, cursor, line, size, color, weight)
            cursor += 26 if size > BODY else LINE
        cursor += 8
    board.nodes[occurrence] = (x, y, width, height)
    group = cv.el("g", id=occurrence, data_object=object_id,
                  data_scene_anchors=" ".join(obj["anchors"]))
    for element in list(cv.svg)[start:-1]:
        cv.svg.remove(element)
        group.append(element)


def relation_text(relation):
    return (f"{relation['id']} · {relation['from']} → {relation['to']} · "
            f"{relation['label']}\n"
            f"{relation['qualification']}\n"
            f"Cardinality: {relation['cardinality']} · Basis: {relation['basisLabel']} · "
            f"Ground: {' · '.join(relation['ground'])}")


def draw_section(cv, board, diagram, section, objects, y):
    inner = WIDTH - MARGIN * 2
    title = f"{section['id']} · {section['title']}"
    y = paragraph(cv, MARGIN, y + 22, title, inner, 20, K.FG, 700) + 6
    y = paragraph(cv, MARGIN, y, section["note"], inner) + 18
    node_ids = section["objects"]
    if not 2 <= len(node_ids) <= 4 or len(set(node_ids)) != len(node_ids):
        raise ValueError(f"Invalid section objects: {section['id']}")
    width = (inner - GAP * (len(node_ids) - 1)) / len(node_ids)
    shown_objects = {key: dict(objects[key]) for key in node_ids}
    if diagram == "F5-FLOW" and section["id"] == "F-FUTURE":
        for number, key in enumerate(node_ids, 1):
            shown_objects[key]["title"] = f"{number}. {objects[key]['title']}"
    measured = {key: card_lines(cv, shown_objects[key], width) for key in node_ids}
    height = max(card_height(value) for value in measured.values())
    occurrences = {}
    for index, key in enumerate(node_ids):
        occurrence = f"{diagram}--{section['id']}--{key}"
        occurrences[key] = occurrence
        draw_card(cv, board, key, occurrence, shown_objects[key],
                  MARGIN + index * (width + GAP), y, width, height, measured[key])
    for relation in section["relations"]:
        a, z = relation["from"], relation["to"]
        ai, zi = node_ids.index(a), node_ids.index(z)
        if abs(ai - zi) != 1:
            raise ValueError(f"Only adjacent dedicated connector lanes: {relation['id']}")
        source, target = occurrences[a], occurrences[z]
        if relation["basis"] == "unresolved":
            cx = MARGIN + (min(ai, zi) + 1) * width + min(ai, zi) * GAP
            cy = y + height / 2
            cv.rect(cx + 10, cy - 30, GAP - 20, 60, "#231414", "#784343", 6)
            cv.txt(cx + GAP / 2, cy - 7, "UNRESOLVED", SECONDARY, K.RED, 700, anchor="middle")
            cv.txt(cx + GAP / 2, cy + 14, relation["id"] + " · HELD", SECONDARY, K.RED, 600, anchor="middle")
            board.obstacles.append((cx + 10, cy - 30, GAP - 20, 60))
            continue
        points = ([board.R(source), board.L(target)] if ai < zi
                  else [board.L(source), board.R(target)])
        dashed = relation["basis"] not in ("native", "candidate")
        label = ("Ref " if diagram == "F5-DATA" else "Step ") + relation["id"]
        board.edge(relation["id"], points, label, dashed=dashed,
                   color=K.WARN if dashed else K.BLUE, size=SECONDARY, weight=600,
                   lcolor=K.WARN if dashed else K.MUT)
    y += height + 28
    for relation in section["relations"]:
        y = paragraph(cv, MARGIN + 16, y, relation_text(relation), inner - 32) + 12
    y = paragraph(cv, MARGIN + 16, y, section["boundary"], inner - 32,
                  BODY, K.WARN) + 24
    cv.rule(MARGIN, y, inner)
    return y + 28


def compose(diagram, contract, objects):
    cv = K.Canvas(WIDTH, 1)
    cv.svg.set("id", diagram["id"])
    board = Board(cv, diagram["id"])
    background = cv.rect(0, 0, WIDTH, 1, K.BG, K.BORDER, 0)
    y = paragraph(cv, MARGIN, 52, diagram["title"], WIDTH - MARGIN * 2, 24, K.FG, 700) + 12
    y = paragraph(cv, MARGIN, y, diagram["intro"], WIDTH - MARGIN * 2) + 16
    semantics = (
        "REFERENCE ARROWS point from a record to the record it refers to. They do not describe execution order. "
        "For example, a receipt references its grant, and that grant references its prepared payload (DR23 / DR22)."
        if diagram["id"] == "F5-DATA" else
        "PROCESS ARROWS follow the named step or observation. Read each lane separately; there is no automatic end-to-end pipeline. "
        "The conditional future lane reads left to right: 1 Prepare, 2 Grant, 3 Receipt."
    )
    y = paragraph(cv, MARGIN, y, semantics, WIDTH - MARGIN * 2, BODY, K.FG, 600) + 16
    for item in contract["legend"]:
        fill, stroke, accent = style(item["basis"])
        cv.rect(MARGIN, y - 12, 16, 16, fill, stroke, 3)
        y = paragraph(cv, MARGIN + 28, y, item["text"], WIDTH - MARGIN * 2 - 28,
                      SECONDARY, accent) + 3
    y += 20
    for section in diagram["sections"]:
        y = draw_section(cv, board, diagram["id"], section, objects, y)
    caption_y = y + 8
    y = paragraph(cv, MARGIN, y + 32, "Fixture pins · illustrative; never resolved by this generator",
                  WIDTH - MARGIN * 2, 18, K.FG, 700) + 6
    for pin in contract["fixturePins"]:
        y = paragraph(cv, MARGIN, y, pin, WIDTH - MARGIN * 2, BODY, K.CAPTION_FG)
    y += 12
    for note in contract["qualifications"]:
        y = paragraph(cv, MARGIN, y, note, WIDTH - MARGIN * 2, BODY, K.CAPTION_FG) + 8
    height = int(y + 32)
    cv.height = height
    cv.svg.set("height", str(height))
    cv.svg.set("viewBox", f"0 0 {WIDTH} {height}")
    background.set("height", str(height))
    # Keep the established bottom caption band, sized by measured content rather than clipping it.
    band = cv.rect(0, caption_y, WIDTH, height - caption_y, K.CAPTION_BG, K.CAPTION_BORDER, 0)
    cv.svg.remove(band)
    cv.svg.insert(1, band)
    board.obstacles.append((0, caption_y, WIDTH, height - caption_y))
    errors = board.finish()
    positions = list(board.nodes.items())
    for index, (key, box) in enumerate(positions):
        for other, other_box in positions[index + 1:]:
            if rects_hit(box, other_box):
                errors.append(f"Overlapping cards: {key} / {other}")
    if errors:
        raise ValueError(diagram["id"] + ":\n" + "\n".join(errors))
    return cv


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--svg-only", action="store_true", help="Leave PNG rendering to the parent")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    for filename in K.WEIGHT_FILES.values():
        if not (K.FONT_DIR / filename).is_file():
            raise FileNotFoundError(f"Measured Inter is required; restore existing font: {K.FONT_DIR / filename}")
    contract_path = ROUND / "spec" / "diagram-contract.json"
    base_path = ROUND / "spec" / "base.json"
    contract = interpolate(json.loads(contract_path.read_text(encoding="utf-8-sig")),
                           json.loads(base_path.read_text(encoding="utf-8-sig")))
    if contract["schema"] != "t3factory-diagram-contract/1":
        raise ValueError("Unsupported diagram contract")
    objects = contract["objects"]
    seen = set()
    for diagram in contract["diagrams"]:
        for section in diagram["sections"]:
            for relation in section["relations"]:
                if relation["id"] in seen:
                    raise ValueError(f"Duplicate authored relation: {relation['id']}")
                seen.add(relation["id"])
    canvases = [(diagram, compose(diagram, contract, objects)) for diagram in contract["diagrams"]]
    frames = {}
    for diagram, cv in canvases:
        record = cv.save(OUT / f"{diagram['id']}.svg")
        record["png"] = None
        if not args.svg_only:
            png = render(Path(record["path"]), OUT / "png" / f"{diagram['id']}.png")
            record["png"] = {"path": str(png), "sha256": hashlib.sha256(png.read_bytes()).hexdigest()}
        frames[diagram["id"]] = record
        print(record["path"], f"{record['width']}x{record['height']}")
    K.write_manifest({
        "slice": "Round05 source diagrams; not a prototype wiring inventory",
        "sourceHashes": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in (contract_path, base_path, Path(__file__).resolve())},
        "helpers": "round-04/build/{svgkit.py,build_diagrams.py,render.py}",
        "frames": frames,
        "authoredSceneAnchors": sorted({anchor for obj in objects.values() for anchor in obj["anchors"]}),
        "relationIds": sorted(seen),
        "nativeNodeLinks": "Parent supplies after import; no native ids or final aliases authored",
        "verification": "Local measured geometry only; parent must inspect PNGs, native import and integrated anchors",
    }, OUT / "f5-diagrams-manifest.json")


if __name__ == "__main__":
    main()
