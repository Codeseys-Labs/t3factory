"""Generate the Round-09 wayfinder SVG and Mermaid exports from maps.json."""

import html
import json
from pathlib import Path
import textwrap
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent


def escape(value):
    return html.escape(str(value), quote=True)


def render(data, view):
    width, height = view["width"], view["height"]
    title_id, desc_id = view["id"] + "-title", view["id"] + "-desc"
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="{title_id} {desc_id}">',
        f'<title id="{title_id}">{escape(view["title"])}</title>',
        f'<desc id="{desc_id}">{escape(view["description"] + " " + data["status"])}</desc>',
        '<style>text{font-family:Arial;fill:#f1f3f7}.muted{fill:#bac4d2}</style>',
        f'<rect width="{width}" height="{height}" fill="#101216"/>',
        f'<text x="50" y="44" font-size="26" font-weight="600">{escape(view["title"])}</text>',
        '<text x="50" y="72" font-size="14" class="muted">T3 Factory · November 4 proposed priorities P1–P4 · complements tracker #2 / #66</text>',
        '<defs>',
    ]
    for kind in view["legend"]:
        color = data["edgeKinds"][kind]["color"]
        svg.append(f'<marker id="{view["id"]}-{kind}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="{color}"/></marker>')
    svg.append('</defs>')
    legend_x = 50
    for kind in view["legend"]:
        style = data["edgeKinds"][kind]
        dash = f' stroke-dasharray="{style["dash"]}"' if style["dash"] else ""
        svg.append(f'<path d="M{legend_x} 100h32" stroke="{style["color"]}" stroke-width="2"{dash}/>')
        svg.append(f'<text x="{legend_x + 41}" y="105" font-size="13" class="muted">{escape(style["label"])}</text>')
        legend_x += 110 + len(style["label"]) * 6
    for section in view.get("sections", []):
        svg.append(f'<text x="{section["x"]}" y="{section["y"]}" font-size="15" font-weight="600" class="muted">{escape(section["text"])}</text>')

    mermaid = [
        "flowchart TD",
        "  accTitle: " + view["title"],
        "  accDescr: " + view["description"] + " " + data["status"],
        "",
        "  %% Generated from maps.json; SVG uses the stored geometry, Mermaid lays itself out.",
    ]
    for node in view["nodes"]:
        text = " | ".join([node["badge"], node["title"]] + node["lines"])
        mermaid.append(f'  {node["id"]}["{text.replace(chr(34), "#quot;")}"]')
    for edge in view["edges"]:
        style = data["edgeKinds"][edge["kind"]]
        path = "M" + " L".join(f"{x:g} {y:g}" for x, y in edge["points"])
        dash = f' stroke-dasharray="{style["dash"]}"' if style["dash"] else ""
        svg.append(f'<path id="{edge["id"]}" d="{path}" fill="none" stroke="{style["color"]}" stroke-width="2" marker-end="url(#{view["id"]}-{edge["kind"]})"{dash}><title>{escape(edge["source"] + " to " + edge["target"] + ": " + (edge["label"] or style["label"]))}</title></path>')
        if edge["label"]:
            x, y = edge["labelAt"]
            label_width = len(edge["label"]) * 6.2 + 10
            svg.append(f'<rect x="{x - label_width / 2:g}" y="{y - 12}" width="{label_width:g}" height="16" fill="#101216"/>')
            svg.append(f'<text x="{x}" y="{y}" font-size="12" text-anchor="middle" class="muted">{escape(edge["label"])}</text>')
        connector = "-.->" if style["dash"] else "-->"
        label = f'|"{edge["label"]}"|' if edge["label"] else ""
        mermaid.append(f'  {edge["source"]} {connector}{label} {edge["target"]}')

    for node in view["nodes"]:
        x, y, w, h = (node[key] for key in ("x", "y", "w", "h"))
        svg.append(f'<g id="{node["id"]}"><title>{escape(node["title"])}</title><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="#191d24" stroke="#66778e"/>')
        svg.append(f'<text x="{x + 16}" y="{y + 21}" font-size="11" font-weight="600" class="muted">{escape(node["badge"])}</text>')
        svg.append(f'<text x="{x + 16}" y="{y + 44}" font-size="18" font-weight="600">{escape(node["title"])}</text>')
        for index, line in enumerate(node["lines"]):
            svg.append(f'<text x="{x + 16}" y="{y + 66 + index * 19}" font-size="14" class="muted">{escape(line)}</text>')
        svg.append('</g>')
    for index, note in enumerate(view["notes"]):
        for offset, line in enumerate(textwrap.wrap(note, width=118)):
            svg.append(f'<text x="50" y="{height - 69 + index * 34 + offset * 17}" font-size="13" class="muted">{escape(line)}</text>')
    svg.append('</svg>')
    output = "\n".join(svg) + "\n"
    ET.fromstring(output)
    (ROOT / (view["file"] + ".svg")).write_text(output, encoding="utf-8")
    (ROOT / (view["file"] + ".mmd")).write_text("\n".join(mermaid) + "\n", encoding="utf-8")


def verify(data):
    assert data["schemaVersion"] == 1
    assert len({view["id"] for view in data["views"]}) == len(data["views"])
    node_count, edge_count = 0, 0
    for view in data["views"]:
        nodes = {node["id"]: node for node in view["nodes"]}
        assert len(nodes) == len(view["nodes"]), view["id"] + ": duplicate node"
        assert len({edge["id"] for edge in view["edges"]}) == len(view["edges"])
        for node in view["nodes"]:
            x, y, w, h = (node[key] for key in ("x", "y", "w", "h"))
            assert 0 <= x < x + w <= view["width"] and 0 <= y < y + h <= view["height"]
            assert y + 66 + 19 * (len(node["lines"]) - 1) < y + h - 5, node["id"] + ": text height"
            for other in view["nodes"]:
                if node["id"] >= other["id"]:
                    continue
                assert not (x < other["x"] + other["w"] and x + w > other["x"] and y < other["y"] + other["h"] and y + h > other["y"]), node["id"] + ": node overlap"
        for edge in view["edges"]:
            assert edge["source"] in nodes and edge["target"] in nodes
            assert edge["kind"] in data["edgeKinds"]
            for x, y in edge["points"]:
                assert 0 <= x <= view["width"] and 0 <= y <= view["height"]
            for a, b in zip(edge["points"], edge["points"][1:]):
                assert a[0] == b[0] or a[1] == b[1], edge["id"] + ": non-orthogonal segment"
                for node in view["nodes"]:
                    if node["id"] in (edge["source"], edge["target"]):
                        continue
                    nx, ny, nw, nh = (node[key] for key in ("x", "y", "w", "h"))
                    horizontal_hit = a[1] == b[1] and ny < a[1] < ny + nh and max(a[0], b[0]) > nx and min(a[0], b[0]) < nx + nw
                    vertical_hit = a[0] == b[0] and nx < a[0] < nx + nw and max(a[1], b[1]) > ny and min(a[1], b[1]) < ny + nh
                    assert not (horizontal_hit or vertical_hit), edge["id"] + ": edge crosses " + node["id"]
        node_count += len(nodes)
        edge_count += len(view["edges"])
    return node_count, edge_count


def main():
    data = json.loads((ROOT / "maps.json").read_text(encoding="utf-8"))
    nodes, edges = verify(data)
    for view in data["views"]:
        render(data, view)
    print(f"Verified and generated {len(data['views'])} maps: {nodes} nodes, {edges} edges; XML, references, bounds, node overlaps and edge/node intersections passed.")


if __name__ == "__main__":
    main()
