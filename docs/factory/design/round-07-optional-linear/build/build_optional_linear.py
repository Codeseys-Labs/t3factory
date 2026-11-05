"""Bounded editable design sources; no application or integration implementation."""
from pathlib import Path
from contextlib import contextmanager
import hashlib
import json
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RESEARCH = ROOT.parent
PRIMITIVES = RESEARCH / 'round-05' / 'build'
sys.path.insert(0, str(PRIMITIVES))
import native_svg as K
import build_workspace as B

OUT = ROOT / 'screens'
C = B.C
SCENES = []
EDGES = []
REGIONS = []
TEXTS = []


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Canvas(K.Canvas):
    def __init__(self, sid, title, note, width=1600, section='Work'):
        super().__init__(width, 1040)
        self.sid, self.sink, self.texts = sid, self.svg, []
        self.stack = []
        self.rect(0, 0, width, 1040, C['BG'])
        scene = {'id': sid, 'shell': {'mode': 'workspace', 'section': section}, 'state': {}}
        B.sidebar(self, scene)
        # Reuse the reviewed shell, with an idle conversation fixture.
        side = list(self.svg)[1]
        for el in list(side):
            if el.tag.endswith('rect') and el.get('y') == '633':
                side.remove(el)
            elif el.tag.endswith('text') and el.get('y') in ('653', '678', '697'):
                side.remove(el)
            elif el.tag.endswith('text') and el.get('x') == '300' and el.get('y') == '614':
                el.text = '0'
        with self.group('chrome-idle-turns'):
            self.txt(18, 653, 'No active turns', 12, C['DIM'])
        with self.group('chrome-topbar'):
            self.rect(340, 19, 16, 16, C['BLUE'], radius=3)
            self.txt(344, 31, 'T', 10, '#fff', 600)
            self.txt(366, 33, 'Factory', 14, C['MUT'], 500)
            self.txt(430, 33, '/', 14, C['DIM'])
            self.txt(452, 33, 'Connections' if section == 'More' else section, 14, weight=500)
            for name, x in [('terminal', width-120), ('panel', width-84), ('settings', width-48)]:
                B.icon(self, name, x, 19)
        work_target = 'R7-01' if sid in ('R7-01','R7-02') else 'R7-03' if sid == 'R7-10' else 'R7-04'
        for label, x, w, target in [('Work', 340, 72, work_target), ('Intake', 416, 76, 'R7-06'),
                                    ('Workflows', 496, 110, None), ('More', 610, 70, 'R7-07')]:
            with self.group('nav-'+label.lower()):
                self.rect(x, 58, w, 30, '#191a1d' if label == section else '#000', radius=6)
                self.txt(x+12, 78, label, 13, C['FG'] if label == section else C['MUT'], 500)
            if target:
                self.action('nav-'+label.lower(), [x, 56, w, 34], label, target,
                            'navigate', 'Retain local records; navigation has no execution effect.')
        self.rect(340, 99, width-360, 1, '#202020')
        with self.group('specification-outside-product'):
            self.rect(0, 900, width, 140, C['CAPTION_BG'], '#283244')
            self.txt(24, 932, sid+' · '+title, 17, weight=600)
            for i, line in enumerate(self.wrap(note, width-48, 13)):
                self.txt(24, 958+i*19, line, 13, '#b9c6cf')
            self.txt(24, 1021, 'PROPOSED DESIGN · Fictional fixtures · Editable Inter text · No runtime, native-import, API or accessibility proof', 12, '#8b97a9')
        self.meta = {'id': sid, 'title': title, 'width': width, 'height': 1040, 'productHeight': 900,
                     'caption': note, 'composition': None}

    def el(self, tag, **attrs):
        return ET.SubElement(self.sink, '{%s}%s' % (K.NS, tag),
                             {key.replace('_', '-'): str(value) for key, value in attrs.items()})

    @contextmanager
    def group(self, name):
        old = self.sink
        self.sink = ET.SubElement(old, '{%s}g' % K.NS, {'id': name})
        self.stack.append(name)
        try:
            yield
        finally:
            self.stack.pop()
            self.sink = old

    def txt(self, x, y, text, size=14, fill=None, weight=400, anchor=None, family='Inter'):
        node = super().txt(x, y, text, size, fill or C['FG'], weight, anchor, family)
        return node

    def action(self, group, box, label, target=None, kind='navigate', effect='', **extra):
        region = {'screen': self.sid, 'groupId': group, 'label': label, 'box': box,
                  'kind': kind, 'target': target, 'effect': effect, **extra}
        REGIONS.append(region)
        if target:
            EDGES.append({'id': self.sid+'--'+group, 'from': self.sid, 'to': target,
                          'groupId': group, 'box': box, 'kind': kind, 'effect': effect})

    def btn(self, gid, x, y, w, label, target=None, primary=False, kind='navigate', effect='', disabled=False):
        with self.group(gid):
            self.rect(x, y, w, 32, '#111111' if disabled else C['BLUE'] if primary else '#161616',
                      '#262626' if disabled else C['BLUE'] if primary else '#383838', 6)
            self.txt(x+12, y+21, label, 13, C['DIM'] if disabled else '#fff', 500)
        self.action(gid, [x, y, w, 32], label, target, 'disabled' if disabled else kind, effect)

    def lines(self, gid, x, y, text, width, size=14, color=None, weight=400, leading=21):
        with self.group(gid):
            for i, line in enumerate(self.wrap(text, width, size, weight)):
                self.txt(x, y+i*leading, line, size, color, weight)

    def field(self, gid, x, y, w, label, value, h=38, editable=True):
        with self.group(gid):
            self.txt(x, y, label, 12, C['MUT'], 500)
            self.rect(x, y+10, w, h, '#0b0b0b', '#383838' if editable else '#262626', 6)
            for i, line in enumerate(self.wrap(value, w-24, 14)):
                self.txt(x+12, y+34+i*21, line, 14)
        if editable:
            self.action(gid, [x, y+10, w, h], label, kind='fixture-edit',
                        effect='Local editable design field; parent must supply prototype input behavior.', value=value)

    def rule(self, x, y, w):
        self.rect(x, y, w, 1, C['BORDER'])

    def finish(self, composition):
        self.meta['composition'] = composition
        path = OUT / (self.sid+'.svg')
        saved = self.save(path)
        self.meta.update({'svg': str(path), 'svgSha256': saved['sha256'], 'png': str(OUT/(self.sid+'.png'))})
        SCENES.append(self.meta)


