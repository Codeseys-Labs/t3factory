"""Council C12/C13/C14 corrections for evidence and operations records.

Pure in-memory integration for a dict of fully assembled scenes; no IO. The parent
calls integrate(scenes, base) in workspace_graph.assemble after _refine_layouts(scenes)
and before _finalize(scenes) and _export_reachable(scenes), so every operations
reader clone and the shared delivery records already exist. Each correction is
idempotent and is applied across the relevant context clones while preserving their
exact bindings, return edges and identity-qualified state.
"""

from copy import deepcopy

# C13: absent optional tooling is neutral; unknown required policy stays attention.
OPTIONAL_TOOL_REGIONS = ('ops-mise', 'ops-hooks', 'ops-scanner')
HOST_REGION = 'ops-host'
OLD_HOST_FACTS = 'Repo configuration is not host activation or current review coverage.'
NEW_HOST_FACTS = ('Repository configuration, required-check policy and observed host '
                  'coverage are separate facts.')

# C12: explicit full-record provenance panel for the CI candidate record.
RECORD_SOURCE = 'F5-D-REVIEW'
RECORD_PINS_ID = 'F5-D-RECORD-PINS'
SOURCE_ENTRY_ID = 'record-pins-entry'
COPY_LABELS = ('Copy candidate', 'Copy base', 'Copy digest', 'Copy study SHA', 'Copy commit')

# C14: concise owner/ack/fence summaries, only where the fixture qualifies them.
SUMMARY_REGION = 'ops-owner-ack-fence'


def _line(text, y, size=14, weight=400, color='FG', x=16, mono=False):
    value = {'t': str(text), 'x': x, 'y': y, 's': size, 'w': weight, 'c': color}
    if mono:
        value['mono'] = True
    return value


def _region(identifier, kind, box, props):
    return {'id': identifier, 'kind': kind, 'box': list(box), 'props': props}


def _panel(identifier, box, lines, style='panel', kind='card'):
    return _region(identifier, kind, box, {'style': style, 'lines': lines})


def _button(identifier, label, box, target=None, effect='navigation',
            variant='secondary', size=14, edge=None, origins=None):
    props = {'label': label, 'size': size, 'variant': variant}
    if target is not None:
        props['link'] = {'to': target, 'type': 'navigate', 'effect': effect}
        if edge:
            props['link']['edge'] = edge
        if origins is not None:
            props['link']['type'] = 'back'
            props['link']['allowedOrigins'] = list(origins)
    return _region(identifier, 'button', box, props)


def _toolchain_clones(scenes):
    return sorted(
        scene_id for scene_id in scenes
        if scene_id == 'F5-O-00' or scene_id.startswith('F5-O-00-FROM-'))


def _optional_tooling_neutral(scenes):
    """C13: an absent optional tool is not a blocker; unknown policy requiredness is."""
    recolored = []
    for scene_id in _toolchain_clones(scenes):
        for region in scenes[scene_id]['regions']:
            if region['id'] not in OPTIONAL_TOOL_REGIONS:
                continue
            for line in region.get('props', {}).get('lines', []):
                if line.get('t') == 'Not configured' and line.get('c') == 'WARN':
                    line['c'] = 'MUT'
                    recolored.append(scene_id + '/' + region['id'])
    return recolored


def _host_fact_separation(scenes):
    """C13: name configuration, requiredness and observed host coverage as separate facts."""
    separated = []
    for scene_id in _toolchain_clones(scenes):
        for region in scenes[scene_id]['regions']:
            if region['id'] != HOST_REGION:
                continue
            for line in region.get('props', {}).get('lines', []):
                if line.get('t') == OLD_HOST_FACTS:
                    line['t'] = NEW_HOST_FACTS
                    separated.append(scene_id)
                    break
    return sorted(set(separated))


def _owner_ack_fence(scenes):
    """C14: concise owner/ack/fence facts; unknown is not none, pause is not permission."""
    added = {}
    o10 = scenes.get('F5-O-10')
    if o10 is not None and not any(r['id'] == SUMMARY_REGION for r in o10['regions']):
        o10['regions'].append(_panel(SUMMARY_REGION, [360, 766, 1000, 116], [
            _line('Writer ownership, acknowledgement and fence', 28, 14, 600),
            _line('env-mac / th-f5-ops-remote-01 / run-f5-ops-remote-01 / writer epoch12 '
                  'retains ownership.', 62, 13),
            _line('Stop acknowledgement and fence are not observed in this record. '
                  'Unknown is not stopped.', 94, 12, color='MUT'),
        ]))
        added['F5-O-10'] = SUMMARY_REGION
    o23 = scenes.get('F5-O-23')
    if o23 is not None and not any(r['id'] == SUMMARY_REGION for r in o23['regions']):
        o23['regions'].append(_panel(SUMMARY_REGION, [360, 686, 1200, 110], [
            _line('Writer ownership, acknowledgement and fence', 28, 14, 600),
            _line('env-mac / th-f5-ops-remote-01 / run-f5-ops-remote-01 / writer epoch12 '
                  'retains ownership; acknowledgement and fence not observed.', 62, 13),
            _line('Pause is not cancellation, a stop acknowledgement or fencing permission.',
                  94, 12, color='MUT'),
        ]))
        added['F5-O-23'] = SUMMARY_REGION
    return added


