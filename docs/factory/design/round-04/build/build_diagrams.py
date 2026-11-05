"""Round-03 diagram frames from spec/figjam.md: C3-FLOW (navigation flow) and C3-DATA (data relationships).

Both frames are 1920 wide, drawn in the same dark style as the screens with the caption band at the
bottom, so they can be pasted into the Figma design file next to the C3 frames and into FigJam as
images. Node/edge data is transcribed from spec/figjam.md sections A and B; grid positions are a
re-layout of the spec's suggested coordinates.

Every edge is routed by hand on orthogonal lanes. `Board.finish()` places each on-line label where it
touches no node, label, other edge or arrowhead, and fails the build when an edge passes through a
node, two edges run on top of each other, or any label or node text does not fit.
"""
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import svgkit as K  # noqa: E402
from render import render  # noqa: E402

OUT = HERE.parent / 'screens'
W = 1920
TAG_STYLE = {'Existing': ('#1c1c1c', '#2b2b2b', K.MUT), 'Refinement': ('#1a2030', '#33405a', K.BLUE), 'Gated': ('#1c1a14', K.WARN, K.WARN)}
SOLID, DASHED = '#6f7a93', '#8a93a6'
PILL_BG = '#090909'


def tag_kind(tag):
    return 'Gated' if tag.startswith('Gated') else 'Refinement' if tag.startswith('Refinement') else 'Existing'


def legend(cv, x, y, w=340, data=False):
    cv.txt(x, y, 'Legend', 13, K.FG, 700)
    names = {'Existing': 'Existing (basis Observed)' if data else 'Existing',
             'Refinement': 'Refinement (basis Proposed)' if data else 'Refinement',
             'Gated': 'Gated proposal (gate on node)'}
    for i, (k, (f, s, c)) in enumerate(TAG_STYLE.items()):
        cv.rect(x, y + 12 + i * 22, 14, 14, f, s, 3); cv.txt(x + 22, y + 23 + i * 22, names[k], 12, K.MUT)
    lines = cv.wrap('solid = observed / wired · dashed = proposed / study · double = reverse state ·', w, 11)
    for i, l in enumerate(lines):
        cv.txt(x, y + 88 + 14 * i, l, 11, K.DIM)
    lx, ly = x + K.text_width(lines[-1], 11) + 4, y + 88 + 14 * (len(lines) - 1)
    if lx + K.text_width('✕ = not a relation', 11) > x + w:
        lx, ly = x, ly + 14
    cv.txt(lx, ly, '✕', 11, K.RED, 700)
    cv.txt(lx + K.text_width('✕', 11, 700) + 4, ly, '= not a relation', 11, K.DIM)


def crossed(cv, errors, who, x, y, s, size, fill, maxw):
    """One line whose ' ✕ ' separators are drawn as red crosses."""
    cx = x
    parts = s.split(' ✕ ')
    for i, part in enumerate(parts):
        cv.txt(cx, y, part, size, fill); cx += K.text_width(part, size)
        if i < len(parts) - 1:
            cx += 4; cv.txt(cx, y, '✕', size, K.RED, 700); cx += K.text_width('✕', size, 700) + 4
    if cx - x > maxw + .5:
        errors.append(f'{who}: line too wide: {s}')


def rects_hit(a, b, pad=0):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    return ax < bx + bw + pad and bx < ax + aw + pad and ay < by + bh + pad and by < ay + ah + pad