def page_head(cv, subtitle='All planned', count='5 items'):
    with cv.group('work-context'):
        cv.txt(340, 132, 'Factory · Workstation', 14, weight=600)
        cv.txt(340, 153, subtitle, 12, C['MUT'])
        cv.txt(cv.width-20, 153, count, 12, C['MUT'], anchor='end')


LOCAL_ROWS = [
    ('L-039', 'Compare incremental indexing', 'Local', 'Backlog', '—', 'Ilan', 'Not started'),
    ('L-040', 'Review filesystem watcher limits', 'Local', 'Ready', '—', 'Mara', 'Not started'),
    ('L-042', 'Document cancellation behavior', 'Local', 'Ready', '—', 'Ilan', 'Not started'),
    ('L-043', 'Refresh the project checklist', 'Local', 'Done', '—', 'Mara', 'Not started'),
]
NEW_LOCAL = ('L-041', 'Clarify API error responses', 'Local', 'Ready', '—', 'Mara', 'Not started')
MIXED_ROWS = [
    ('L-039', 'Compare incremental indexing', 'Local', 'Backlog', '—', 'Ilan', 'Not started'),
    ('L-041', 'Clarify API error responses', 'Linear · ENG-244', 'Ready', 'Backlog', 'Mara', 'Not started'),
    ('ENG-237', 'Keep the search index responsive in large repositories', 'Linear · ENG-237', 'Ready', 'In Review', 'Mara', 'Not started'),
    ('L-042', 'Document cancellation behavior', 'Local', 'Ready', '—', 'Ilan', 'Not started'),
    ('ENG-231', 'Report cache warm-up progress', 'Linear · ENG-231', 'In progress', 'In Progress', 'Ilan', 'Not started'),
    ('L-043', 'Refresh the project checklist', 'Local', 'Done', '—', 'Mara', 'Not started'),
]


def toolbar(cv, create=True, compact=False):
    cv.btn('view-table', 340, 176, 70, 'Table', kind='selected-view', effect='This bounded specimen uses Table.')
    cv.btn('filter', 418, 176, 100, 'Filter · All', kind='prototype-scope', effect='Filter menu deferred; no filter mutation represented.')
    cv.btn('display', 526, 176, 108, 'Display', kind='prototype-scope', effect='Personal view: Table; stage order; named columns visible. Other layouts deferred.')
    if create:
        cv.btn('create-local', cv.width-180, 176, 160, '+ Create local work', 'R7-02', True,
               effect='Open local draft; no source connection required.')


def table(cv, rows, selected=None, narrow=False, x=340, y=236, width=None):
    width = width or cv.width-x-20
    if narrow:
        cols = [('Work item', 12), ('Planning stage', width-300), ('Source status', width-154)]
    else:
        cols = [('Work item', 12), ('Source', 430), ('Planning stage', 640),
                ('Source status', 790), ('Human owner', 940), ('Execution', 1090)]
    with cv.group('work-table-column-headers'):
        cv.rect(x, y, width, 38, '#151515', C['BORDER'], 6)
        for label, dx in cols:
            cv.txt(x+dx, y+25, label, 12, C['MUT'], 600)
    for i, row in enumerate(rows):
        key, title, source, stage, status, owner, execution = row
        yy = y+38+i*76
        gid = 'row-'+key.lower()
        with cv.group(gid):
            cv.rect(x, yy, width, 76, '#121c30' if key == selected else '#080808',
                    '#34578e' if key == selected else C['BORDER'], 6)
            if narrow:
                max_title = width-330
                cv.lines(gid+'-title', x+12, yy+24, title, max_title, 14, weight=500, leading=19)
                cv.txt(x+12, yy+63, key+' · '+source, 12, C['MUT'])
                cv.txt(x+width-300, yy+29, stage, 13)
                cv.txt(x+width-154, yy+29, status, 13, C['MUT'])
            else:
                cv.lines(gid+'-title', x+12, yy+24, title, 402, 14, weight=500, leading=19)
                cv.txt(x+12, yy+63, key, 12, C['MUT'])
                for value, dx, tint in [(source,430,C['FG']), (stage,640,C['FG']), (status,790,C['MUT']),
                                        (owner,940,C['FG']), (execution,1090,C['MUT'])]:
                    cv.txt(x+dx, yy+30, value, 13, tint)
        if key == 'ENG-237':
            cv.action(gid, [x, yy, width, 76], 'Inspect ENG-237', 'R7-05', effect='Open linked inspector with the same record and local planning stage.')
    cv.txt(x, y+38+len(rows)*76+29, str(len(rows))+' items · ordered by Planning stage', 12, C['MUT'])


