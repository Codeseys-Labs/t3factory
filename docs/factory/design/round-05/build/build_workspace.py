"""Render the F5 project-workspace design from its shared fixtures and body scenes."""
from workspace_graph import assemble
from contextlib import contextmanager
from pathlib import Path
import json
import sys
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
import native_svg as K
from native_svg import render

BASE = json.loads((ROOT / 'spec' / 'base.json').read_text(encoding='utf-8'))
C = BASE['tokens']
W, H, APP_H = 1600, 1040, 900
OUT = ROOT / 'screens'
STYLES = {
    'panel': ('#111111', '#262626', 8),
    'row': ('#080808', '#262626', 6),
    'row-selected': ('#121c30', '#34578e', 6),
    'inspector': ('#0b0b0b', '#262626', 12),
    'neutral': ('#111111', '#262626', 8),
    'warning': ('#201b12', '#4d3e27', 8),
    'success': ('#102018', '#274536', 8),
    'danger': ('#241414', '#513030', 8),
    'code': ('#0b0b0b', '#262626', 8),
    'composer': ('#111111', '#303030', 14),
    'menu': ('#111111', '#383838', 8),
    'field': ('#0b0b0b', '#383838', 8),
    'header': ('#151515', '#262626', 6),
    'selected': ('#121c30', '#34578e', 6),
    'none': ('none', 'none', 0),
}
DEFAULT_STYLE = {'card': 'panel', 'row': 'row', 'inspector': 'inspector',
                 'notice': 'neutral', 'code': 'code', 'composer': 'composer', 'menu': 'menu'}
KINDS = {'text', 'card', 'row', 'inspector', 'notice', 'code', 'composer', 'menu', 'button', 'tag', 'rule'}


class Canvas(K.Canvas):
    def __init__(self, width=W, height=H):
        super().__init__(width, height)
        self.sink = self.svg
        self.text_records = []

    def el(self, tag, **attrs):
        return ET.SubElement(self.sink, '{%s}%s' % (K.NS, tag),
                             {key.replace('_', '-'): str(value) for key, value in attrs.items()})

    @contextmanager
    def group(self, name):
        old = self.sink
        self.sink = ET.SubElement(old, '{%s}g' % K.NS, {'id': name})
        try:
            yield
        finally:
            self.sink = old

    def txt(self, x, y, text, size=14, fill=None, weight=400, anchor=None, family='Inter'):
        self.text_records.append((x, y, str(text), size, weight, anchor, family))
        return super().txt(x, y, str(text), size, fill or C['FG'], weight, anchor, family)


def color(value):
    return C.get(value, value)