class Board:
    """Nodes, orthogonal edges and on-line labels, with a geometric self-check."""

    def __init__(self, cv, name):
        self.cv, self.name = cv, name
        self.nodes, self.edges, self.obstacles, self.errors = {}, [], [], []

    # ports --------------------------------------------------------------------------------------
    def R(self, n, d=0): x, y, w, h = self.nodes[n]; return (x + w, y + h / 2 + d)
    def L(self, n, d=0): x, y, w, h = self.nodes[n]; return (x, y + h / 2 + d)
    def T(self, n, d=0): x, y, w, h = self.nodes[n]; return (x + w / 2 + d, y)
    def B(self, n, d=0): x, y, w, h = self.nodes[n]; return (x + w / 2 + d, y + h)

    def edge(self, key, pts, label, dashed=False, color=None, lcolor=K.MUT, size=10, weight=600, double=False, at=None):
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            if abs(x1 - x2) > .01 and abs(y1 - y2) > .01:
                self.errors.append(f'{key}: diagonal segment {(x1, y1)}→{(x2, y2)}')
        self.edges.append(dict(key=key, pts=pts, label=label, dashed=dashed, color=color or (DASHED if dashed else SOLID),
                               lcolor=lcolor, size=size, weight=weight, double=double, at=at))

    # geometry helpers ---------------------------------------------------------------------------
    @staticmethod
    def segs(pts):
        return list(zip(pts, pts[1:]))

    @staticmethod
    def seg_rect(s, pad=0):
        (x1, y1), (x2, y2) = s
        return (min(x1, x2) - pad, min(y1, y2) - pad, abs(x2 - x1) + 2 * pad, abs(y2 - y1) + 2 * pad)

    def check_geometry(self):
        for e in self.edges:
            for s in self.segs(e['pts']):
                for n, (x, y, w, h) in self.nodes.items():
                    if rects_hit(self.seg_rect(s), (x + 1.5, y + 1.5, w - 3, h - 3)):
                        self.errors.append(f"{e['key']}: passes through node {n}")
        for i, a in enumerate(self.edges):
            for b in self.edges[i + 1:]:
                for sa in self.segs(a['pts']):
                    for sb in self.segs(b['pts']):
                        (ax1, ay1), (ax2, ay2) = sa; (bx1, by1), (bx2, by2) = sb
                        if ay1 == ay2 and by1 == by2 and abs(ay1 - by1) < 6:
                            lo, hi = max(min(ax1, ax2), min(bx1, bx2)), min(max(ax1, ax2), max(bx1, bx2))
                            if hi - lo > 1:
                                self.errors.append(f"{a['key']} and {b['key']}: run together at y≈{ay1}")
                        if ax1 == ax2 and bx1 == bx2 and abs(ax1 - bx1) < 6:
                            lo, hi = max(min(ay1, ay2), min(by1, by2)), min(max(ay1, ay2), max(by1, by2))
                            if hi - lo > 1:
                                self.errors.append(f"{a['key']} and {b['key']}: run together at x≈{ax1}")
                for pa in (a['pts'][0], a['pts'][-1]):
                    for pb in (b['pts'][0], b['pts'][-1]):
                        if math.dist(pa, pb) < 10:
                            self.errors.append(f"{a['key']} and {b['key']}: ports too close at {pa}")

    def place_labels(self):
        heads = [(e['pts'][-1][0] - 7, e['pts'][-1][1] - 7, 14, 14) for e in self.edges]
        placed = []
        for e in self.edges:
            pw = K.text_width(e['label'], e['size'], e['weight']) + 10
            ph = e['size'] + 4
            e['pw'], e['ph'] = pw, ph
        def free(e, r, own_seg):
            if r[0] < 4 or r[1] < 4 or r[0] + r[2] > self.cv.width - 4:
                return False
            if any(rects_hit(r, n, 3) for n in self.nodes.values()):
                return False
            if any(rects_hit(r, o, 2) for o in self.obstacles):
                return False
            if any(rects_hit(r, p, 3) for p in placed):
                return False
            if any(rects_hit(r, h, 2) for h in heads):
                return False
            for f in self.edges:
                for s in self.segs(f['pts']):
                    if f is e and s == own_seg:
                        continue
                    if rects_hit(r, self.seg_rect(s), 3):
                        return False
            return True
        def candidates(e):
            out = []
            for s in sorted(self.segs(e['pts']), key=lambda s: -math.dist(*s)):
                (x1, y1), (x2, y2) = s
                horiz = y1 == y2
                length = abs(x2 - x1) if horiz else abs(y2 - y1)
                if length < (e['pw'] if horiz else e['ph']) + 14:
                    continue
                for t in (.5, .4, .6, .3, .7, .22, .78, .15, .85):
                    cx, cy = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
                    out.append(((cx - e['pw'] / 2, cy - e['ph'] / 2, e['pw'], e['ph']), s))
            return out
        # most constrained first
        for e in self.edges:
            if e['at']:  # fixed label position (centre), still checked
                cx, cy = e['at']; r = (cx - e['pw'] / 2, cy - e['ph'] / 2, e['pw'], e['ph'])
                if not free(e, r, None):
                    self.errors.append(f"{e['key']}: fixed label overlaps something")
                e['pill'] = r; placed.append(r)
        order = sorted((e for e in self.edges if not e['at']), key=lambda e: sum(1 for r, s in candidates(e) if free(e, r, s)))
        for e in order:
            for r, s in candidates(e):
                if free(e, r, s):
                    e['pill'] = r; placed.append(r); break
            else:
                self.errors.append(f"{e['key']}: no free spot for label '{e['label']}'")
                c = candidates(e)
                e['pill'] = c[0][0] if c else None

    # drawing ------------------------------------------------------------------------------------
    def draw_edges(self):
        cv = self.cv
        for e in self.edges:
            pts = e['pts']
            d = 'M ' + ' L '.join(f'{x:g},{y:g}' for x, y in pts)
            if e['double']:
                cv.el('path', d=d, fill='none', stroke=e['color'], stroke_width=4.5)
                cv.el('path', d=d, fill='none', stroke=K.BG, stroke_width=1.5)
            else:
                a = dict(d=d, fill='none', stroke=e['color'], stroke_width=1.5)
                if e['dashed']:
                    a['stroke_dasharray'] = '6 5'
                cv.el('path', **a)
            (x1, y1), (x2, y2) = pts[-2], pts[-1]
            ang = math.atan2(y2 - y1, x2 - x1)
            hx = [x2 - 9 * math.cos(ang - s * .42) for s in (1, -1)]; hy = [y2 - 9 * math.sin(ang - s * .42) for s in (1, -1)]
            cv.el('path', d=f'M {hx[0]:.1f},{hy[0]:.1f} L {x2:g},{y2:g} L {hx[1]:.1f},{hy[1]:.1f}', stroke=e['color'], stroke_width=1.5, fill='none')
        for e in self.edges:
            if e.get('pill'):
                x, y, w, h = e['pill']
                cv.rect(x, y, w, h, PILL_BG, K.BORDER, 4)
                cv.txt(x + w / 2, y + h / 2 + e['size'] * .36, e['label'], e['size'], e['lcolor'], e['weight'], anchor='middle')

    def finish(self):
        self.check_geometry(); self.place_labels(); self.draw_edges()
        return self.errors