def standalone():
    cv = Canvas('R7-01', 'Standalone Work', 'Standalone is a complete local planning surface. Create and edit work without adding a connection. T3 chrome and conversation sidebar reuse Round-05 primitives.')
    page_head(cv, 'All planned · local work', '4 items')
    toolbar(cv)
    table(cv, LOCAL_ROWS)
    cv.lines('work-footer', 340, 647, 'Plan work here. Choose a workflow when you are ready to run it.', 780, 13, C['MUT'])
    # Standalone navigation remains local, even when the optional views exist in the source set.
    for edge in EDGES:
        if edge['from'] == cv.sid and edge['groupId'] == 'nav-work':
            edge['to'] = cv.sid
    for region in REGIONS:
        if region['screen'] == cv.sid and region['groupId'] == 'nav-work':
            region['target'] = cv.sid
    cv.finish('work-collection')


def create():
    cv = Canvas('R7-02', 'Create local work', 'Local draft specimen. Create saves a local plan item L-041 in Ready. The connection model is absent from the form; Cancel returns to the unchanged standalone list.')
    page_head(cv, 'New local work', 'Local draft')
    cv.btn('cancel-create-top', 340, 176, 96, '← Work', 'R7-01')
    with cv.group('local-create-form'):
        cv.txt(480, 256, 'Create local work', 22, weight=600)
        cv.txt(480, 284, 'Factory · Workstation', 13, C['MUT'])
        cv.field('local-title', 480, 330, 820, 'Title', 'Clarify API error responses')
        cv.field('local-description', 480, 421, 820, 'Description',
                 'Explain the failure and next step when an API request is rejected.', 114)
        cv.field('local-owner', 480, 598, 392, 'Human owner', 'Mara')
        cv.field('local-stage', 900, 598, 400, 'Planning stage', 'Ready')
        cv.btn('cancel-create', 994, 700, 100, 'Cancel', 'R7-01')
        cv.btn('save-create-local', 1106, 700, 194, 'Create local work', 'R7-03', True,
               kind='fixture-transition', effect='Fictional local creation: plan-local-041, display L-041; no thread or invocation created.')
    cv.finish('local-editor')


def local_inspector():
    cv = Canvas('R7-03', 'Local inspector and edit', 'L-041 / plan-local-041 is the created local identity. Local edits change local fields only. Link existing issue opens a separate review; its chosen existing issue is ENG-244.')
    page_head(cv, 'All planned · L-041 selected', '5 items')
    toolbar(cv, False)
    table(cv, [LOCAL_ROWS[0],NEW_LOCAL]+LOCAL_ROWS[1:], 'L-041', True, width=700)
    with cv.group('local-inspector'):
        cv.rect(1060, 176, 520, 700, '#0b0b0b', C['BORDER'], 12)
        cv.txt(1080, 208, 'Local · L-041', 12, C['MUT'], 500)
        cv.btn('close-local-inspector', 1484, 190, 76, 'Close', kind='close-inspector',
               effect='Parent closes/reflows the current collection with all five local items retained. The four-item pre-creation frame is not a valid destination.')
        cv.field('edit-local-title', 1080, 255, 480, 'Title', 'Clarify API error responses')
        cv.field('edit-local-description', 1080, 346, 480, 'Description',
                 'Explain the failure and next step when an API request is rejected.', 106)
        cv.field('edit-local-owner', 1080, 500, 222, 'Human owner', 'Mara')
        cv.field('edit-local-stage', 1320, 500, 240, 'Planning stage', 'Ready')
        cv.txt(1080, 596, 'Execution', 12, C['MUT'])
        cv.txt(1080, 621, 'Not started', 14)
        cv.txt(1080, 648, 'No agent assigned · no thread', 12, C['MUT'])
        cv.btn('save-local-edits', 1080, 681, 174, 'Save local changes', 'R7-03', True,
               kind='fixture-transition', effect='Local-only save acknowledgement is outside this static frame; parent must wire fixture editing.')
        cv.rule(1080, 738, 480)
        cv.btn('review-existing-link', 1080, 759, 202, 'Link existing issue…', 'R7-10',
               effect='Review an existing remote issue; no export or remote issue creation.')
        cv.txt(1080, 821, 'Local history stays with L-041.', 12, C['MUT'])
        cv.txt(1080, 849, 'Created by Mara · today, 10:12', 12, C['DIM'])
    for region in REGIONS:
        if region['screen'] == cv.sid and region['groupId'] == 'nav-work':
            region.update(target=None, kind='close-inspector', effect='Return to current five-item local collection without dropping the created item.')
    EDGES[:] = [e for e in EDGES if not (e['from'] == cv.sid and e['groupId'] == 'nav-work')]
    cv.finish('local-editor')