def icon(cv, name, x, y, size=16, tint=None):
    tint = tint or C['MUT']
    def path(d):
        cv.el('path', d=d, fill='none', stroke=tint, stroke_width=1.5,
              stroke_linecap='round', stroke_linejoin='round')
    if name == 'search':
        cv.el('circle', cx=x + 6, cy=y + 6, r=4.5, fill='none', stroke=tint, stroke_width=1.5)
        path(f'M{x+9.5},{y+9.5} L{x+14},{y+14}')
    elif name in ('back', 'forward', 'down'):
        if name == 'back':
            path(f'M{x+10},{y+3} L{x+5},{y+8} L{x+10},{y+13}')
        elif name == 'forward':
            path(f'M{x+5},{y+3} L{x+10},{y+8} L{x+5},{y+13}')
        else:
            path(f'M{x+4},{y+6} L{x+8},{y+10} L{x+12},{y+6}')
    elif name == 'plus':
        path(f'M{x+8},{y+2} V{y+14} M{x+2},{y+8} H{x+14}')
    elif name == 'folder':
        path(f'M{x+1},{y+4} H{x+6} L{x+8},{y+6} H{x+15} V{y+14} H{x+1} Z')
    elif name == 'compose':
        path(f'M{x+12},{y+2} L{x+15},{y+5} L{x+7},{y+13} L{x+3},{y+14} L{x+4},{y+10} Z')
        path(f'M{x+1},{y+3} V{y+15} H{x+13}')
    elif name == 'collapse':
        cv.rect(x, y, size, size, 'none', tint, 2)
        path(f'M{x+5},{y+1} V{y+15} M{x+12},{y+5} L{x+9},{y+8} L{x+12},{y+11}')
    elif name == 'branch':
        for px, py in [(x+4, y+3), (x+4, y+13), (x+13, y+4)]:
            cv.el('circle', cx=px, cy=py, r=2, fill='none', stroke=tint, stroke_width=1.2)
        path(f'M{x+4},{y+5} V{y+11} M{x+4},{y+10} C{x+4},{y+6} {x+13},{y+9} {x+13},{y+6}')
    elif name == 'panel':
        cv.rect(x, y, size, size, 'none', tint, 2)
        path(f'M{x+10},{y+1} V{y+15}')
    elif name == 'terminal':
        cv.rect(x, y, size, size, 'none', tint, 2)
        path(f'M{x+3},{y+5} L{x+6},{y+8} L{x+3},{y+11} M{x+9},{y+11} H{x+13}')
    elif name == 'settings':
        cv.el('circle', cx=x+8, cy=y+8, r=5, fill='none', stroke=tint, stroke_width=1.4)
        cv.el('circle', cx=x+8, cy=y+8, r=2, fill='none', stroke=tint, stroke_width=1.4)
        for dx, dy in [(8,0), (8,16), (0,8), (16,8)]:
            path(f'M{x+8+(dx-8)*.65},{y+8+(dy-8)*.65} L{x+dx},{y+dy}')
    elif name == 'filter':
        path(f'M{x+2},{y+4} H{x+14} M{x+4},{y+8} H{x+12} M{x+6},{y+12} H{x+10}')
    elif name == 'activity':
        path(f'M{x+2},{y+13} V{y+8} M{x+7},{y+13} V{y+3} M{x+12},{y+13} V{y+6}')
    else:
        raise ValueError('Unsupported native icon: ' + name)


def hit(cv, box):
    x, y, width, height = box
    # Figma removes zero-opacity SVG shapes, including their padded interaction bounds.
    cv.el('rect', x=x, y=y, width=width, height=height, fill='#000000', fill_opacity=0.001)


def button(cv, box, props):
    x, y, width, height = box
    variant = props.get('variant', 'secondary')
    if variant == 'hotspot':
        return
    size = props.get('size', 14)
    label = props['label']
    if variant == 'primary':
        fill, stroke, text = C['BLUE'], C['BLUE'], '#ffffff'
    elif variant == 'disabled':
        fill, stroke, text = '#111111', '#222222', '#686868'
    elif variant == 'ghost':
        fill, stroke, text = 'none', 'none', C['FG']
    elif variant == 'danger':
        fill, stroke, text = '#241414', '#513030', C['RED']
    elif variant == 'secondary':
        fill, stroke, text = '#161616', '#383838', C['FG']
    else:
        raise ValueError('Unsupported button variant: ' + variant)
    cv.rect(x, y, width, height, fill, stroke, 6 if height <= 28 else 8)
    cv.txt(x + 12, y + (height-size)/2 + size*.80, label, size, text, 500)


def draw_lines(cv, bx, by, lines):
    for line in lines:
        text = str(line['t'])
        size, weight = line.get('s', 14), line.get('w', 400)
        parts = cv.wrap(text, line['wrap'], size, weight) if 'wrap' in line else text.split('\n')
        leading = line.get('lh', round(size*1.45))
        for i, part in enumerate(parts):
            cv.txt(bx+line.get('x', 0), by+line.get('y', size)+i*leading, part,
                   size, color(line.get('c', 'FG')), weight,
                   anchor='middle' if line.get('a') == 'middle' else 'end' if line.get('a') == 'end' else None,
                   family='Consolas' if line.get('mono') else 'Inter')