def fit_para(cv, errors, who, x, y, s, w, size, fill, lh, max_lines, weight=400):
    lines = cv.wrap(s, w, size, weight)
    if len(lines) > max_lines:
        errors.append(f'{who}: "{s[:40]}…" needs {len(lines)} lines, room for {max_lines}')
    for i, l in enumerate(lines):
        if K.text_width(l, size, weight) > w + .5:
            errors.append(f'{who}: line too wide: {l}')
        cv.txt(x, y + lh * i, l, size, fill, weight)
    return y + lh * len(lines)


# ----------------------------------------------------------------------------------------------
# Section A · Flow
# ----------------------------------------------------------------------------------------------
FLOW_NODES = [  # id, (col, row), title, tag, gate note
    ('C3-01', (1, 1), 'Needs you (10:42)', 'Gated · attention summary', ''),
    ('C3-02', (1, 2), 'Why #214 needs you', 'Gated · attention summary', ''),
    ('C3-13', (1, 3), 'Same detail, 960px, large text', 'Refinement', ''),
    ('C3-01b', (1, 4), 'List after approving (10:45)', 'Gated · attention summary', ''),
    ('C3-01c', (1, 5), 'List after answering (10:46)', 'Gated · attention summary', ''),
    ('C3-01d', (1, 6), 'List after re-accepting (10:48)', 'Gated · attention summary', ''),
    ('C3-03', (2, 1), 'Approve in the delegated task', 'Existing', ''),
    ('C3-04', (2, 2), 'Approved: steer or stop', 'Existing', ''),
    ('C3-05', (2, 3), 'Answer Index rollout review', 'Existing', 'result cards · Gated #63'),
    ('C3-05b', (2, 4), 'Answer sent', 'Existing', ''),
    ('C3-06', (3, 1), 'Re-accept #214 at current head', 'Existing', ''),
    ('C3-07', (3, 2), 'Grant the pull request', 'Existing', ''),
    ('C3-08', (3, 3), 'Comment delivery unknown', 'Existing', ''),
    ('C3-09', (3, 4), 'What Reconcile found (A; B study)', 'Existing', 'study card B · Gated #58'),
    ('C3-10', (3, 5), 'Inspect the failed explore run', 'Existing', ''),
    ('C3-11', (4, 4), 'Settled, and the way back', 'Existing', 'remote child card · Gated #65'),
    ('C3-12', (4, 5), 'Caught up on Workstation (not everything)', 'Gated · attention summary', ''),
    ('C3-M1', (5, 1), 'Needs you at the top of Home', 'Gated · attention summary', ''),
    ('C3-M2', (5, 2), '#214: evidence, review, re-accept', 'Gated · attention summary', ''),
    ('C3-M3', (5, 3), 'Approve on a phone', 'Existing', ''),
    ('C1r2-00', (5, 6), 'Work (node 29:753)', 'Refinement (round 02)', ''),
]
STAGES = {1: '1 · Notice', 2: '2 · Decide in the thread', 3: '3 · Decide in Factory review', 4: '4 · File and return', 5: '5 · Phone'}
NW, NH = 220, 96
FLOW_EDGES = [  # from, to, label, dashed
    ('C3-01', 'C3-03', 'Open approval (row a) · E01', False),
    ('C3-01', 'C3-05', 'Open question (row b) · E02', False),
    ('C3-01', 'C3-02', 'Select row c · E03', False),
    ('C3-01', 'C3-06', 'Open in Issues (row c) · E04', False),
    ('C3-01', 'C3-08', 'Open in Briefs (row d) · E05', False),
    ('C3-01', 'C3-10', 'Open in Research (row e) · E06', False),
    ('C3-01', 'C1r2-00', 'Sidebar Work · E07', False),
    ('C3-01', 'C3-M1', 'Same list on a phone (study chip) · E34', True),
    ('C3-02', 'C3-06', 'Open in Issues · E08', False),
    ('C3-02', 'C3-01', 'Close details · E09', False),
    ('C3-02', 'C3-03', 'Open approval (row a) · E10', False),
    ('C3-02', 'C3-13', 'Same detail at 960px (study chip) · E11', True),
    ('C3-03', 'C3-04', 'Approve · E12', False),
    ('C3-04', 'C3-01b', '← Needs you (row a left) · E15', False),
    ('C3-01b', 'C3-05', 'Open question (row b) · E39', False),
    ('C3-05', 'C3-05b', 'Pick "Hold the rollout" (sends it) · E40', False),
    ('C3-05b', 'C3-01c', '← Needs you (row b left) · E41', False),
    ('C3-01c', 'C3-06', 'Open in Issues (row c) · E42', False),
    ('C3-06', 'C3-07', 'Re-accept at current head · E20', False),
    ('C3-07', 'C3-01d', '← Needs you (row c left) · E22', False),
    ('C3-01d', 'C3-10', 'Open in Research (row e) · E43', False),
    ('C3-01d', 'C3-08', 'Open in Briefs (row d) · E44', False),
    ('C3-08', 'C3-09', 'Reconcile · E23', False),
    ('C3-09', 'C3-11', 'Settle thread · E25', False),
    ('C3-09', 'C3-12', '← Needs you (row d left) · E26', False),
    ('C3-11', 'C3-12', '← Needs you (story end, 10:58) · E30', False),
    ('C3-12', 'C1r2-00', 'Sidebar Work · E31', False),
    ('C3-13', 'C3-01', '← Needs you · E32', False),
    ('C3-13', 'C3-06', 'Open in Issues · E33', False),
    ('C3-M1', 'C3-M2', 'Row c · E35', False),
    ('C3-M1', 'C3-M3', 'Row a · E36', False),
]
COLX = {1: 80, 2: 460, 3: 840, 4: 1220, 5: 1600}      # column pitch 380, gutters 160
ROWY = {r: 290 + 132 * (r - 1) for r in range(1, 7)}   # row pitch 132
FLOW_H = 1390