def mixed():
    cv = Canvas('R7-04', 'Mixed Work with explicit Source', 'Same Work composition, now with optional Linear sources. L-041 survives linking to existing ENG-244. Source, exact source status, local Planning stage and Execution remain distinct.')
    page_head(cv, 'All planned', '6 items')
    toolbar(cv)
    with cv.group('external-scope'):
        cv.txt(340, 223, 'Source: All', 12, C['MUT'])
        cv.txt(526, 223, 'Linear scope: Acme / Engineering / All projects', 12, C['MUT'])
    table(cv, MIXED_ROWS, y=244)
    cv.lines('display-summary', 340, 793, 'Personal display · Table · Planning stage order · Source and source status visible', 1000, 12, C['MUT'])
    cv.lines('retained-local-identity', 340, 830, 'L-041 linked to existing ENG-244 · local item and history retained', 1000, 12, C['BLUE_TEXT'])
    cv.finish('work-collection')


def linked(sid='R7-05', width=1600):
    cv = Canvas(sid, 'Linked issue inspector'+(' · 1280' if width == 1280 else ''),
                'Read-only default. Exact Linear In Review is preserved beside local Ready. Human owner, agent, environment, execution, acceptance and delivery are separate. Saved run inputs would remain pinned.', width)
    page_head(cv, 'All planned · ENG-237 selected', '6 items')
    cv.btn('back-to-work', 340, 176, 130, '← Back to Work', 'R7-04')
    panel_x = 1016 if width == 1600 else 744
    left_w = panel_x-360
    cv.txt(340, 256, 'ENG-237', 13, C['BLUE_TEXT'], 600)
    cv.lines('linked-title', 340, 294, 'Keep the search index responsive in large repositories', left_w, 23, weight=600, leading=30)
    cv.txt(340, 389, 'Description · from Linear', 12, C['MUT'], 500)
    cv.lines('linked-description', 340, 420,
             'Keep typing responsive while the repository index refreshes. Preserve cancellation and report progress for large workspaces.', left_w, 14, leading=23)
    cv.rule(340, 540, left_w)
    cv.txt(340, 573, 'Source history', 14, weight=600)
    cv.lines('history-current', 340, 607, '10:12 · Linear status changed to In Review by Mara.', left_w, 13, C['MUT'])
    cv.lines('history-local', 340, 664, '09:48 · Added to the local plan in Ready. No execution recorded.', left_w, 13, C['MUT'])
    cv.lines('history-pins', 340, 741, 'Run inputs and evidence appear here after a workflow is prepared.', left_w, 13, C['DIM'])
    with cv.group('linked-inspector'):
        cv.rect(panel_x, 176, width-panel_x-20, 700, '#0b0b0b', C['BORDER'], 12)
        x, w = panel_x+20, width-panel_x-60
        cv.txt(x, 209, 'Linear · ENG-237', 13, weight=600)
        cv.btn('open-in-linear', width-166, 190, 126, 'Open in Linear', kind='external-handoff', effect='Needs the real issue URL; fixture does not open an external site.')
        cv.txt(x, 250, 'Acme / Engineering · checked today, 10:12', 12, C['MUT'])
        cv.rule(x, 269, w)
        for yy, label, value in [(302, 'Linear status', 'In Review'), (354, 'Human owner', 'Mara'),
                                  (406, 'Priority', 'High')]:
            cv.txt(x, yy, label, 12, C['MUT'])
            cv.txt(x+170, yy, value, 14)
        cv.txt(x, 447, 'Issue properties are read-only.', 12, C['MUT'])
        cv.btn('connection-scope', x, 465, 190, 'Connection permissions', 'R7-07')
        cv.rule(x, 518, w)
        cv.txt(x, 550, 'Planning stage · local', 12, C['MUT'])
        cv.btn('edit-planning-stage', x+230, 529, w-230, 'Ready', kind='fixture-edit', effect='Local Planning stage only; Linear In Review is untouched.')
        for yy, label, value in [(598, 'Agent', 'Unassigned'), (634, 'Execution environment', 'Workstation'),
                                  (670, 'Execution', 'Not started'), (706, 'Acceptance', 'Not reviewed'),
                                  (742, 'Delivery', 'Held')]:
            cv.txt(x, yy, label, 12, C['MUT'])
            cv.txt(x+230, yy, value, 14)
        cv.rule(x, 769, w)
        cv.txt(x, 801, 'Plan item · plan-linear-237', 12, C['DIM'])
        cv.txt(x, 830, 'No invocation · no candidate · no thread', 12, C['DIM'])
        cv.txt(x, 856, 'Delivery authority has not been established.', 12, C['MUT'])
    cv.finish('linked-reader-inspector')