def region(cv, item):
    x, y, width, height = item['box']
    kind, props = item['kind'], item.get('props', {})
    if kind not in KINDS:
        raise ValueError('Unsupported region kind: ' + kind)
    if kind == 'button':
        button(cv, item['box'], props)
        return
    if kind == 'rule':
        cv.rect(x, y, width, max(height, 1), C['BORDER'], C['BORDER'], 0)
        return
    if kind == 'tag':
        tint = C['BLUE_TEXT'] if props.get('role') == 'status' else C['WARN'] if props.get('role') == 'warning' else C['MUT']
        cv.rect(x, y, width, height, '#151515', C['BORDER'], 5)
        cv.txt(x+8, y+height/2+props.get('size', 12)*.35, props['label'], props.get('size', 12), tint, 500)
        return
    style = props.get('style', DEFAULT_STYLE.get(kind, 'none'))
    if style not in STYLES:
        raise ValueError('Unsupported style: ' + style)
    if style != 'none':
        fill, stroke, radius = STYLES[style]
        cv.rect(x, y, width, height, fill, stroke, radius)
    if props.get('rule') == 'bottom':
        cv.rect(x, y+height-1, width, 1, C['BORDER'], C['BORDER'], 0)
    for shape in props.get('shapes', []):
        if shape['type'] == 'rule':
            cv.rect(x+shape['x'], y+shape['y'], shape['w'], max(shape.get('h', 1), 1), C['BORDER'], C['BORDER'], 0)
        elif shape['type'] == 'rect':
            fill, stroke, radius = STYLES[shape.get('style', 'field')]
            cv.rect(x+shape['x'], y+shape['y'], shape['w'], shape['h'], fill, stroke, radius)
        else:
            raise ValueError('Unsupported shape: ' + shape['type'])
    draw_lines(cv, x, y, props.get('lines', []))


def linked(cv, item, links, scene_id):
    link = item.get('props', {}).get('link')
    if not link:
        region(cv, item)
        return
    label = link.get('label') or item.get('props', {}).get('label') or item['id']
    layer = f"{link['edge']} · {label}"
    with cv.group(layer):
        region(cv, item)
        hit(cv, item['box'])
    links.append({**link, 'from': scene_id, 'layer': layer, 'control': label, 'box': item['box']})


def sidebar(cv, scene):
    mode = scene['shell'].get('mode', 'workspace')
    native_state = str(scene.get('state', {}).get('nativeExecution', '')).lower()
    active = native_state in ('working', 'provider-working', 'provider_working', 'factory-working')
    waiting = mode == 'thread' and native_state == 'dispatch-accepted'
    with cv.group('F5 Native T3 sidebar · ' + scene['id']):
        cv.rect(0, 0, 320, APP_H, C['SIDEBAR'], C['SIDEBAR'], 0)
        cv.rect(319, 0, 1, APP_H, '#202020', '#202020', 0)
        icon(cv, 'collapse', 18, 19, tint=C['FG'])
        cv.txt(51, 33, 'T3 Factory', 15, C['FG'], 600)
        icon(cv, 'back', 149, 20)
        icon(cv, 'forward', 180, 20, tint='#545454')
        icon(cv, 'search', 18, 67)
        cv.txt(42, 80, 'Search', 14, C['MUT'])
        icon(cv, 'filter', 237, 67)
        icon(cv, 'folder', 266, 67)
        icon(cv, 'compose', 293, 67)
        recent = [('Factory', 'Index rollout review', 'factory/review-index', '12m'),
                  ('Factory', 'Benchmark index paths', 'main', '1h'),
                  ('Docs', 'Draft the rollout brief', 'docs/rollout', '2h')]
        coordinator = mode == 'thread' and scene['shell'].get('threadKind') == 'coordinator'
        if coordinator:
            recent[0] = ('Factory', 'Factory coordinator', 'main', 'now')
        elif waiting:
            recent.insert(0, ('Factory', scene['shell']['breadcrumb'], '', 'now'))
        for i, (project, title, branch, age) in enumerate(recent):
            yy = 111+i*88
            if (coordinator or waiting) and i == 0:
                cv.rect(8, yy-18, 304, 80, '#181818', 'none', 8)
            cv.rect(17, yy-9, 14, 14, C['BLUE'] if project == 'Factory' else '#514b27', 'none', 3)
            cv.txt(21, yy+1, 'T', 9, '#ffffff', 600)
            cv.txt(39, yy+2, project, 12, C['MUT'])
            cv.txt(300, yy+2, age, 11, C['DIM'], anchor='end')
            cv.txt(17, yy+27, title, 14, C['FG'], 500)
            if waiting and i == 0:
                cv.txt(17, yy+51, 'Dispatch accepted · awaiting provider', 11, C['BLUE_TEXT'])
            else:
                icon(cv, 'branch', 18, yy+38, tint=C['DIM'])
                cv.txt(40, yy+51, branch, 11, C['DIM'])
        cv.txt(17, 614, 'Working', 12, C['MUT'], 500)
        cv.txt(300, 614, '2' if active else '1', 12, C['DIM'], anchor='end')
        cv.rect(8, 633, 304, 76, '#0a0a0a', 'none', 8)
        cv.txt(18, 653, 'Factory', 12, C['MUT'])
        cv.txt(18, 678, 'Evaluate index caching', 14, C['FG'], 500)
        cv.txt(18, 697, 'factory/cache-study', 11, C['DIM'])
        if active:
            cv.rect(8, 716, 304, 88, '#181818', '#262626', 8)
            cv.txt(18, 737, 'Factory', 12, C['MUT'])
            cv.txt(18, 761, 'Keep search responsive', 14, C['FG'], 500)
            cv.txt(18, 783, 'Working · isolated worktree', 11, C['BLUE_TEXT'])
        cv.txt(17, 838, 'Settled', 12, C['MUT'], 500)
        icon(cv, 'down', 292, 826, tint=C['DIM'])
        icon(cv, 'settings', 17, 874)
        icon(cv, 'branch', 56, 874)
        icon(cv, 'activity', 96, 874)
        cv.txt(291, 887, '↻', 17, C['MUT'])


