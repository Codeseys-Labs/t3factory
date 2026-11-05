"""Council C02/C03/C08 and the external-CI portion of C07, for static scenes.

Call after layout refinement and before final link numbering/reachability. All
changes are in memory; caller snapshots and existing return links stay intact.
"""

from copy import deepcopy


def _regions(scene):
    return {region['id']: region for region in scene['regions']}


def _line(text, y=26, x=16, size=14, weight=400, color='FG', wrap=None):
    line = {'t': text, 'x': x, 'y': y, 's': size, 'w': weight, 'c': color}
    if wrap is not None:
        line.update(wrap=wrap, lh=20)
    return line


def _panel(key, box, lines, style='panel', kind='card'):
    return {'id': key, 'kind': kind, 'box': box,
            'props': {'style': style, 'lines': lines}}


def _link(region, target, effect='navigation'):
    region['props']['link'] = {'to': target, 'type': 'navigate', 'effect': effect}


def _button(key, label, box, target=None, effect='navigation', variant='secondary'):
    result = {'id': key, 'kind': 'button', 'box': box,
              'props': {'label': label, 'size': 14, 'variant': variant}}
    if target is not None:
        _link(result, target, effect)
    return result


def _clone(scene, key):
    result = deepcopy(scene)
    result['id'] = key
    result.pop('studyLinks', None)
    result['shell']['navTargets'] = {}
    result['staticControls'] = []
    return result