def intake():
    cv = Canvas('R7-06', 'Intake and external triage', 'External arrival is not plan admission. Add to plan creates local Ready membership only; tracker triage hands off to Linear. Notification read state and local defer are separate.', section='Intake')
    page_head(cv, 'Intake · Linear / Engineering', '1 new arrival')
    cv.txt(340, 204, 'New arrivals', 18, weight=600)
    with cv.group('intake-arrival'):
        cv.rect(340, 236, 448, 126, '#121c30', '#34578e', 8)
        cv.txt(356, 262, 'Linear · ENG-251', 13, C['BLUE_TEXT'], 600)
        cv.lines('arrival-title', 356, 293, 'Show progress while indexing', 410, 16, weight=500)
        cv.txt(356, 338, 'Triage · Mara · arrived today, 10:10', 12, C['MUT'])
    with cv.group('intake-reader'):
        cv.rect(812, 176, 768, 700, '#0b0b0b', C['BORDER'], 12)
        cv.txt(836, 211, 'Linear · ENG-251', 13, C['BLUE_TEXT'], 600)
        cv.txt(836, 256, 'Show progress while indexing', 23, weight=600)
        cv.txt(836, 298, 'Linear status', 12, C['MUT'])
        cv.txt(1016, 298, 'Triage', 14)
        cv.txt(836, 333, 'Human owner', 12, C['MUT'])
        cv.txt(1016, 333, 'Mara', 14)
        cv.lines('intake-description', 836, 388, 'Show useful progress during the first index of a large repository.', 690, 14)
        cv.rule(836, 447, 720)
        cv.txt(836, 483, 'Local planning', 14, weight=600)
        cv.txt(836, 518, 'Not in plan', 13, C['MUT'])
        cv.btn('add-arrival-to-plan', 836, 544, 162, 'Add to plan', kind='fixture-local-admission', effect='Creates local plan membership in Ready; does not modify Triage or start work. Destination state not authored.')
        cv.btn('defer-arrival', 1010, 544, 194, 'Defer this revision', kind='fixture-local-defer', effect='Local defer only; remote Triage is unchanged. Undo/restore deferred beyond this bounded slice.')
        cv.rule(836, 615, 720)
        cv.txt(836, 651, 'Linear triage', 14, weight=600)
        cv.txt(836, 683, 'Review tracker acceptance, duplicate or decline in Linear.', 13, C['MUT'])
        cv.btn('open-triage-in-linear', 836, 707, 202, 'Open in Linear', kind='external-handoff', effect='Needs actual ENG-251 URL; no remote tracker mutation in this prototype.')
        cv.rule(836, 775, 720)
        cv.btn('mark-notification-read', 836, 800, 214, 'Mark notification read', kind='fixture-notification', effect='Read state only; admission and remote status remain unchanged.')
    cv.finish('intake-reader')


def connections():
    cv = Canvas('R7-07', 'Optional connection and write preview', 'Saved mode is read-only. Source-status writes are an explicit, disabled-by-default option with a field preview. Concurrency prevention is not guaranteed; this draft grants no dispatch or remote-creation authority.', section='More')
    cv.btn('connections-back', 340, 118, 130, '← Back to Work', 'R7-04')
    cv.txt(340, 202, 'Connections', 23, weight=600)
    cv.txt(340, 235, 'Linear · optional', 14, C['MUT'])
    with cv.group('connection-scope-form'):
        cv.rect(340, 267, 560, 590, '#0b0b0b', C['BORDER'], 10)
        cv.txt(360, 303, 'Connection scope', 16, weight=600)
        cv.field('connection-workspace', 360, 345, 520, 'Workspace / Team', 'Acme / Engineering', editable=False)
        cv.field('connection-project-filter', 360, 435, 520, 'Linear project filter · optional', 'All projects', editable=False)
        cv.field('connection-owner', 360, 525, 520, 'Owning T3 environment', 'Workstation', editable=False)
        cv.txt(360, 628, 'Saved mode', 12, C['MUT'])
        cv.txt(550, 628, 'Read-only', 14)
        cv.txt(360, 670, 'Polling · last checked today, 10:12', 13, C['MUT'])
        cv.txt(360, 710, 'Plan membership stays local.', 13, C['MUT'])
        cv.txt(360, 750, 'Title, description, owner and priority are inbound.', 13, C['MUT'])
        cv.btn('disconnect-connection', 360, 793, 146, 'Disconnect…', kind='review-required', effect='Parent must supply disconnect review; saved local details/history remain. This does not manufacture an uncertain prior write.')
    with cv.group('connection-write-preview'):
        cv.rect(924, 267, 656, 590, '#0b0b0b', C['BORDER'], 10)
        cv.txt(944, 303, 'Source status writes', 16, weight=600)
        cv.btn('opt-in-status-writes', 944, 328, 292, 'Allow status updates · Off', kind='fixture-opt-in', effect='Explicit opt-in required; parent must wire review and persisted setting. Does not enable dispatch.')
        cv.txt(944, 400, 'Preview · only the Linear status field can change', 14, weight=500)
        for yy, a, b in [(439,'Workspace / Team','Acme / Engineering'), (478,'Existing issues','ENG-237 · pilot scope'),
                          (517,'Current exact status','In Review'), (556,'Proposed destination','Ready to Merge')]:
            cv.txt(944, yy, a, 12, C['MUT'])
            cv.txt(1180, yy, b, 14)
        cv.lines('write-concurrency-limit', 944, 599, 'Other writers may change the issue during submission. Atomic conflict prevention is unavailable.', 610, 13, C['WARN'])
        cv.lines('mirror-route', 944, 661, 'Existing GitHub mirror: writes stay held until its status route and automation effects are reviewed.', 610, 13, C['MUT'])
        cv.txt(944, 725, 'Backlink sharing · Off', 13, C['MUT'])
        cv.txt(944, 754, 'Agent dispatch · unchanged', 13, C['MUT'])
        cv.btn('save-status-write-option', 944, 793, 240, 'Enable status updates', disabled=True,
               effect='Blocked while opt-in and mirrored-issue review are incomplete.')
    with cv.group('spec-fixture-conflict'):
        cv.rect(1040, 977, 190, 28, '#161e2e', '#34445f', 6)
        cv.txt(1052, 996, 'Fixture: status conflict', 12, '#b9c6df', 500)
    cv.action('spec-fixture-conflict', [1040,977,190,28], 'Fixture: status conflict', 'R7-08',
              'spec-fixture', 'Independent opted-in scenario, outside product. Does not enable writes or submit a request.', scope='specification')
    with cv.group('spec-fixture-disconnected'):
        cv.rect(1242, 977, 260, 28, '#161e2e', '#34445f', 6)
        cv.txt(1254, 996, 'Fixture: disconnected / uncertain', 12, '#b9c6df', 500)
    cv.action('spec-fixture-disconnected', [1242,977,260,28], 'Fixture: disconnected / uncertain', 'R7-09',
              'spec-fixture', 'Independent prior-timeout scenario, outside product. Does not disconnect or retry a write.', scope='specification')
    cv.finish('connections')