def chrome(cv, scene, links):
    shell = scene['shell']
    mode = shell.get('mode', 'workspace')
    if mode not in ('workspace', 'thread', 'settings', 'phone', 'narrow'):
        raise ValueError('Unsupported shell mode: ' + mode)
    if mode == 'phone':
        return
    if mode == 'narrow':
        icon(cv, 'collapse', 16, 18)
        content_x = 68
    else:
        sidebar(cv, scene)
        content_x = 340
    cv.rect(content_x, 19, 16, 16, C['BLUE'], 'none', 3)
    cv.txt(content_x+4, 31, 'T', 10, '#ffffff', 600)
    cv.txt(content_x+26, 33, BASE['project']['name'], 14, C['MUT'], 500)
    cv.txt(content_x+90, 33, '/', 14, C['DIM'])
    cv.txt(content_x+112, 33, shell.get('breadcrumb', shell.get('section', 'Work')), 14, C['FG'], 500)
    if mode != 'narrow':
        icon(cv, 'terminal', 1480, 19)
        icon(cv, 'panel', 1516, 19)
        icon(cv, 'settings', 1552, 19)
    if mode in ('workspace', 'settings', 'narrow'):
        items = [('Work', 72), ('Intake', 76), ('Workflows', 110), ('More', 70)]
        xx = content_x
        section = shell.get('section', 'Work')
        for label, width in items:
            selected = section == label
            target = shell.get('navTargets', {}).get(label)
            if target:
                edge = f"F5-N-{scene['id']}-{label}"
                layer = edge + ' · ' + label
            else:
                layer = 'Native tab ' + label + ' · ' + scene['id']
            box = [xx, 56, width, 34]
            with cv.group(layer):
                # Figma discards transparent-only SVG groups, so the tab owns its visible hit area.
                cv.rect(xx, 56, width, 34, C['BG'], 'none', 0)
                if selected:
                    cv.rect(xx, 58, width, 30, '#191a1d', 'none', 6)
                cv.txt(xx+12, 78, label, 13, C['FG'] if selected else C['MUT'], 500)
            if target:
                links.append({'edge': edge, 'from': scene['id'], 'to': target, 'type': 'navigate',
                              'effect': 'navigation', 'layer': layer, 'control': label, 'box': box})
            xx += width+4
        end = 940 if mode == 'narrow' else 1580
        cv.rect(content_x, 99, end-content_x, 1, '#202020', '#202020', 0)


