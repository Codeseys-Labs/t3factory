"""Measured SVG primitives and local PNG export for the F5 design archive."""
from pathlib import Path
import hashlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from PIL import ImageFont

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent.parent / 'round-04' / 'build' / 'fonts'
CHROME = Path('C:/Program Files/Google/Chrome/Application/chrome.exe')
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
WEIGHTS = {400: 'Inter-Regular.ttf', 500: 'Inter-Medium.ttf',
           600: 'Inter-SemiBold.ttf', 700: 'Inter-Bold.ttf'}
FONTCACHE = {}


def font(size, weight=400):
    key = size, weight
    if key not in FONTCACHE:
        FONTCACHE[key] = ImageFont.truetype(str(FONTS / WEIGHTS[weight]), size)
    return FONTCACHE[key]


def text_width(text, size, weight=400):
    return font(size, weight).getlength(str(text))


class Canvas:
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.svg = ET.Element('{%s}svg' % NS, {
            'width': str(width), 'height': str(height), 'viewBox': f'0 0 {width} {height}'})

    def el(self, tag, **attrs):
        return ET.SubElement(self.svg, '{%s}%s' % (NS, tag),
                             {key.replace('_', '-'): str(value) for key, value in attrs.items()})

    def rect(self, x, y, width, height, fill, stroke='none', radius=0):
        return self.el('rect', x=x, y=y, width=width, height=height, rx=radius,
                       fill=fill, stroke=stroke)

    def txt(self, x, y, text, size=14, fill='#f5f5f5', weight=400, anchor=None, family='Inter'):
        attrs = dict(x=x, y=y, font_family=family, font_size=size, font_weight=weight, fill=fill)
        if anchor:
            attrs['text_anchor'] = anchor
        element = self.el('text', **attrs)
        element.text = str(text)
        return element

    def wrap(self, text, width, size, weight=400):
        lines = []
        for paragraph in str(text).split('\n'):
            line = ''
            for word in paragraph.split():
                candidate = (line+' '+word).strip()
                if line and text_width(candidate, size, weight) > width:
                    lines.append(line)
                    line = word
                else:
                    line = candidate
            lines.append(line)
        return lines

    def save(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        content = ET.tostring(self.svg, encoding='utf-8', xml_declaration=True)
        path.write_bytes(content)
        return {'path': str(path), 'width': self.width, 'height': self.height,
                'sha256': hashlib.sha256(content).hexdigest()}


def render(svg_path, png_path):
    svg_path, png_path = Path(svg_path).resolve(), Path(png_path).resolve()
    root = ET.parse(svg_path).getroot()
    width, height = int(root.get('width')), int(root.get('height'))
    if not CHROME.is_file():
        raise FileNotFoundError(CHROME)
    for filename in WEIGHTS.values():
        if not (FONTS / filename).is_file():
            raise FileNotFoundError(FONTS / filename)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    faces = ''.join(
        f"@font-face{{font-family:'Inter';font-weight:{weight};src:url('{(FONTS/filename).as_uri()}') format('truetype');}}"
        for weight, filename in WEIGHTS.items())
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        html = directory / 'frame.html'
        html.write_text(
            '<!doctype html><meta charset="utf-8"><style>'+faces+
            'html,body{margin:0;background:#000}svg{display:block}</style>'+
            svg_path.read_text(encoding='utf-8'), encoding='utf-8')
        subprocess.run([
            str(CHROME), '--headless=new', '--disable-gpu', '--hide-scrollbars',
            '--no-first-run', '--no-default-browser-check',
            f'--user-data-dir={directory / "profile"}', '--allow-file-access-from-files',
            f'--window-size={width},{height}', f'--screenshot={png_path}', html.as_uri(),
        ], check=True, capture_output=True, timeout=120)
    return png_path