def recovery_base(sid, title, note):
    cv = Canvas(sid, title, note)
    page_head(cv, 'All planned · ENG-237 selected', '6 items')
    cv.btn('recovery-back', 340, 176, 130, '← Back to Work', 'R7-04')
    cv.txt(340, 263, 'Linear · ENG-237', 13, C['BLUE_TEXT'], 600)
    cv.lines('recovery-title', 340, 303, 'Keep the search index responsive in large repositories', 450, 22, weight=600, leading=29)
    cv.txt(340, 408, 'Local Planning stage', 12, C['MUT'])
    cv.btn('recovery-local-stage', 340, 428, 208, 'Ready', kind='fixture-edit', effect='Local planning remains available; no outbound status change.')
    cv.txt(340, 509, 'Saved details', 14, weight=600)
    cv.lines('recovery-description', 340, 546, 'Keep typing responsive while the repository index refreshes. Preserve cancellation and report progress.', 440, 14)
    cv.txt(340, 668, 'Local history', 14, weight=600)
    cv.lines('recovery-history', 340, 705, '09:48 · Mara added this issue to the plan in Ready.', 440, 13, C['MUT'])
    cv.lines('recovery-execution', 340, 775, 'Execution: Not started\nAcceptance: Not reviewed · Delivery: Held', 440, 13, C['MUT'])
    return cv


def conflict():
    cv = recovery_base('R7-08', 'Source status conflict', 'Proposed opted-in status-edit fixture, independent of the default connection frame. Baseline/current/requested are preserved; re-review is explicit. No CAS or lossless concurrent-write claim.')
    with cv.group('source-status-conflict'):
        cv.rect(824, 236, 756, 623, '#0b0b0b', C['BORDER'], 12)
        cv.txt(848, 278, 'Linear status changed', 22, weight=600)
        cv.lines('conflict-explanation', 848, 314, 'Review the latest status before submitting your request again.', 684, 14, C['MUT'])
        for yy, label, value, detail in [
            (377, 'Baseline · when you edited', 'In Progress', 'Snapshot checked at 10:12'),
            (479, 'Current · from Linear', 'In Review', 'Changed by Mara · checked at 10:14'),
            (581, 'Requested · your draft', 'Ready to Merge', 'Engineering workflow destination')]:
            cv.txt(848, yy, label, 12, C['MUT'])
            cv.txt(848, yy+33, value, 18, weight=500)
            cv.txt(1126, yy+33, detail, 12, C['MUT'])
            cv.rule(848, yy+60, 708)
        cv.lines('conflict-guard', 848, 696, 'Your draft is retained. Another remote edit can still occur during submission.', 684, 13, C['WARN'])
        cv.btn('use-linear-status', 848, 770, 146, 'Use Linear', 'R7-05', effect='Fictional resolution accepts current In Review locally and discards this status draft; no outbound write.')
        cv.btn('review-status-again', 1006, 770, 260, 'Review and submit again', kind='review-required',
               effect='Parent must add a review/picker and re-read before an explicit new submission; does not automatically replay the request.')
        cv.txt(848, 836, 'Planning stage remains Ready.', 12, C['MUT'])
    cv.finish('source-status-recovery')