def caption(cv, scene):
    width = int(cv.svg.get('width', str(W)))
    height = int(cv.svg.get('height', str(H)))
    cv.rect(0, APP_H, width, height-APP_H, C['CAPTION_BG'], '#283244', 0)
    title = scene['id'] + ' · ' + scene['title']
    footer = 'DESIGN STUDY · Fictional data · Navigation only; not runtime, accessibility or parity proof'
    if width >= 1200:
        cv.txt(24, 932, title, 17, C['FG'], 600)
        cv.txt(width-24, 930, scene['tag'], 12, '#b9c6df', 500, anchor='end')
        body_y, body_size, maximum = 955, 13, 3
        footer_y = 1021
    else:
        cv.txt(16, 930, title, 14 if width < 600 else 17, C['FG'], 600)
        cv.txt(16, 954, scene['tag'], 11 if width < 600 else 12, '#b9c6df', 500)
        body_y, body_size = 980, 12 if width < 600 else 13
        maximum = 7 if width < 600 else 3
        footer_y = height-44 if width < 600 else height-18
    body_width = min(width-48, 1208) if scene.get('studyLinks') else width-48
    lines = cv.wrap(scene['caption'], body_width, body_size)
    if len(lines) > maximum:
        raise ValueError(scene['id'] + ': caption exceeds its measured lane')
    for i, line in enumerate(lines):
        cv.txt(24 if width >= 1200 else 16, body_y+i*18, line, body_size, '#b9c6cf')
    for i, line in enumerate(cv.wrap(footer, width-32, 10 if width < 600 else 12)):
        cv.txt(16 if width < 1200 else 24, footer_y+i*14, line, 10 if width < 600 else 12, '#8b97a9')


def overlaps(a, b):
    return a[0] < b[0]+b[2] and b[0] < a[0]+a[2] and a[1] < b[1]+b[3] and b[1] < a[1]+a[3]


def validate_regions(scene):
    errors = []
    ids = set()
    controls = []
    canvas_width = scene.get('canvas', {}).get('width', W)
    measure = K.Canvas(canvas_width, H)
    for item in scene['regions']:
        key = item['id']
        if key in ids:
            errors.append('duplicate region ' + key)
        ids.add(key)
        x, y, width, height = item['box']
        if width <= 0 or height <= 0 or x < 0 or y < 0 or x+width > canvas_width or y+height > APP_H:
            errors.append('region outside app: ' + key)
        props = item.get('props', {})
        if props.get('link'):
            controls.append((key, item['box']))
            minimum = 44 if scene['shell'].get('mode') == 'phone' else 28
            if width < minimum or height < minimum:
                errors.append('undersized linked control ' + key)
        if item['kind'] == 'button' and props.get('variant') != 'hotspot':
            if K.text_width(props.get('label', ''), props.get('size', 14), 500)+24 > width:
                errors.append('button label too wide ' + key)
        for line in props.get('lines', []):
            size, weight = line.get('s', 14), line.get('w', 400)
            parts = measure.wrap(str(line['t']), line['wrap'], size, weight) if 'wrap' in line else str(line['t']).split('\n')
            leading = line.get('lh', round(size*1.45))
            for i, part in enumerate(parts):
                tx, ty = line.get('x', 0), line.get('y', size)+i*leading
                tw = K.text_width(part, size, weight)
                left = tx-tw/2 if line.get('a') == 'middle' else tx-tw if line.get('a') == 'end' else tx
                if left < -.5 or left+tw > width+.5 or ty-size*.82 < -.5 or ty+size*.22 > height+.5:
                    errors.append(f'text outside {key}: {part}')
    for item in scene.get('studyLinks', []):
        key = item['id']
        x, y, width, height = item['box']
        props, link = item['props'], item['props'].get('link', {})
        if key in ids:
            errors.append('duplicate study region ' + key)
        ids.add(key)
        controls.append((key, item['box']))
        if x < 0 or y < APP_H+40 or x+width > canvas_width or y+height > scene.get('canvas', {}).get('height', H)-24:
            errors.append('study control outside caption lane: ' + key)
        if item['kind'] != 'button' or link.get('effect') != 'history-read' or link.get('type', 'navigate') != 'navigate':
            errors.append('study control must only observe a later record: ' + key)
        if width < 28 or height < 28 or K.text_width(props.get('label', ''), props.get('size', 14), 500)+24 > width:
            errors.append('undersized study control: ' + key)
    for i, (key, box) in enumerate(controls):
        for other, other_box in controls[i+1:]:
            if overlaps(box, other_box):
                errors.append('overlapping linked controls ' + key + ' / ' + other)
    return errors