def _catalog_selection(scenes, base):
    pin_fields = ('workflowId', 'workflowVersion', 'workflowSourceCommit', 'workflowDigest')
    for definition in list(scenes.values()):
        fields = _regions(definition)
        state = definition['state']
        if ('version-readiness' not in fields or 'choose-planned-item' in fields
                or state.get('catalogOrigin')
                or state.get('workflowId') != 'wf-review-change'
                or state.get('lookupOrigin', '').startswith('F5-T')):
            continue
        context = state.get('collectionContext')
        if definition['id'] == 'F5-W04':
            context = scenes['F5-C01']['state']
        if (not context or context.get('selection') or context.get('invocationRef')
                or context.get('nativeExecution') != 'none'):
            continue
        key = definition['id'] + '-CHOOSE-ITEM'
        chosen = key + '-SELECTED'
        picker = _clone(definition, key)
        picker['title'] = 'Choose planned item · Review change v1'
        picker['shell']['breadcrumb'] = 'Review change / Choose planned item'
        picker['state'] = deepcopy(state)
        picker['state'].update(collectionContext=deepcopy(context), catalogOrigin=definition['id'],
                               selection=None, invocationRef=None, dispatch='not-submitted')
        pin = {name: state[name] for name in pin_fields}
        records = context.get('records', [])
        valid = next((record for record in records
                      if record['planItemRef'] == base['fixtures']['planItem']
                      and record.get('sourceRef') == scenes['F5-C02']['state']['sourceRef']
                      and record.get('executionLabel') == 'Not started'), None)
        picker['regions'] = [
            _panel('page-title', [360, 118, 1200, 58], [
                _line('Choose planned item', 24, 0, 20, 600),
                _line('Review change v1 stays pinned · selection starts nothing', 50, 0, 12, color='MUT')], 'none', 'text'),
            deepcopy(fields['version-pin']),
            _panel('selection-scope', [360, 356, 1200, 76], [
                _line('env-ws / project-factory · ' + context.get('view', 'Board') + ' caller retained', weight=500),
                _line('Required: sourceRef, planItemRef, candidateCommit. Missing or mismatched inputs keep dispatch unavailable.', 56, size=13, color='MUT')]),
            _button('cancel-selection', 'Back to pinned definition', [360, 818, 260, 32], definition['id'], 'return'),
        ]
        if valid:
            picker['regions'].append(_panel('qualified-item', [360, 452, 1200, 148], [
                _line('Keep the search index responsive in large repositories', 30, size=16, weight=600),
                _line('plan-237 · env-ws / project-factory · Planning stage ' + valid['planningStage'], 66),
                _line('github / acme/factory / #237 / revision 3 · Source Open · Execution Not started', 98, size=13),
                _line('Candidate: ' + base['fixtures']['candidateCommit'], 128, size=13),
            ]))
            picker['regions'].append(_button('select-plan-237', 'Use plan-237', [1300, 618, 260, 32], chosen, variant='primary'))
            selected = _clone(definition, chosen)
            selected['regions'] = [region for region in selected['regions'] if region['id'] in {
                'page-title', 'version-pin', 'definition', 'version-readiness',
                'input-contract', 'review-factory', 'review-ci',
            }]
            selected['state'].update(selection=deepcopy(valid['planItemRef']), sourceRef=deepcopy(valid['sourceRef']),
                                     candidateCommit=base['fixtures']['candidateCommit'],
                                     catalogOrigin=definition['id'], collectionContext=deepcopy(context))
            selected['caption'] = 'Explicit plan-237 selection for the same pinned Review change definition. Source, planning and execution are unchanged; target review alone creates no invocation.'
            selected_fields = _regions(selected)
            selected['regions'].append(_button('back-to-definition', 'Back to pinned definition', [360, 818, 260, 32], definition['id'], 'return'))
            selected_fields['input-contract']['props']['lines'] = [
                _line('Selected inputs · ready for target review', 28, weight=500),
                _line('github / acme/factory / #237 / rev3 · env-ws / project-factory / plan-237', 60, size=13),
                _line('Candidate ' + base['fixtures']['candidateCommit'], 86, size=12, color='MUT'),
            ]
            selected['regions'].append(_button('change-planned-item', 'Change planned item', [750, 818, 226, 32], key, 'return'))
            for target, template, control in (('Factory', 'F5-W05', 'review-factory'), ('CI', 'F5-W06', 'review-ci')):
                review_id = chosen + '-' + target.upper()
                view_origin = {'Board': 'F5-C02', 'Table': 'F5-C03', 'List': 'F5-C04'}[context['view']]
                template = template + '-CAT-' + view_origin
                review = _clone(scenes[template], review_id)
                review['state'].update(deepcopy(pin))
                review['state'].update(selection=deepcopy(valid['planItemRef']), source=deepcopy(scenes['F5-C02']['state']['sourceRef']),
                                       bindingSnapshot=deepcopy(state['bindingSnapshot']), collectionContext=deepcopy(context),
                                       catalogOrigin=definition['id'], returnOrigin=chosen)
                _link(_regions(review)['cancel-run'], chosen, 'return')
                _link(_regions(review)['change-target'], chosen + ('-CI' if target == 'Factory' else '-FACTORY'))
                scenes[review_id] = review
                selected_fields[control]['props']['variant'] = 'primary' if target == 'Factory' else 'secondary'
                _link(selected_fields[control], review_id)
            scenes[chosen] = selected
        else:
            picker['regions'].append(_panel('missing-qualified-inputs', [360, 452, 1200, 148], [
                _line('No qualified Review change input set selected', 30, size=16, weight=600),
                _line('No qualified source / plan / candidate set is available in this caller snapshot.', 68),
                _line('Held before dispatch: no matching sourceRef / planItemRef / candidateCommit set. No invocation.', 106, color='WARN'),
            ], 'warning'))
            origin = state.get('lookupOrigin')
            if origin in scenes:
                picker['regions'].append(_button('inspect-caller-work', 'Inspect planned items in Work', [360, 618, 310, 32], origin, 'return'))
        picker['caption'] = 'Catalog-first explicit item selection. The caller query, source history and binding snapshot survive cancellation. Only the named fully qualified example is linked; other selections are static. Diagnose CI failure retains its separate four-input contract.'
        scenes[key] = picker
        definition['regions'].append(_button('choose-planned-item', 'Choose planned item', [750, 818, 226, 32], key, variant='primary'))
        definition['caption'] = definition['caption'].replace('Select a work item to run.', 'Choose planned item to review Factory or CI inputs.')