def disconnected():
    cv = recovery_base('R7-09', 'Disconnected with uncertain write', 'Saved snapshot remains readable; disconnected does not mean deleted or access revoked. Request outcome stays uncertain. Reconnect/check may reconcile but cannot prove who caused a matching value or safely auto-retry.')
    with cv.group('disconnected-recovery'):
        cv.rect(824, 236, 756, 623, '#0b0b0b', C['BORDER'], 12)
        cv.txt(848, 278, 'Linear disconnected', 22, weight=600)
        cv.txt(848, 315, 'Saved snapshot · last checked today, 10:12', 13, C['MUT'])
        cv.rule(848, 340, 708)
        cv.txt(848, 378, 'Last saved Linear status', 12, C['MUT'])
        cv.txt(1130, 378, 'In Progress', 15)
        cv.txt(848, 424, 'Human owner · saved', 12, C['MUT'])
        cv.txt(1130, 424, 'Mara', 15)
        cv.rect(848, 460, 708, 175, '#201b12', '#4d3e27', 8)
        cv.txt(868, 495, 'Status request outcome unknown', 16, C['WARN'], 600)
        cv.txt(868, 530, 'Requested: Ready to Merge · sent at 10:13', 13)
        cv.lines('uncertain-recovery-copy', 868, 565, 'The request timed out. It may still complete. The request will not be sent again automatically.', 662, 13, C['MUT'])
        cv.lines('recovery-next-step', 848, 678, 'Reconnect, then check Linear before deciding what to do. Local planning, saved details and history remain available.', 684, 14)
        cv.btn('reconnect-review', 848, 770, 156, 'Reconnect…', 'R7-07', effect='Open optional connection review; does not replay uncertain mutations.')
        cv.btn('check-linear-state', 1016, 770, 170, 'Check Linear', disabled=True, effect='Unavailable while disconnected. Reconciliation would not resubmit the timed-out request.')
        cv.txt(848, 836, 'No confirmed deletion or permission-loss signal.', 12, C['DIM'])
    cv.finish('source-status-recovery')


def link_existing():
    cv = Canvas('R7-10', 'Link a local item to an existing issue', 'Chosen existing-issue review fixture; no remote issue creation/export. Confirm attaches the source association to plan-local-041 and returns to mixed Work with display L-041 still present. Search is illustrative, not connected.')
    page_head(cv, 'Local · L-041', 'Link review')
    cv.btn('cancel-link-top', 340, 176, 166, '← Local work item', 'R7-03')
    with cv.group('existing-issue-link-review'):
        cv.txt(480, 265, 'Link existing Linear issue', 23, weight=600)
        cv.txt(480, 305, 'Local work · L-041 · Clarify API error responses', 14)
        cv.field('existing-issue-search', 480, 356, 820, 'Find an existing issue · Acme / Engineering', 'ENG-244')
        cv.rect(480, 435, 820, 120, '#121c30', '#34578e', 8)
        cv.txt(500, 466, 'ENG-244 · Clarify API error responses', 16, weight=600)
        cv.txt(500, 502, 'Linear status: Backlog · Human owner: Mara', 13, C['MUT'])
        cv.txt(500, 534, 'Acme / Engineering', 12, C['MUT'])
        cv.lines('link-local-history', 480, 605, 'Keep L-041, local planning and history. Read issue properties from this existing source.', 806, 14)
        cv.lines('link-remote-unchanged', 480, 663, 'The Linear issue stays in Backlog. Your local Planning stage stays Ready.', 806, 13, C['MUT'])
        cv.btn('cancel-link', 966, 740, 100, 'Cancel', 'R7-03')
        cv.btn('confirm-existing-link', 1078, 740, 222, 'Link existing issue', 'R7-04', True, kind='fixture-transition',
               effect='Associate existing workspace+issue UUID with unchanged plan-local-041; preserve local title, notes, planning/history. No remote creation, export, status write or dispatch.')
    cv.finish('local-editor')