def flow_routes(b):
    """Edge id -> polyline. Lanes: gutter 1|2 x 314-440, gutter 2|3 x 704-816, top channel y 172-268,
    left margin x 30/56, right margin x 1860, bottom channel y 1068."""
    R, L, T, B = b.R, b.L, b.T, b.B
    def vh(p, x, q):  # leave p horizontally to lane x, run vertically, enter q horizontally
        return [p, (x, p[1]), (x, q[1]), q]
    def up_over(p, y, q):  # leave p vertically to lane y, run horizontally, enter q vertically
        return [p, (p[0], y), (q[0], y), q]
    top = {'E34': 172, 'E04': 188, 'E05': 204, 'E06': 220, 'E08': 236, 'E33': 252, 'E42': 268}
    return {
        'E01': [R('C3-01', -20), L('C3-03', -20)],
        'E02': vh(R('C3-01', 20), 386, L('C3-05', -16)),
        'E03': [B('C3-01', -30), T('C3-02', -30)],
        'E04': up_over(T('C3-01', -45), top['E04'], T('C3-06', 50)),
        'E05': [T('C3-01', -15), (175, top['E05']), (724, top['E05']), (724, L('C3-08', -16)[1]), L('C3-08', -16)],
        'E06': [T('C3-01', 15), (205, top['E06']), (704, top['E06']), (704, L('C3-10')[1]), L('C3-10')],
        'E07': [L('C3-01', -20), (30, L('C3-01', -20)[1]), (30, 1068), (B('C1r2-00', 60)[0], 1068), B('C1r2-00', 60)],
        'E08': [R('C3-02', -24), (314, R('C3-02', -24)[1]), (314, top['E08']), (T('C3-06', -15)[0], top['E08']), T('C3-06', -15)],
        'E09': [T('C3-02', 30), B('C3-01', 30)],
        'E10': vh(R('C3-02', 8), 368, L('C3-03', 4)),
        'E11': [B('C3-02', -30), T('C3-13', -30)],
        'E12': [B('C3-03'), T('C3-04')],
        'E15': vh(L('C3-04'), 404, R('C3-01b', -16)),
        'E20': [B('C3-06'), T('C3-07')],
        'E22': vh(L('C3-07'), 796, R('C3-01d', -24)),
        'E23': [B('C3-08'), T('C3-09')],
        'E25': [R('C3-09', -16), L('C3-11', -16)],
        'E26': vh(R('C3-09', 16), 1140, L('C3-12')),
        'E30': [B('C3-11'), T('C3-12')],
        'E31': vh(R('C3-12'), 1520, L('C1r2-00')),
        'E32': vh(L('C3-13'), 56, L('C3-01', 20)),
        'E33': [R('C3-13'), (332, R('C3-13')[1]), (332, top['E33']), (T('C3-06', -45)[0], top['E33']), T('C3-06', -45)],
        'E34': up_over(T('C3-01', -75), top['E34'], T('C3-M1')),
        'E35': [B('C3-M1'), T('C3-M2')],
        'E36': vh(R('C3-M1'), 1860, R('C3-M3')),
        'E39': vh(R('C3-01b', 16), 422, L('C3-05', 16)),
        'E40': [B('C3-05'), T('C3-05b')],
        'E41': vh(L('C3-05b'), 440, R('C3-01c', 16)),
        'E42': [R('C3-01c', -16), (350, R('C3-01c', -16)[1]), (350, top['E42']), (T('C3-06', -75)[0], top['E42']), T('C3-06', -75)],
        'E43': [R('C3-01d', 24), (B('C3-10')[0], R('C3-01d', 24)[1]), B('C3-10')],
        'E44': vh(R('C3-01d'), 816, L('C3-08', 16)),
    }


