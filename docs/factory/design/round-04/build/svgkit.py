"""Shared SVG primitives for T3Factory round-03 screens.

Conventions carried over from round-02/refined/build-story.py so the new frames sit next to
C1r2-00..09 without a visual seam: 1280x1040 frame = 1280x900 app frame + 140px caption band,
dark T3 palette, Inter text, 256px sidebar, 976px content area starting at x=280.
Text wrapping is measured with the real Inter TTFs in ./fonts when present (Figma imports with
Inter), falling back to Arial with the 0.86 width factor round-02 used.
"""
from pathlib import Path
import xml.etree.ElementTree as E
import hashlib, json

from PIL import ImageFont

HERE = Path(__file__).resolve().parent
FONT_DIR = HERE / 'fonts'
NS = 'http://www.w3.org/2000/svg'
E.register_namespace('', NS)

# Palette (round-02 values, plus the few accents the C1r2 set already used)
FG = '#f5f5f5'; MUT = '#a3a3a3'; DIM = '#737373'; BG = '#090909'; PANEL = '#111111'
SIDEBAR = '#0d0d0d'; BORDER = '#2b2b2b'; BLUE = '#a8b8ff'; WARN = '#f5ce8b'; GREEN = '#b6dfc3'
RED = '#e5a9a9'; WARN_BG = '#211b12'; WARN_BORDER = '#4d3e27'; SEL_BG = '#202020'; SEL_BORDER = '#6b7eaa'
CAPTION_BG = '#151923'; CAPTION_BORDER = '#33405a'; CAPTION_FG = '#c1ccde'; CAPTION_DIM = '#aab4c5'
PHONE_BG = '#0b0b0b'

WEIGHT_FILES = {400: 'Inter-Regular.ttf', 500: 'Inter-Medium.ttf', 600: 'Inter-SemiBold.ttf', 700: 'Inter-Bold.ttf'}
_fontcache = {}


def _font(size, weight=400):
    key = (size, weight)
    if key in _fontcache:
        return _fontcache[key]
    path = FONT_DIR / WEIGHT_FILES.get(weight, 'Inter-Regular.ttf')
    if path.exists():
        f = ImageFont.truetype(str(path), size)
        f.__dict__['_factor'] = 1.0
    else:
        f = ImageFont.truetype('C:/Windows/Fonts/' + ('arialbd.ttf' if weight >= 600 else 'arial.ttf'), size)
        f.__dict__['_factor'] = 1.0 / 0.86
    _fontcache[key] = f
    return f


def text_width(s, size, weight=400):
    f = _font(size, weight)
    return f.getlength(s) * f.__dict__['_factor']