def _binding_hierarchy(scenes):
    affected = []
    for scene in scenes.values():
        state, fields = scene['state'], _regions(scene)
        if 'bindingId' not in state or not {'preview', 'mapping', 'owner', 'filters', 'version'} <= fields.keys():
            continue
        if 'future-delivery-policy' in fields:
            affected.append(scene['id'])
            continue
        title = fields['title']['props']['lines']
        title[1]['t'] = state['bindingId'] + ' · ' + state['bindingState']
        owner_tail = fields['owner']['props']['lines'][-1]['t']
        fields['owner']['box'] = [360, 184, 1200, 68]
        invocation = state.get('invocationRef')
        fields['owner']['props']['lines'] = [
            _line('Activation: ' + state['bindingState'], 25, weight=600),
            _line('Owner: ' + state['dispatchOwner'], 25, x=600, size=13),
            _line('Invocation: ' + (str(invocation) if invocation else 'none'), 51, size=13),
            _line('Target: ' + state['target'], 51, x=600, size=13),
        ]
        fields['filters']['box'] = [360, 260, 1200, 80]
        lines = fields['filters']['props']['lines']
        for line, y in zip(lines, (18, 42, 68)):
            line.update(y=y, wrap=1168, lh=20)
        lines[-1]['t'] += ' · ' + owner_tail
        fields['version']['box'] = [360, 348, 1200, 96]
        for line, y in zip(fields['version']['props']['lines'], (24, 52, 80)):
            line['y'] = y
        fields['mapping']['box'] = [360, 452, 1200, 160]
        fields['preview']['box'] = [360, 620, 1200, 100]
        sample = fields['preview']['props']['lines'][:4]
        sample[0]['t'] = 'Sample validation · valid example · no event sent · no invocation'
        for line, y in zip(sample, (22, 44, 66, 88)):
            line['y'] = y
        fields['preview']['props']['lines'] = sample
        policy = [
            _line('Future invalid-delivery policy · no failed delivery is represented here', 17, size=12, weight=600),
            _line('Missing / unresolved / mismatched input → Held; offending input named; no invocation; valid activation state retained.', 37, size=13, color='MUT'),
        ]
        if state.get('signaturePolicy'):
            policy.append(_line('Invalid signature → rejected before mapping; no invocation.', 55, size=12, color='MUT'))
        scene['regions'].append(_panel('future-delivery-policy', [360, 728, 1200, 60], policy))
        affected.append(scene['id'])
    return affected


def _ci_monitor(scenes):
    affected = []
    for scene in list(scenes.values()):
        fields = _regions(scene)
        if ('ci-queued' not in fields or 'monitor-external-ci' in fields
                or scene['state'].get('readOnlyExternalMonitor')):
            continue
        key = scene['id'] + '-EXTERNAL-MONITOR'
        monitor = _clone(scene, key)
        monitor['title'] = 'External CI run monitor · ' + scene['state']['externalCIRun']
        monitor['shell']['breadcrumb'] = 'CI / External run monitor'
        monitor['state'].update(monitorOrigin=scene['id'], readOnlyExternalMonitor=True,
                                externalDestination='https://github.com/acme/factory/actions/runs/' + scene['state']['externalCIRun'])
        monitor['regions'] = [
            _panel('page-title', [360, 118, 1200, 58], [
                _line('External CI run monitor', 24, 0, 20, 600),
                _line('GitHub Actions owns this run · no native T3 thread', 50, 0, 12, color='MUT')], 'none', 'text'),
            deepcopy(fields['ci-queued']), deepcopy(fields['ci-version-pin']),
            deepcopy(fields['ci-run-inputs']), deepcopy(fields['ci-owner-context']),
            _panel('external-host-destination', [360, 700, 1200, 86], [
                _line('Host destination · https://github.com/acme/factory/actions/runs/' + scene['state']['externalCIRun'], 28, size=14, weight=500),
                _line('Retained queued observation. Worker start and fresh host status are not observed in this static design.', 60, size=13, color='MUT')]),
            _button('return-to-ci-receipt', 'Back to CI receipt', [360, 818, 220, 32], scene['id'], 'return'),
        ]
        monitor['caption'] = 'Static external-host monitoring destination with exact run, candidate, invocation and caller snapshot. No live host fetch, worker start or completion is implied. Back restores the same CI receipt; existing Run history remains on that receipt.'
        scenes[key] = monitor
        scene['regions'].append(_button('monitor-external-ci', 'Monitor external CI run', [1280, 818, 280, 32], key, 'history-read', 'primary'))
        affected.append(scene['id'])
    return affected