def flow_frame():
    H = FLOW_H
    cv = K.Canvas(W, H)
    b = Board(cv, 'C3-FLOW')
    cv.rect(0, 0, W, H - 140, K.BG, K.BORDER, 0)
    cv.txt(60, 44, 'C3 · Needs you · 20 frames · 38 prototype links · start C3-01', 22, K.FG, 700)
    cv.para(60, 72, 'Arrows are navigation, not dispatch. Opening any screen sends nothing. Each return after a decision lands on the list re-read without the decided row. The 7 Figma Back links are not drawn; the Way back note lists them.', 1400, 13, K.MUT, 18)
    legend(cv, W - 360, 26)
    b.obstacles.append((W - 360, 12, 340, 120))
    for col, name in STAGES.items():
        cv.txt(COLX[col], 150, name, 13, K.DIM, 700)
        b.obstacles.append((COLX[col], 136, K.text_width(name, 13, 700), 18))
    for id, (col, row), title, tag, gate in FLOW_NODES:
        X, Y = COLX[col], ROWY[row]
        b.nodes[id] = (X, Y, NW, NH)
        f, s, c = TAG_STYLE[tag_kind(tag)]
        cv.rect(X, Y, NW, NH, f, s, 8)
        cv.txt(X + 12, Y + 22, id, 14, K.FG, 700)
        fit_para(cv, b.errors, id, X + 12, Y + 42, title, NW - 24, 12, K.FG, 15, 2)
        cv.txt(X + 12, Y + NH - 10, tag, 11, c)
        if gate:
            cv.txt(X + NW - 12, Y + 22, gate, 10, K.WARN, anchor='end')
            if K.text_width(id, 14, 700) + K.text_width(gate, 10) + 32 > NW:
                b.errors.append(f'{id}: gate line collides with id')
    routes = flow_routes(b)
    key = []
    for a, z, lab, dashed in FLOW_EDGES:
        trigger, eid = lab.rsplit(' · ', 1)
        b.edge(eid, routes[eid], eid, dashed, lcolor=K.BLUE if dashed else K.MUT)
        key.append((eid, a, z, trigger, dashed))
    # reverse-state loop on C3-11 (double line, no navigation)
    x, y, w, h = b.nodes['C3-11']
    b.edge('C3-11 loop', [(x + 40, y), (x + 40, y - 22), (x + 180, y - 22), (x + 180, y)], 'Un-settle stays in this thread (study card; not wired)',
           color=K.GREEN, lcolor=K.GREEN, size=10, weight=400, double=True, at=(x + 110, y - 44))
    # notes in the empty block above stage 4
    nx, nw = 1080, 500
    ny = 196  # below the top channel (E34 at y 172), above stage 4
    for head, body in (('What never enters Needs you', 'Child questions (the parent thread asks them). Routine child results (they go to the thread that asked). Running, idle or snoozed threads. Failed child tasks (they show in their parent, not here yet).'),
                       ('Static controls', 'Decision buttons with no outcome frame are static: Grant publish, Launch explore, Open thread, the round send button, Refresh, Try again, Un-settle, Allow once, and every control in a study card (spec §6.2). Retired edges: E14 (C3-03 sidebar → C3-05), E16–E18 (result-card buttons, Gated #63), E28–E29 (Un-settle; it stays in the thread).'),
                       ('Way back', 'After a decision, ← Needs you lands on the list re-read at that moment, without the decided row: C3-04 → C3-01b, C3-05b → C3-01c, C3-07 → C3-01d, C3-09 and C3-11 → C3-12. Before a decision it is Figma Back (not drawn): E13 on C3-03, E19 on C3-05, E21 on C3-06, E24 on C3-08, E27 on C3-10; on the phone E37 on C3-M2 and E38 on C3-M3. Every way into those frames comes from a Needs you frame, so Back always returns to Needs you. In the app the back control is labelled by where the user came from and is absent on a cold load. Close details returns from C3-02 (E09).')):
        lines = cv.wrap(body, nw - 32, 11)
        bh = 40 + 15 * len(lines) + 4
        cv.rect(nx, ny, nw, bh, '#151923', '#33405a', 8)
        cv.txt(nx + 16, ny + 22, head, 12, K.BLUE, 700)
        fit_para(cv, b.errors, head, nx + 16, ny + 42, body, nw - 32, 11, K.CAPTION_FG, 15, 9)
        b.obstacles.append((nx, ny, nw, bh))
        ny += bh + 16
    if ny - 16 > ROWY[4] - 60:
        b.errors.append('notes run into the C3-11 loop')
    errors = b.finish()
    # edge key
    ky = 1100
    cv.txt(60, ky, 'Edge key', 13, K.FG, 700)
    cv.txt(60 + K.text_width('Edge key', 13, 700) + 12, ky, 'id · from → to · trigger (dashed = study chip)', 11, K.DIM)
    key.sort(key=lambda k: int(k[0][1:]))
    colw = (W - 120) / 4
    for i, (eid, a, z, trigger, dashed) in enumerate(key):
        cx, cy = 60 + (i // 8) * colw, ky + 22 + (i % 8) * 15
        cv.txt(cx, cy, eid, 11, K.BLUE if dashed else K.FG, 700)
        cv.txt(cx + 34, cy, f'{a} → {z}', 11, K.DIM)
        cv.txt(cx + 146, cy, trigger, 11, K.MUT)
        if K.text_width(f'{a} → {z}', 11) > 106 or 146 + K.text_width(trigger, 11) > colw - 8:
            errors.append(f'edge key {eid}: text too wide')
    if ky + 22 + 7 * 15 + 6 > H - 140:
        errors.append('edge key runs into the caption band')
    cv.caption('C3-FLOW', 'Needs you: decide where it belongs, see the way back', 'Flow of the 20 round-03 frames with the 31 drawn navigation edges (plus 7 Figma Back links). Node fill is the frame tag; gates inside a frame are the small amber line. Source: round-03/spec/figjam.md section A, drawn by the conductor from the patched spec.', y=H - 140)
    return cv.save(OUT / 'C3-FLOW.svg'), errors


# ----------------------------------------------------------------------------------------------
# Section B · Data relationships
# ----------------------------------------------------------------------------------------------
ENTS = [  # id, name, owner, basis, (lane column, row)
    ('T1', 'Environment (Workstation, Mac Studio)', 'Environment connection · capabilities environment.ts:72-90', 'Observed', ('B', 1)),
    ('T2', 'Thread', 'Orchestration V2', 'Observed', ('A', 2)),
    ('T3', 'Request: approval or user input · pending / resolved / expired / cancelled · responds live / message / not_resumable', 'Orchestration V2 provider runtime · orchestrationV2.ts:1180-1195', 'Observed', ('B', 2)),
    ('T4', 'Delegated child (subagent or app-owned delegated task)', 'Orchestration V2 · orchestrationV2.ts:856', 'Observed', ('B', 3)),
    ('T5', 'Run → Retry attempt (history)', 'Orchestration V2 · orchestrationV2.ts:690-730', 'Observed', ('A', 3)),
    ('T6', 'Thread filing: Active / Snoozed / Settled', 'Thread shell + Orchestrator thread.settle / thread.unsettle', 'Observed', ('A', 4)),
    ('T7', 'Project coordinator binding (revision); optional role, not used in this story', 'ProjectCoordinatorService', 'Observed @258972b7', ('A', 1)),
    ('W1', 'WorkRef (version + owning environment + kind + retained id; for issues the admission root thread, e.g. 7a31e0c2)', 'FactoryWorkService', 'Observed @3a4ef2e4', ('C', 1)),
    ('W8', 'Sub-issue (source parent/child order; evidence only)', 'Native issue source · FactoryIssueFrontier.tsx:32', 'Observed', ('D', 1)),
    ('W2', 'Origin record: issue admission / brief / protocol / feed item; sourceKey (e.g. github:acme/factory#214), never identity', 'Native Factory services (issues, knowledge, research, feeds)', 'Observed', ('C', 2)),
    ('W7', 'Source blocker edge (tracker-owned, advisory; e.g. "Blocked: 1 unresolved blocker")', 'Factory readiness · factoryReadiness.ts:41-100,190', 'Observed', ('D', 2)),
    ('W3', 'Commit acceptance (headSha; current derived on read)', 'Factory acceptance · factoryAcceptance.ts:19-30', 'Observed', ('C', 3)),
    ('W4', 'Artifact acceptance (sha256; current derived on read; brief-scoped)', 'Factory knowledge · factoryKnowledge.ts:124-175', 'Observed', ('D', 4)),
    ('W5', 'Delivery intent → receipt (pending / sending / confirmed / failed / unknown)', 'FactoryDeliveryService · factoryDelivery.ts:37', 'Observed', ('C', 4)),
    ('W6', 'Research run → finding (run keyed by thread + role; finding derived on read: supported / unsupported / unknown)', 'FactoryResearchService.ts:160-205 · factoryResearch.ts:131', 'Observed', ('D', 3)),
    ('A1', 'Attention item (reason + evidence + subject ref)', 'Attention summary (new; derived; never stored)', 'Proposed · gated, no issue yet (AB:65)', ('M', 2)),
    ('A2', 'Coverage line, one per environment (connected / offline / access changed / checking / read failed)', 'Attention summary (new) · shows requests live + Work checked time', 'Proposed', ('M', 1)),
    ('G1', 'Planned item / downstream dependents — Not modeled', 'none', 'Gated #63', ('C', 5)),
]
EW, EH = 220, 88
DCOLX = {'A': 100, 'B': 470, 'M': 860, 'C': 1250, 'D': 1660}
DROWY = {r: 232 + 160 * (r - 1) for r in range(1, 6)}
RELS = [  # from, to, label, card, style, on-line name
    ('T1', 'T2', 'owns', '1 — N', 'solid', 'owns'),
    ('T2', 'T3', 'has pending', '1 — 0..N', 'solid', 'has pending'),
    ('T2', 'T4', 'delegates (lineage)', '1 — 0..N', 'solid', 'delegates (lineage)'),
    ('T4', 'T2', 'child approval escalates to the parent (pill + banner); user input never escalates', 'N — 1', 'solid', 'child approval escalates'),
    ('T2', 'T5', 'runs (history)', '1 — 0..N — 1..N', 'solid', 'runs (history)'),
    ('T2', 'T6', 'filed as', '1 — 1', 'solid', 'filed as'),
    ('T7', 'T2', 'binds · 0..1 per project in one environment (checkout) — 1 · optional role, no authority, sends nothing', '0..1 per checkout — 1', 'solid', 'binds'),
    ('T1', 'W1', 'owns', '1 — 0..N', 'solid', 'owns'),
    ('W1', 'W2', 'projects · review stays native', '1 — 1', 'solid', 'projects'),
    ('W2', 'T2', 'executed in', '1 — 0..N', 'solid', 'executed in'),
    ('T2', 'W3', 'has current (issue task thread)', '1 — 0..1', 'solid', 'has current'),
    ('W2', 'W4', 'has current (brief)', '1 — 0..1', 'solid', 'has current'),
    ('W3', 'W5', 'authorizes prepare of · 1 — 0..N, at most 1 live per task + kind; intent 1 — 0..1 receipt · unknown → Reconcile only; confirmed is one-way', '1 — 0..N', 'solid', 'authorizes prepare of'),
    ('W4', 'W5', 'authorizes prepare of', '1 — 0..N', 'solid', 'authorizes prepare of'),
    ('W2', 'W6', 'has · failed run ≠ finding', '1 — 0..N', 'solid', 'has'),
    ('W2', 'W7', 'has observed · tracker-owned, advisory', '1 — 0..N', 'solid', 'has observed'),
    ('W2', 'W8', 'has (source order) · evidence only', '1 — 0..N', 'solid', 'has (source order)'),
    ('A1', 'T3', 'derives from', 'N — 1', 'dashed', 'derives from'),
    ('A1', 'W5', 'derives from · T3 request, or W3 / W5 / W6 state (W7 shown as evidence)', 'N — 1', 'dashed', 'derives from'),
    ('A2', 'T1', 'reports on', '1 — 1', 'dashed', 'reports on'),
    ('A1', 'W3', 'routes to · the decision runs as the native command: T3 respond, W3 re-accept, W5 grant or Reconcile, W6 launch. The view runs nothing; only A1 → W3 is drawn', '1 — 1', 'dashed', 'routes to'),
    ('W2', 'G1', 'would plan · #63', '', 'gated', 'would plan · #63'),
]
DATA_H = 1330


def data_routes(b):
    """(from, to) -> polyline. Lanes: gap R1/R2 y 336/352/368 (into T2 top), gap R2/R3 y 500/520
    (T2↔T4) and 516 (into W3 top), left margin x 50, middle gutter x 1110-1210, right gutter x 1484-1626,
    top channel y 206."""
    R, L, T, B = b.R, b.L, b.T, b.B
    def vh(p, x, q):
        return [p, (x, p[1]), (x, q[1]), q]
    def hv(p, y, q):
        return [p, (p[0], y), (q[0], y), q]
    t2top = lambda d: T('T2', d)
    return {
        ('T7', 'T2'): [B('T7', -70), t2top(-70)],
        ('T1', 'T2'): hv(B('T1', -60), 336, t2top(10)),
        ('W2', 'T2'): [L('W2', -20), (1210, L('W2', -20)[1]), (1210, 352), (t2top(50)[0], 352), t2top(50)],
        ('T2', 'W3'): [t2top(90), (t2top(90)[0], 368), (1170, 368), (1170, 516), (T('W3', -60)[0], 516), T('W3', -60)],
        ('T2', 'T3'): [R('T2'), L('T3')],
        ('A1', 'T3'): [L('A1'), R('T3')],
        ('T2', 'T5'): [B('T2', -60), T('T5', -60)],
        ('T2', 'T4'): hv(B('T2', 40), 520, T('T4', -50)),
        ('T4', 'T2'): hv(T('T4', 10), 500, B('T2', 80)),
        ('T2', 'T6'): vh(L('T2'), 50, L('T6')),
        ('T1', 'W1'): hv(T('T1'), 206, T('W1')),
        ('A2', 'T1'): [L('A2'), R('T1')],
        ('A1', 'W3'): vh(R('A1', -16), 1130, L('W3')),
        ('A1', 'W5'): vh(R('A1', 16), 1110, L('W5')),
        ('W1', 'W2'): [B('W1', -60), T('W2', -60)],
        ('W2', 'W8'): hv(T('W2', 60), 356, B('W8', -40)),
        ('W2', 'W7'): [R('W2', -30), L('W7', -30)],
        ('W2', 'W6'): vh(R('W2', -10), 1626, L('W6')),
        ('W2', 'W4'): vh(R('W2', 10), 1556, L('W4', -16)),
        ('W2', 'G1'): vh(R('W2', 30), 1484, R('G1')),
        ('W3', 'W5'): [B('W3', -60), T('W5', -60)],
        ('W4', 'W5'): [L('W4', 16), R('W5', 16)],
    }


def data_frame():
    H = DATA_H
    cv = K.Canvas(W, H)
    b = Board(cv, 'C3-DATA')
    cv.rect(0, 0, W, H - 140, K.BG, K.BORDER, 0)
    cv.txt(60, 44, 'Needs you owns nothing. It reads facts and routes to the service that decides.', 22, K.FG, 700)
    cv.para(60, 72, 'Left lane: threads (Orchestration V2). Right lane: Factory work (native services). Middle: the proposed attention summary, derived and never stored. Bottom: the four separate states and their reverse paths. Box at lower right: relations that do not exist.', 1400, 13, K.MUT, 18)
    legend(cv, W - 360, 26, data=True)
    b.obstacles.append((W - 360, 12, 340, 120))
    for x, s in ((DCOLX['A'], 'Threads (Orchestration V2)'), (DCOLX['M'], 'Attention summary (proposed)'), (DCOLX['C'], 'Factory work (native Factory services)')):
        cv.txt(x, 180, s, 13, K.DIM, 700)
        b.obstacles.append((x, 166, K.text_width(s, 13, 700), 18))
    for id, name, owner, basis, (col, row) in ENTS:
        X, Y = DCOLX[col], DROWY[row]
        b.nodes[id] = (X, Y, EW, EH)
        kind = 'Gated' if basis.startswith('Gated') or '· gated' in basis else 'Refinement' if basis.startswith('Proposed') else 'Existing'
        f, s, c = TAG_STYLE[kind]
        cv.rect(X, Y, EW, EH, f, s, 6)
        cv.txt(X + 10, Y + 15, id, 11, c, 700)
        cv.txt(X + EW - 10, Y + 15, basis, 9, c, anchor='end')
        if K.text_width(id, 11, 700) + K.text_width(basis, 9) + 28 > EW:
            b.errors.append(f'{id}: basis collides with id')
        n_end = fit_para(cv, b.errors, id, X + 10, Y + 30, name, EW - 20, 10, K.FG, 12, 3)
        o_lines = cv.wrap(owner, EW - 20, 9)
        oy = Y + EH - 8 - 11 * (len(o_lines) - 1)
        if oy - 9 < n_end - 12 + 3:
            b.errors.append(f'{id}: owner line collides with name')
        fit_para(cv, b.errors, id, X + 10, oy, owner, EW - 20, 9, K.DIM, 11, 2)
    routes = data_routes(b)
    notes = []
    for a, z, lab, card, style, short in RELS:
        color = SOLID if style == 'solid' else K.DIM if style == 'gated' else DASHED
        b.edge(f'{a}→{z}', routes[(a, z)], f'{short} · {card}' if card else short, style != 'solid', color=color,
               lcolor=K.MUT if style == 'solid' else K.BLUE, size=9, weight=400)
        if lab != short:
            notes.append((a, z, lab))
    # bottom-left: four-state strip, then the relation notes
    sx, sy = DCOLX['A'], DROWY[4] + EH + 52
    cv.txt(sx, sy - 12, 'Four separate states · no arrows between them', 12, K.DIM, 700)
    cols = [('Completion', 'Run / thread status (thread pill Completed; Factory task status Idle)', 'Reverse: none (a new message runs it again)'),
            ('Acceptance', 'Digest or commit pin; current on read', 'Reverse: none (superseded only by accepting new bytes or a new head)'),
            ('Delivery', 'Intent → receipt; unknown → Reconcile', 'Reverse: none in T3 (one-way door; a GitHub close or delete changes nothing)'),
            ('Settlement', 'Thread filing', 'Reverse: Un-settle (stays in the thread)')]
    bw = 236
    for i, (h, l1, l2) in enumerate(cols):
        x = sx + i * (bw + 16)
        cv.rect(x, sy, bw, 104, '#111111', K.BORDER, 8)
        cv.txt(x + 14, sy + 24, h, 14, K.FG, 700)
        fit_para(cv, b.errors, h, x + 14, sy + 46, l1, bw - 28, 11, K.MUT, 14, 2)
        fit_para(cv, b.errors, h, x + 14, sy + 78, l2, bw - 28, 10, K.GREEN, 13, 2)
    b.obstacles.append((sx, sy - 26, 4 * bw + 48, 130))
    ny = sy + 104 + 24
    nw = 4 * bw + 48
    # two columns for short notes; a note that does not fit a column gets a full-width line below
    grid, wide = [], []
    for a, z, lab in notes:
        pre = f'{a} → {z}'; px = max(62, K.text_width(pre, 11, 700) + 8)
        (grid if px + K.text_width(lab, 11) <= nw / 2 - 24 else wide).append((pre, px, lab))
    rows = (len(grid) + 1) // 2
    nh = 36 + rows * 16 + (8 + 16 * len(wide) if wide else 0)
    cv.rect(sx, ny, nw, nh, '#111111', K.BORDER, 8)
    cv.txt(sx + 16, ny + 22, 'Relation notes', 12, K.FG, 700)
    cv.txt(sx + 16 + K.text_width('Relation notes', 12, 700) + 10, ny + 22, 'full text of the relations shortened on the lines', 11, K.DIM)
    for i, (pre, px, lab) in enumerate(grid):
        x = sx + 16 + (i // rows) * (nw / 2)
        y = ny + 42 + (i % rows) * 16
        cv.txt(x, y, pre, 11, K.DIM, 700)
        cv.txt(x + px, y, lab, 11, K.CAPTION_FG)
    for j, (pre, px, lab) in enumerate(wide):
        x, y = sx + 16, ny + 42 + rows * 16 + 8 + j * 16
        cv.txt(x, y, pre, 11, K.DIM, 700)
        cv.txt(x + px, y, lab, 11, K.CAPTION_FG)
        if px + K.text_width(lab, 11) > nw - 32:
            b.errors.append(f'relation note too wide: {lab}')
    b.obstacles.append((sx, ny, nw, nh))
    bottom_left = ny + nh
    # bottom-right: non-relations
    bx, by = DCOLX['C'], DROWY[5] + EH + 28
    bw2 = DCOLX['D'] + EW - bx
    items = ['Source blocker (W7) ✕ lineage (relation 3) ✕ planned dependency (G1, #63) · three different relations',
             'Retry attempt ✕ output · acceptance and delivery are thread-scoped; a selected retry never binds a result',
             'Settlement ✕ acceptance / delivery / stop / attention item · filing changes none; settle only clears PR watches',
             'Delegated child ✕ WorkRef · a child is not Work',
             'Attention item ✕ stored record · no read state, no dismiss, no count',
             'Coordinator binding ✕ authorship or authority · same repository URL or source key ✕ shared identity']
    bh2 = 40 + 22 * len(items)
    cv.rect(bx, by, bw2, bh2, '#1c1414', '#4d2727', 8)
    cv.txt(bx + 16, by + 24, '✕  Not relations', 13, K.RED, 700)
    for i, s in enumerate(items):
        crossed(cv, b.errors, 'not relations', bx + 16, by + 50 + i * 22, s, 11, K.CAPTION_FG, bw2 - 32)
    b.obstacles.append((bx, by, bw2, bh2))
    if max(bottom_left, by + bh2) + 16 > H - 140:
        b.errors.append(f'bottom boxes end at {max(bottom_left, by + bh2)}, caption starts {H - 140}')
    errors = b.finish()
    cv.caption('C3-DATA', 'Data relationships behind Needs you', 'Entities, owning services and relations for the round-03 story, with observed relations solid and proposed ones dashed. The attention summary reads thread requests and Factory state and routes each decision to the native command; it stores nothing. Source: round-03/spec/figjam.md section B.', y=H - 140)
    return cv.save(OUT / 'C3-DATA.svg'), errors


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    failed = False
    for rec, errors in (flow_frame(), data_frame()):
        svg = Path(rec['path']); body = svg.read_text(encoding='utf-8')
        if not body.startswith('<svg id='):
            svg.write_text(body.replace('<svg xmlns=', f'<svg id="{svg.stem}" xmlns=', 1), encoding='utf-8')
        png = render(svg, OUT / 'png' / (svg.stem + '.png'))
        print(rec['path'], f"{rec['width']}x{rec['height']}", rec['sha256'], png)
        for e in errors:
            print('  ! ' + e); failed = True
    sys.exit(1 if failed else 0)