def _pin_pairs(source):
    pins = next((r for r in source['regions'] if r['id'] == 'delivery-pins'), None)
    if pins is None:
        return None, None
    pairs = []
    for line in pins['props']['lines']:
        label, separator, value = str(line['t']).partition('  ')
        if separator and value:
            # C12: the record itself renders its pin values in readable monospace.
            line['mono'] = True
            pairs.append((label, value))
    return pins, pairs


def _record_pins_panel(scenes):
    """C12: full values stay inspectable in a dedicated panel with per-value copy."""
    source = scenes.get(RECORD_SOURCE)
    if source is None:
        return {'pairs': [], 'created': False, 'entryLinked': False}
    _, pairs = _pin_pairs(source)
    created = False
    if RECORD_PINS_ID not in scenes and pairs:
        scene = deepcopy(source)
        scene['id'] = RECORD_PINS_ID
        scene['title'] = 'Review & evidence · Full record pins'
        scene['tag'] = source['tag']
        scene['caption'] = (
            'Read-only full record pins for this CI candidate. Monospace values support exact '
            'inspection and extraction by hand; per-value Copy is a visible static affordance, '
            'not a clipboard action. Back restores the caller; nothing accepts or delivers.')
        state = deepcopy(source['state'])
        state.pop('rows', None)
        state.update(provenancePanel=True,
                     recordPinsSource=RECORD_SOURCE,
                     copyAffordance='visible static affordance; no clipboard action executes',
                     pinValues=[{'label': label, 'value': value} for label, value in pairs])
        scene['state'] = state
        heading = deepcopy(next(r for r in source['regions'] if r['id'] == 'delivery-heading'))
        heading['props']['lines'][0]['t'] = scene['title']
        pin_lines = [_line('Record pins · full values · monospace', 28, 14, 600)]
        copies = []
        y = 58
        for (label, value), copy_label in zip(pairs, COPY_LABELS):
            pin_lines.append(_line(label + '  ' + value, y, 12, mono=True))
            copies.append(_button('record-copy-' + copy_label.removeprefix('Copy ').replace(' ', '-').lower(),
                                  copy_label, [1412, 262 + y - 12, 132, 24], size=12))
            y += 24
        regions = [
            heading,
            _region('delivery-task-state', 'text', [360, 182, 1200, 64],
                    {'style': 'none', 'lines': [
                        _line('Human task: review finding-one and finding-two dispositions '
                              'for issue237 plan-237.', 24, 13, 500),
                        _line('State: CI completed · readiness Held · candidate not accepted · '
                              'delivery not granted.', 50, 12, color='MUT')]}),
            _panel('delivery-record-pins', [360, 262, 1200, 264], pin_lines, style='code'),
        ]
        regions.extend(copies)
        regions.append(_panel('delivery-copy-note', [360, 542, 1200, 84], [
            _line('Copy is a visible affordance, not an executed action', 30, 14, 600),
            _line('No clipboard operation runs in this static design. Inspect and transcribe the '
                  'exact value above, or export it from the source record.', 62, 12, color='MUT'),
        ], style='neutral', kind='notice'))
        regions.append(_button('delivery-native-back', 'Back', [360, 818, 84, 32],
                               target=RECORD_SOURCE, effect='return',
                               edge='F5-EE-record-pins-back', origins=[RECORD_SOURCE]))
        scene['regions'] = regions
        scene['staticControls'] = [
            'Per-value Copy controls are visible affordances only; no clipboard action is '
            'connected in this static prototype.',
            'Read-only fictional records. No real provider, host, Git, acceptance, delivery, '
            'issue or release mutation.']
        scenes[RECORD_PINS_ID] = scene
        created = True
    entry_linked = False
    if not any(r['id'] == SOURCE_ENTRY_ID for r in source['regions']):
        source['regions'].append(_button(
            SOURCE_ENTRY_ID, 'Full record pins & copy', [780, 818, 320, 32],
            target=RECORD_PINS_ID, effect='history-read', edge='F5-EE-review-record-pins'))
        entry_linked = True
    return {'pairs': pairs, 'created': created, 'entryLinked': entry_linked}


def integrate(scenes, base):
    """Mutate fully assembled scenes in place; return bounded correction metadata."""
    before = {scene_id: deepcopy(scene) for scene_id, scene in scenes.items()}
    recolored = _optional_tooling_neutral(scenes)
    separated = _host_fact_separation(scenes)
    summaries = _owner_ack_fence(scenes)
    pins = _record_pins_panel(scenes)
    return {
        'corrections': ['C12', 'C13', 'C14'],
        'affectedSceneIds': sorted(
            scene_id for scene_id in before
            if before[scene_id] != scenes.get(scene_id)),
        'addedSceneIds': sorted(set(scenes) - set(before)),
        'recoloredOptionalTooling': recolored,
        'hostFactSeparation': separated,
        'ownerAckFenceSummaries': summaries,
        'recordPinsPanel': pins,
    }