def build(scene):
    canvas = scene.get('canvas', {})
    width, height = canvas.get('width', W), canvas.get('height', H)
    cv = Canvas(width, height)
    cv.svg.set('id', scene['id'])
    cv.rect(0, 0, width, APP_H, C['BG'], C['BG'], 0)
    links = []
    chrome(cv, scene, links)
    regions = scene['regions']
    ordinary = [r for r in regions if not (r['kind'] == 'button' and r.get('props', {}).get('link'))]
    buttons = [r for r in regions if r['kind'] == 'button' and r.get('props', {}).get('link')]
    for item in ordinary+buttons:
        linked(cv, item, links, scene['id'])
    caption(cv, scene)
    for item in scene.get('studyLinks', []):
        linked(cv, item, links, scene['id'])
        links[-1]['scope'] = 'study'
    saved = cv.save(OUT / (scene['id']+'.svg'))
    saved.update({'id': scene['id'], 'title': scene['title'], 'tag': scene['tag'],
                  'links': links, 'state': scene['state'],
                  'staticControls': scene.get('staticControls', []) + [
                      'Common native search, recent threads, utility icons, composer input/send and platform operations are not connected in this bounded design prototype.'
                  ]})
    render(OUT / (scene['id']+'.svg'), OUT / 'png' / (scene['id']+'.png'))
    return saved


def load_scenes():
    documents = {}
    for name in ('collections', 'workflows', 'triggers', 'parent', 'sourceowners', 'delivery', 'operations'):
        documents[name] = json.loads((ROOT / 'spec' / (name+'.json')).read_text(encoding='utf-8'))
    return assemble(documents, BASE)


def main(selected):
    scenes, notes = load_scenes()
    all_ids = {scene['id'] for scene in scenes}
    if len(all_ids) != len(scenes):
        raise ValueError('Duplicate scene id')
    unknown_selected = set(selected)-all_ids
    if unknown_selected:
        raise ValueError('Unknown selected scene(s): ' + ', '.join(sorted(unknown_selected)))
    candidates = [scene for scene in scenes if not selected or scene['id'] in selected]
    preflight = [scene['id'] + ': ' + error for scene in candidates for error in validate_regions(scene)]
    if preflight:
        raise ValueError('\n'.join(preflight))
    records = []
    links = []
    for scene in candidates:
        record = build(scene)
        records.append(record)
        links.extend(record['links'])
        print(scene['id'], record['sha256'][:12], len(record['links']), 'links')
    if len({link['edge'] for link in links}) != len(links):
        raise ValueError('Duplicate prototype edge')
    for link in links:
        if link.get('type', 'navigate') == 'back':
            if not link.get('allowedOrigins') or link.get('effect') not in ('navigation', 'return'):
                raise ValueError('Unsafe/unspecified history return: ' + link['edge'])
        elif link['to'] not in all_ids:
            raise ValueError('Unknown destination ' + link['to'] + ' from ' + link['edge'])
    output = {'schema': 't3factory-workspace-export/1', 'frames': records, 'prototypeLinks': links,
              'notes': notes, 'base': BASE, 'source': 'spec/base.json + seven scene documents + build/workspace_graph.py + delivery_graph.py + operations_graph.py',
              'proof': 'Native-sized static render and geometry only; Figma import and clicked navigation are separate.'}
    name = 'manifest-selected.json' if selected else 'manifest.json'
    (OUT / name).write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding='utf-8')
    if not selected:
        (ROOT / 'spec' / 'scenes.json').write_text(json.dumps({'base': BASE, 'scenes': scenes, 'prototypeLinks': links}, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'{len(records)} frames; {len(links)} links; geometry and target validation passed')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    main(sys.argv[1:])