def geometry():
    issues, summaries = [], []
    ns = {'s': K.NS}
    for scene in SCENES:
        root = ET.parse(scene['svg']).getroot()
        groups = [e.get('id') for e in root.findall('.//s:g', ns)]
        if len(groups) != len(set(groups)):
            issues.append({'screen': scene['id'], 'kind': 'duplicate-group-id'})
        boxes = []
        for n, el in enumerate(root.findall('.//s:text', ns)):
            text = el.text or ''
            size, weight = int(el.get('font-size')), int(el.get('font-weight'))
            x, y = float(el.get('x')), float(el.get('y'))
            ink = K.font(size, weight).getbbox(text, anchor='ls')
            tw = K.text_width(text, size, weight)
            if el.get('text-anchor') == 'end':
                x -= tw
            elif el.get('text-anchor') == 'middle':
                x -= tw/2
            box = [round(x+ink[0],2), round(y+ink[1],2), round(x+ink[2],2), round(y+ink[3],2)]
            record = {'screen': scene['id'], 'text': text, 'font': 'Inter', 'size': size,
                      'weight': weight, 'inkBox': box}
            TEXTS.append(record)
            if box[0] < 0 or box[1] < 0 or box[2] > scene['width'] or box[3] > 1040:
                issues.append({'screen': scene['id'], 'kind': 'text-outside-frame', 'text': text, 'box': box})
            if y < 900 and box[3] > 900:
                issues.append({'screen': scene['id'], 'kind': 'text-crosses-product-caption', 'text': text})
            boxes.append((text, box))
        for i, (a, ba) in enumerate(boxes):
            for b, bb in boxes[i+1:]:
                if min(ba[2],bb[2])-max(ba[0],bb[0]) > 1 and min(ba[3],bb[3])-max(ba[1],bb[1]) > 1:
                    issues.append({'screen': scene['id'], 'kind': 'text-ink-overlap', 'a': a, 'b': b})
        for r in [r for r in REGIONS if r['screen'] == scene['id']]:
            x,y,w,h = r['box']
            bound = 1040 if r.get('scope') == 'specification' else 900
            if r['groupId'] not in groups or x < 0 or y < 0 or x+w > scene['width'] or y+h > bound:
                issues.append({'screen': scene['id'], 'kind': 'invalid-control-region', 'groupId': r['groupId']})
        if root.findall('.//s:image',ns):
            issues.append({'screen': scene['id'], 'kind': 'raster-image-in-source'})
        summaries.append({'screen':scene['id'], 'nativeTextNodes':len(boxes), 'groups':len(groups),
                          'controlRegions':sum(r['screen']==scene['id'] for r in REGIONS)})
    for edge in EDGES:
        if edge['to'] not in [s['id'] for s in SCENES]:
            issues.append({'kind':'missing-edge-destination', 'edge':edge['id']})
    write_json(HERE/'text-measurements.json', TEXTS)
    result = {'status':'PASS' if not issues else 'NEEDS_CORRECTION', 'method':'Inter PIL ink bounds, text pair intersections, frame/product bounds, unique group IDs, native-text/raster and control/target existence',
              'limits':'Static geometry only. Does not establish accessibility, native Figma tree, runtime resizing, semantic input or real navigation.',
              'scenes':summaries, 'issues':issues}
    write_json(HERE/'geometry-checks.json',result)
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    standalone(); create(); local_inspector(); mixed(); linked(); intake(); connections(); conflict(); disconnected(); link_existing(); linked('R7-11',1280)
    checked = geometry()
    write_json(HERE/'action-regions.json', {'schema':'t3factory-design-action-regions/1','coordinates':'Absolute SVG product coordinates. Parent must wire; all behavior is fictional.', 'regions':REGIONS})
    write_json(HERE/'edges.json', {'schema':'t3factory-design-edges/1','status':'PROPOSED_UNWIRED','edges':EDGES,
        'journeys':[['R7-01','R7-02','R7-03','R7-10','R7-04','R7-05','R7-04'],['R7-04','R7-06','R7-04'],['R7-04','R7-07','R7-09','R7-07'],['R7-07','R7-08','R7-05','R7-04']],
        'parentRequirements':['Supply real fixture issue URLs before external wiring.','Retain selected record and query when returning; static targets alone do not implement context.','Implement local input/save state separately; SVG fields are editable design text.','Conflict re-review, Intake action outcomes, opt-in persisted state, and other layouts are deliberately not depicted as successful destination states.','No automatic uncertain-write retry; no dispatcher, provider, remote-create or CAS edge exists.']})
    inputs = [RESEARCH/'round-06-linear'/'decision.md',RESEARCH/'round-06-linear'/'mapping.json',RESEARCH/'round-06-linear'/'figma-follow-up.md',RESEARCH/'round-05'/'refinement-01'/'final-desktop-design.md',PRIMITIVES/'native_svg.py',PRIMITIVES/'build_workspace.py',RESEARCH/'round-05'/'spec'/'base.json',RESEARCH/'round-05'/'refinement-01'/'table-list-idle-native'/'R1-F5-C03.png']
    manifest = {'schema':'t3factory-optional-linear-scenes/1','status':'EDITABLE_SOURCE_ONLY','appHeight':900,
        'scenes':SCENES,'inputs':[{'path':str(p),'sha256':digest(p)} for p in inputs],
        'identityFixture':{'local':{'planItemRef':{'environmentId':'env-ws','projectId':'project-factory','id':'plan-local-041'},'displayId':'L-041','retainedAfterLink':True,'linkedExistingIssue':{'workspaceId':'00000000-0000-4000-8000-000000000001','issueId':'00000000-0000-4000-8000-000000000244','identifier':'ENG-244'}},'otherLinked':{'planItemId':'plan-linear-237','workspaceId':'00000000-0000-4000-8000-000000000001','issueId':'00000000-0000-4000-8000-000000000237','identifier':'ENG-237','exactStatus':'In Review','teamStateId':'00000000-0000-4000-8000-000000000103'},'allIds':'Fictional, namespace-qualified; display keys never serve as stable IDs.'},
        'fonts':{'family':'Inter','nativeText':True,'weights':[400,500,600,700],'assets':[{'path':str(K.FONTS/name),'sha256':digest(K.FONTS/name)} for name in K.WEIGHTS.values()]},
        'geometryStatus':checked['status'],'renderer':'Unmodified round-05/build/native_svg.py render(); local headless PNG export only.','inspectedPngs':[]}
    write_json(HERE/'scene-manifest.json',manifest)
    print(json.dumps({'scenes':len(SCENES),'edges':len(EDGES),'geometry':checked['status'],'issues':checked['issues']},ensure_ascii=False,indent=2))
    if checked['issues']:
        return
    for s in SCENES:
        K.render(s['svg'],s['png'])
        s['pngSha256']=digest(s['png'])
        print('Rendered '+s['id'],flush=True)
    write_json(HERE/'scene-manifest.json',manifest)


if __name__ == '__main__':
    main()