class Canvas:
    """One SVG document. Methods append elements and return them."""

    def __init__(self, width=1280, height=1040):
        self.width, self.height = width, height
        self.svg = E.Element('{%s}svg' % NS, {'width': str(width), 'height': str(height), 'viewBox': f'0 0 {width} {height}'})

    # ---- low level -------------------------------------------------------------------------
    def el(self, tag, **attrs):
        e = E.SubElement(self.svg, '{%s}%s' % (NS, tag), {k.replace('_', '-'): str(v) for k, v in attrs.items()})
        return e

    def rect(self, x, y, w, h, fill=PANEL, stroke=BORDER, r=8, opacity=None):
        a = dict(x=x, y=y, width=w, height=h, rx=r, fill=fill, stroke=stroke)
        if opacity is not None:
            a['opacity'] = opacity
        return self.el('rect', **a)

    def txt(self, x, y, s, size=16, fill=FG, weight=400, anchor=None, family='Inter'):
        a = dict(x=x, y=y, font_family=family, font_size=size, font_weight=weight, fill=fill)
        if anchor:
            a['text_anchor'] = anchor
        e = self.el('text', **a)
        e.text = s
        return e

    def wrap(self, s, w, size, weight=400):
        lines = []
        for paragraph in str(s).split('\n'):
            line = ''
            for word in paragraph.split():
                test = (line + ' ' + word).strip()
                if text_width(test, size, weight) > w and line:
                    lines.append(line); line = word
                else:
                    line = test
            lines.append(line)
        return lines

    def para(self, x, y, s, w, size=16, fill=MUT, lh=None, weight=400, max_lines=None):
        """Wrapped text. y is the first baseline. Returns the baseline y after the last line."""
        lh = lh or round(size * 1.5)
        lines = self.wrap(s, w, size, weight)
        if max_lines and len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] = lines[-1].rstrip('.,;:') + '…'
        for i, l in enumerate(lines):
            self.txt(x, y + lh * i, l, size, fill, weight)
        return y + lh * len(lines)

    def rule(self, x, y, w, color=BORDER):
        return self.rect(x, y, w, 1, color, color, 0)

    # ---- controls --------------------------------------------------------------------------
    def button(self, x, y, w, label, primary=False, focus=False, size=14, h=38, disabled=False, danger=False, weight=None):
        fill = '#161616' if disabled else '#f0f0f0' if primary else '#171717'
        stroke = '#262626' if disabled else '#f0f0f0' if primary else '#404040'
        color = DIM if disabled else '#111111' if primary else RED if danger else FG
        self.rect(x, y, w, h, fill, stroke, 6)
        wt = weight if weight is not None else (600 if primary else 400)
        self.txt(x + 14, y + (h - size) / 2 + size * .80, label, size, color, wt)
        if focus:
            self.rect(x - 3, y - 3, w + 6, h + 6, 'none', BLUE, 8)
        return w

    def button_auto(self, x, y, label, **kw):
        size = kw.get('size', 14)
        w = int(text_width(label, size, 600 if kw.get('primary') else 400) + 28)
        self.button(x, y, w, label, **kw)
        return w

    def tag(self, x, y, label, color=MUT, w=None, size=13, h=26, fill='#181818', stroke=BORDER):
        w = w or int(text_width(label, size) + 18)
        self.rect(x, y, w, h, fill, stroke, 5)
        self.txt(x + 9, y + h - 8, label, size, color)
        return w

    def status_dot(self, x, y, color):
        self.el('circle', cx=x, cy=y, r=4, fill=color)

    def notice(self, x, y, w, text, tone='warning', h=42, size=14):
        fill, stroke, color = {
            'warning': (WARN_BG, WARN_BORDER, WARN),
            'neutral': ('#121212', BORDER, MUT),
            'info': ('#121826', '#2b3a5c', BLUE),
            'danger': ('#231414', '#4d2727', RED),
            'success': ('#12201a', '#274d3a', GREEN),
        }[tone]
        self.rect(x, y, w, h, fill, stroke, 6)
        self.txt(x + 16, y + h / 2 + size * .36, text, size, color)

    def disclosure(self, x, y, label, expanded=False, size=15, count=None):
        s = ('−' if expanded else '+') + '  ' + label + (f'  ·  {count}' if count is not None else '')
        self.txt(x, y, s, size, FG)

    # ---- shells ----------------------------------------------------------------------------
    def shell(self, active='Work', title='Work', subtitle='Retained work across the selected scope', scope_label='All projects  ⌄', scope=True,
              projects=None, nav=None, factory_tab=True):
        """Upstream-style dark shell with the Factory sidebar. Content area is x=280..1256."""
        nav = nav or ['Work', 'Issues', 'Briefs', 'Sources', 'Research', 'Workflows', 'Orchestrator']
        projects = projects if projects is not None else [('Factory', True), ('Index rollout review', False), ('Search index change', False), ('Index experiment', False), ('Rollout recommendation', False)]
        self.rect(0, 0, 1280, 900, BG, BORDER, 0)
        self.rect(0, 0, 256, 900, SIDEBAR, BORDER, 0)
        self.txt(20, 36, 'T3', 20, FG, 700); self.txt(58, 35, 'Factory', 17); self.txt(217, 35, '⌄', 17, MUT)
        if factory_tab:
            self.rect(16, 58, 224, 38, '#181818', BORDER, 6)
            self.txt(32, 83, 'Factory', 14, FG, 700); self.txt(142, 83, 'Sessions', 14, MUT)
        for i, label in enumerate(nav):
            yy = 120 + i * 44
            if label == active:
                self.rect(12, yy, 232, 38, '#232323', '#232323', 6)
            self.txt(28, yy + 25, label, 15, FG if label == active else MUT, 700 if label == active else 400)
        base = 120 + len(nav) * 44 + 32
        self.rule(16, base, 224); self.txt(28, base + 33, 'PROJECTS', 12, DIM, 700)
        yy = base + 69
        for name, is_project in projects:
            if is_project:
                self.txt(28, yy, '⌄  ' + name, 15, FG)
            else:
                self.txt(44, yy, name, 14, MUT)
            yy += 36
        self.txt(28, 832, '+  New thread', 14, MUT); self.txt(28, 874, 'Settings', 14, MUT)
        if scope:
            self.txt(280, 38, title, 24, FG, 700)
            if scope_label:
                self.button(1024, 16, 232, scope_label)
            if subtitle:
                self.txt(280, 76, subtitle, 14, MUT)

    def caption(self, id, title, description, footer='DESIGN STUDY · Illustrative data · Existing capability + proposed presentation · Not a runtime or parity result', y=900):
        self.rect(0, y, self.width, 140, CAPTION_BG, CAPTION_BORDER, 0)
        self.txt(24, y + 31, f'{id} · {title}', 18, FG, 700)
        # Round-02 note: Figma measures Inter slightly wider than local wrapping; 13px keeps the band to three lines.
        self.para(24, y + 60, description, self.width - 48, 13, CAPTION_FG, 20)
        self.txt(24, y + 117, footer, 12, CAPTION_DIM)

    def phone_shell(self, x=0, y=0, w=390, h=844, title='Work', back=None):
        """Phone frame: status bar, nav bar with optional back, content starts at y+100."""
        self.rect(x, y, w, h, PHONE_BG, BORDER, 0)
        self.txt(x + 24, y + 30, '9:41', 14, FG, 600)
        self.txt(x + w - 24, y + 30, '●●●', 10, MUT, anchor='end')
        if back:
            self.txt(x + 16, y + 76, '‹ ' + back, 16, BLUE)
            self.txt(x + w / 2, y + 76, title, 17, FG, 600, anchor='middle')
        else:
            self.txt(x + 20, y + 80, title, 28, FG, 700)
        self.rule(x, y + 100, w)

    # ---- output ----------------------------------------------------------------------------
    def save(self, path):
        path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
        E.ElementTree(self.svg).write(path, encoding='utf-8')
        return {'path': str(path), 'width': self.width, 'height': self.height, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def write_manifest(records, path):
    Path(path).write_text(json.dumps(records, indent=2), encoding='utf-8')