def _local_recovery(scenes, base):
    scene = scenes['F5-W12']
    if 'review-saved-changes' in _regions(scene):
        return
    files = ['.t3/workflows/project.yaml', '.t3/workflows/review-change.yaml', '.github/workflows/t3-review.yml']
    scene['state']['savedFiles'] = files
    fields = _regions(scene)
    fields['local-pin']['box'] = [360, 626, 1200, 154]
    fields['local-pin']['props']['lines'] = [
        _line('Exactly 3 saved local files · Review change v1', 24, size=14, weight=500),
        *[_line(path, 48 + index * 22, size=13) for index, path in enumerate(files)],
        _line('SHA-256 ' + next(w['digest'] for w in base['workflowCatalog'] if w['id'] == 'wf-review-change'), 116, size=13),
        _line('AGENTS.md and t3.json hooks unchanged · commit / push / host observation not observed', 142, size=12, color='MUT'),
    ]
    fields['later-observed']['props']['label'] = 'Study: later shared-ready record'
    fields['later-observed']['box'] = [1200, 818, 360, 32]
    scene['regions'] += [
        _button('review-saved-changes', 'Review saved changes in Git', [584, 818, 300, 32], 'F5-W12-GIT-REVIEW', 'history-read'),
        _button('check-readiness', 'Check readiness', [902, 818, 240, 32], 'F5-W12-READINESS', 'history-read'),
    ]
    scene['caption'] = 'Local save only. Review the exact saved files through the existing Git changes/review surface, return, and inspect readiness. Commit and push remain deliberate native Git actions. The shared-ready link is a separate study continuation, never a refresh result.'
    scene['staticControls'] = ['Native commit and push require deliberate Git actions and are static in this bounded design. No save/check action activates a binding or starts work.']
    git = _clone(scenes['F5-W02'], 'F5-W12-GIT-REVIEW')
    git['title'] = 'Git · saved workflow changes'
    git['shell']['breadcrumb'] = 'Git / Saved workflow changes'
    git['state'] = deepcopy(scene['state'])
    git['state'].update(returnOrigin='F5-W12', existingSurface='Native Git changes/review', localSaveReview=True)
    git_fields = _regions(git)
    git['regions'] = [git_fields[key] for key in ('page-title', 'file-list', 'config-diff', 'init-review')]
    git_fields['page-title']['props']['lines'] = [
        _line('Git · review saved changes', 24, 0, 20, 600),
        _line('Existing Git review surface · 3 saved local files · commit and push not observed', 50, 0, 12, color='MUT')]
    git_fields['init-review']['props']['lines'] = [
        _line('Review before committing', 28, size=16, weight=600),
        _line('Inspect the three saved paths and retained content excerpts. AGENTS.md and t3.json hooks are unchanged.', 60, size=13),
        _line('No commit, push, binding activation, provider run or CI dispatch occurs through this inspection.', 88, size=12, color='MUT')]
    git['regions'] += [
        _button('back-to-local-save', 'Back to local save', [360, 818, 240, 32], 'F5-W12', 'return'),
        _button('commit-deliberately', 'Commit…', [1140, 818, 190, 32], variant='disabled'),
        _button('push-deliberately', 'Push…', [1350, 818, 210, 32], variant='disabled'),
    ]
    git_fields = _regions(git)
    _regions(git)['back-to-local-save']['props']['link'].update(
        type='back', allowedOrigins=['F5-W12', 'F5-W12-READINESS', 'F5-W12-READINESS-MISMATCH'])
    git['caption'] = 'Bounded design of the existing native Git review destination, reusing the exact W02 three-file review, now after Save. No native Git view is operated or validated here. Commit/push are explicit, prototype-static controls; Back restores W12.'
    scenes[git['id']] = git
    file_targets = [git['id'], git['id'] + '-DEFINITION', git['id'] + '-CI-ENTRY']
    git_fields['back-to-local-save']['props']['label'] = 'Back to caller'
    git_fields['back-to-local-save']['props']['link']['allowedOrigins'] += file_targets
    original_diff = deepcopy(git_fields['config-diff']['props']['lines'])
    project_lines = [line for line in original_diff if line['y'] < 200]
    ci_lines = [line for line in original_diff if line['y'] >= 200]
    for line in ci_lines:
        line['y'] -= 200
    definition_lines = deepcopy(_regions(scenes['F5-W04'])['definition']['props']['lines'])
    for index, (target, lines) in enumerate(zip(file_targets, (project_lines, definition_lines, ci_lines))):
        focused = git if index == 0 else _clone(git, target)
        focused['state'].update(selectedSavedFile=files[index])
        focused_fields = _regions(focused)
        focused_fields['config-diff']['props']['lines'] = lines
        focused_fields['file-list']['props']['lines'] = [
            line for line in focused_fields['file-list']['props']['lines']
            if not line['t'].startswith('+ ')]
        focused['regions'] = [region for region in focused['regions'] if not region['id'].startswith('saved-file-')]
        for file_index, path in enumerate(files):
            control = _button('saved-file-' + str(file_index), path, [376, 254 + file_index * 54, 308, 36],
                              file_targets[file_index] if file_index != index else None,
                              'history-read', 'primary' if file_index == index else 'secondary')
            control['props']['size'] = 12
            focused['regions'].append(control)
        focused['caption'] = 'Existing native Git review destination study, reusing W02 file review and W04 pinned definition excerpt. Select each exact saved path; excerpts are not executable full-file bytes. Commit/push remain deliberate, prototype-static controls. Back preserves the caller.'
        scenes[target] = focused
    for mismatch in (False, True):
        key = 'F5-W12-READINESS' + ('-MISMATCH' if mismatch else '')
        check = _clone(scene, key)
        check['title'] = 'Readiness inspection · CI Held'
        reason = ('Host definition digest does not match prepared Review change v1; expected digest remains pinned.' if mismatch
                  else 'No matching host definition/adapter observation. Commit and push remain unobserved.')
        check['state'].update(returnOrigin='F5-W12', readiness='Held', readinessInspection={
            'observedAt': '2026-11-04T09:20:00-08:00', 'fixtureOnly': True,
            'hostEvidence': 'mismatched' if mismatch else 'missing', 'reason': reason,
            'expectedWorkflowDigest': next(w['digest'] for w in base['workflowCatalog'] if w['id'] == 'wf-review-change'),
            'observedWorkflowDigest': ('0' * 64) if mismatch else None,
        })
        check['regions'] = [deepcopy(fields['page-title']), deepcopy(fields['readiness']), deepcopy(fields['local-pin'])]
        _regions(check)['page-title']['props']['lines'][0]['t'] = 'Readiness inspection · CI Held'
        check['regions'] += [
            _panel('observation-time-reason', [1120, 294, 440, 308], [
                _line('Read-only observation', 30, size=16, weight=600),
                _line('Study fixture · 2026-11-04 09:20 −08:00', 70, size=13),
                _line('Host evidence: ' + ('mismatched' if mismatch else 'missing'), 108, weight=500, color='WARN'),
                _line(reason, 148, size=14, wrap=404),
                _line('Check creates no invocation and changes no saved bytes or binding.', 244, size=13, color='MUT', wrap=404),
            ], 'warning'),
            _button('back-to-local-save', 'Back to local save', [360, 818, 240, 32], 'F5-W12', 'return'),
            _button('inspect-saved-files', 'Review saved changes in Git', [620, 818, 300, 32], git['id'], 'history-read'),
            _button('ci-held', 'Run in CI · Held', [1320, 818, 240, 32], variant='disabled'),
        ]
        if mismatch:
            _regions(check)['readiness']['props']['lines'][-2]['t'] = 'Mismatched'
            _regions(check)['readiness']['props']['lines'][-1]['t'] = 'CI Held · host digest mismatch · no invocation or external run'
        else:
            check['studyLinks'] = [_button('mismatch-study', 'Study: mismatched host evidence', [1230, 950, 346, 32], 'F5-W12-READINESS-MISMATCH', 'history-read')]
        check['caption'] = 'Explicit readiness check at a labelled illustrative observation time, with a held reason. This is a static missing/mismatched evidence fixture, not a live refresh or a failed delivery. No action leads from this check to shared-ready or dispatch.'
        scenes[key] = check


def integrate(scenes, base):
    """Mutate fully assembled scenes in place; return bounded correction metadata."""
    before = deepcopy(scenes)
    _catalog_selection(scenes, base)
    bindings = _binding_hierarchy(scenes)
    monitors = _ci_monitor(scenes)
    _local_recovery(scenes, base)
    return {
        'corrections': ['C02', 'C03', 'C07-workflows', 'C08'],
        'affectedSceneIds': sorted(key for key in before if before[key] != scenes[key]),
        'addedSceneIds': sorted(set(scenes) - set(before)),
        'bindingDetailIds': bindings, 'ciReceiptIds': monitors,
    }
