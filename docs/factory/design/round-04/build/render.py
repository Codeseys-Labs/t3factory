"""Render round-03 SVG screens to PNG for local review.

Uses headless Chrome with the local Inter TTFs through @font-face so wrapping and weights match
what Figma shows after import (Figma substitutes its own Inter). Falls back to rsvg-convert when
Chrome is missing. Usage: python render.py <svg-or-dir> [out-dir]
"""
import subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHROME = Path('C:/Program Files/Google/Chrome/Application/chrome.exe')
FONTS = HERE / 'fonts'


def _html_for(svg_path: Path, width: int, height: int) -> str:
    faces = ''.join(
        f"@font-face{{font-family:'Inter';font-weight:{w};src:url('file:///{(FONTS / f).as_posix()}') format('truetype');}}"
        for w, f in ((400, 'Inter-Regular.ttf'), (500, 'Inter-Medium.ttf'), (600, 'Inter-SemiBold.ttf'), (700, 'Inter-Bold.ttf'))
    )
    svg = svg_path.read_text(encoding='utf-8')
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{faces}html,body{{margin:0;background:#000}}svg{{display:block}}</style></head><body>{svg}</body></html>"


def _size(svg_path: Path):
    import re
    head = svg_path.read_text(encoding='utf-8')[:400]
    w = int(re.search(r'width="(\d+)"', head).group(1)); h = int(re.search(r'height="(\d+)"', head).group(1))
    return w, h


def render(svg_path: Path, out_png: Path):
    # Chrome resolves --screenshot relative to its own cwd, so both paths must be absolute.
    svg_path, out_png = svg_path.resolve(), out_png.resolve()
    w, h = _size(svg_path)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    if CHROME.exists():
        with tempfile.TemporaryDirectory() as td:
            html = Path(td) / 'frame.html'
            html.write_text(_html_for(svg_path, w, h), encoding='utf-8')
            profile = Path(td) / 'profile'
            cmd = [str(CHROME), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
                   f'--user-data-dir={profile}', '--allow-file-access-from-files', f'--window-size={w},{h}', f'--screenshot={out_png}', html.as_uri()]
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    else:
        subprocess.run(['rsvg-convert', '-o', str(out_png), str(svg_path)], check=True, timeout=120)
    return out_png


def main(argv):
    src = Path(argv[1]); out = Path(argv[2]) if len(argv) > 2 else src.parent / 'png'
    files = sorted(src.glob('*.svg')) if src.is_dir() else [src]
    for f in files:
        png = render(f, out / (f.stem + '.png'))
        print(png)


if __name__ == '__main__':
    main(sys.argv)
