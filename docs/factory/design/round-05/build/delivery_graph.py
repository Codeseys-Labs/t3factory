"""Bounded native delivery/evidence records. Pure in-memory integration only.

Load delivery.json scenes before integrate, after configuration/catalog assembly.
The parent owns renderer, navigation glue and final graph verification.
"""
import json
from copy import deepcopy


BASE_SHA = '4f5d220000000000000000000000000000000000'
HEAD_SHA = '2eac71d000000000000000000000000000000000'
TREE_SHA = '3ead82e000000000000000000000000000000000'
MERGE_SHA = '4fac93f000000000000000000000000000000000'
MOVED_BASE_SHA = '5abd040000000000000000000000000000000000'
# Synthetic record identifiers only, not calculated hashes of real evidence bytes.
DIGESTS = {name: prefix + '0' * 60 for name, prefix in (
    ('policy', 'aa11'), ('local', 'aa22'), ('config', 'aa33'),
    ('locks', 'aa44'), ('diff', 'aa55'), ('review', 'aa66'),
    ('payload', 'aa77'), ('seal', 'aa88'))}


def _line(text, y, size=14, weight=400, color='FG', x=16, wrap=1168):
    return {'t': text, 'x': x, 'y': y, 's': size, 'w': weight,
            'c': color, 'wrap': wrap, 'lh': 18 if size == 12 else 19}


def _box(identifier, kind, box, lines, style='row'):
    return {'id': identifier, 'kind': kind, 'box': box,
            'props': {'style': style, 'lines': lines}}


def _link(scene_id, control_id, target, effect='history-read'):
    return {'edge': 'F5-DE-' + scene_id + '-' + control_id,
            'to': target, 'type': 'navigate', 'effect': effect}


def _button(scene, identifier, label, x, width, target=None, y=818,
            variant='secondary'):
    props = {'label': label, 'size': 14, 'variant': variant}
    if target is not None:
        props['link'] = _link(scene['id'], identifier, target)
    scene['regions'].append({'id': identifier, 'kind': 'button',
                             'box': [x, y, width, 32], 'props': props})


def _back(scene, origins):
    if not origins:
        return
    _button(scene, 'delivery-native-back', 'Back', 360, 84, origins[0])
    link = scene['regions'][-1]['props']['link']
    link.update({'type': 'back', 'effect': 'return',
                 'allowedOrigins': sorted(set(origins))})
    scene['state']['nativeBack'] = True
    scene['state']['allowedOrigins'] = sorted(set(origins))
    scene['state']['coldLoadReturn'] = 'Omit Back when no native history exists'


def _context(base, head='original', factory=False):
    fixtures = base['fixtures']
    return {
        'fixture': True, 'observedRuntime': False,
        'projectId': base['project']['id'],
        'environmentId': base['project']['environmentId'],
        'selection': deepcopy(fixtures['planItem']),
        'sourceRef': {key: fixtures['sourceIssue'][key]
                      for key in ('provider', 'repository', 'number', 'revision')},
        'workflowId': 'wf-review-change', 'workflowVersion': 1,
        'workflowName': 'Review change',
        'workflowDigest': fixtures['versionDigest'],
        'workflowSourceCommit': fixtures['workflowSourceCommit'],
        'candidateCommit': fixtures['candidateCommit'] if head == 'original' else HEAD_SHA,
        'frozenCandidateAtDispatchSha': fixtures['candidateCommit'] if head == 'original' else HEAD_SHA,
        'sourceInvocationRef': fixtures['manualCIInvocation'] if head != 'original' else None,
        'sourceCandidateSha': fixtures['candidateCommit'] if head != 'original' else None,
        'comparisonBaseSha': BASE_SHA,
        'targetBaseSha': BASE_SHA,
        'retainedWorkRef': deepcopy(fixtures['retainedWorkAfterFactoryAdmission']) if factory else None,
        'nativeThreadId': fixtures['nativeThreadAfterFactoryAdmission'] if factory else None,
        'invocationRef': fixtures['manualFactoryInvocation'] if factory else (
            fixtures['manualCIInvocation'] if head == 'original' else 'inv-f5-ci-02'),
        'externalRunId': None if factory else (
            fixtures['externalCIRun'] if head == 'original' else '19542'),
        'recordScope': 'one invocation snapshot, not a global project history',
    }


def _paint(scene, base, factory=False):
    state = scene['state']
    head_kind = state.get('recordHead', 'original')
    context = {} if head_kind == 'automatic' else _context(base, head_kind, factory)
    # Only the newly owned record receives these fields. Caller snapshots never do.
    for key, value in context.items():
        state.setdefault(key, value)
    state.setdefault('readOnly', True)
    state.setdefault('preservesCallerSnapshot', True)
    state.setdefault('recordDigests', deepcopy(DIGESTS))
    head = state['candidateCommit']
    if state['nativeThreadId'] is not None:
        ref = 'Factory / ' + state['invocationRef'] + ' / root' + state['nativeThreadId']
    elif state['externalRunId'] is not None:
        ref = 'CI / ' + state['invocationRef'] + ' / external' + state['externalRunId'] + ' / no native thread'
    else:
        ref = 'Factory / ' + state['invocationRef'] + ' / native association not yet observed'
    source = state['sourceRef']
    subject = (source['repository'] + '#' + str(source['number']) + ' rev' + str(source['revision'])
               + ' · ' + state['environmentId'] + ' / ' + state['projectId'] + ' / ' + state['selection']['id'])
    if scene['id'] == 'F5-D-CHANGED':
        state.update({'invocationRef': None, 'externalRunId': None,
                      'frozenCandidateAtDispatchSha': None})
        ref = 'Changed candidate / no current-head invocation / original inv-f5-ci-01 is history'
    regions = [
        _box('delivery-heading', 'text', [360, 118, 1200, 58], [
            _line(scene['title'], 24, 20, 600, x=0),
            _line(subject + ' · ' + ref, 50, 12, color='MUT', x=0)], 'none'),
        _box('delivery-pins', 'card', [360, 182, 1200, 116], [
            _line(('Starting commit  ' if head_kind == 'automatic' else 'Candidate  ')
                  + (head or 'unavailable in this invocation snapshot'), 22),
            _line('Comparison base / main  ' + (state['comparisonBaseSha'] or 'not resolved in this dispatch snapshot'), 44),
            _line(state['workflowName'] + ' v' + str(state['workflowVersion']) + ' SHA-256  ' + state['workflowDigest'], 66, 12),
            _line('No later candidate evidence loaded' if head_kind == 'automatic'
                  else ('Corrected-head study  ' + HEAD_SHA) if head_kind == 'original'
                  else 'Original run19541 candidate  ' + base['fixtures']['candidateCommit'],
                  88, 12, color='MUT'),
            _line('Workflow source commit  ' + state['workflowSourceCommit'],
                  106, 12, color='MUT')], 'panel')]
    rows = state.get('rows', [])
    y = 310
    count = len(rows)
    heights = [194, 166, 120] if scene['id'] == 'F5-D-PATCH' else [92 if count >= 5 else 112 if count == 4 else 144] * count
    for index, (title, detail, style) in enumerate(rows):
        height = heights[index]
        is_code = style == 'code'
        region = _box('delivery-record-' + str(index + 1), 'code' if is_code else 'row',
                      [360, y, 1200, height], [
                          _line(title, 23, 14, 600, 'WARN' if style == 'warning' else 'FG'),
                          _line(detail, 47, 14, color='MUT')], style)
        regions.append(region)
        y += height + 8
    scene['regions'] = regions
    scene['staticControls'] = [
        'Read-only fictional records. No real provider, host, Git, acceptance, delivery, issue or release mutation.',
        'Native thread/composer and common project shell are parent-owned; CI does not create a T3 thread.'
    ]


def _history(base, identifier, title, rows, factory=False, head='original', context=None):
    scene = {
        'id': identifier, 'title': title,
        'shell': {'mode': 'workspace', 'section': 'Workflows',
                  'breadcrumb': 'Workflows / Review change / run history', 'navTargets': {}},
        'tag': 'Proposed AB:66 · illustrative append-only history',
        'caption': 'Snapshot-scoped read-only history. Entries retain their owner, pins and association. No history read dispatches, completes or grants anything; Back restores the exact incoming snapshot.',
        'state': {'readOnly': True, 'recordHead': head, 'rows': rows},
        'regions': []}
    if context is not None:
        scene['state'].update(context)
    _paint(scene, base, factory)
    if identifier.startswith('F5-D-HISTORY-'):
        scene['regions'][1]['props']['lines'][3]['t'] = (
            'Starting-commit provenance unavailable; do not infer a manual run input.'
            if scene['state'].get('recordHead') == 'automatic' and scene['state']['candidateCommit'] is None
            else 'Frozen invocation input. No later candidate or evidence is loaded in this history snapshot.')
        scene['state'].pop('recordDigests', None)
    return scene


def _receipt_data(base):
    common = {
        'illustrative': True, 'observedRuntime': False,
        'subject': _context(base, 'corrected'),
        'testedTreeSha': TREE_SHA, 'headBefore': HEAD_SHA, 'headAfter': HEAD_SHA,
        'comparisonBaseSha': BASE_SHA, 'liveTargetBaseSha': BASE_SHA,
        'dirty': False, 'untracked': [], 'cache': {'mode': 'disabled', 'source': None, 'key': None},
        'toolchain': {'node': '24.13.1', 'vp': '0.1.11', 'mise': '2026.11.0',
                      'betterleaks': '2.0.0-rc.6',
                      'binarySource': 'fictional project-pinned local installation',
                      'versionSource': 'fictional runner version capture'},
        'configDigest': DIGESTS['config'], 'lockDigest': DIGESTS['locks'],
        'receiptDigest': DIGESTS['local'], 'worktree': '../factory-issue-237-evidence',
        'mergeGroupSha': None, 'exit': 0,
    }
    tests = deepcopy(common)
    tests.update({'id': 'tests-f5-h2', 'argv': ['vp', 'run', 'check:changed'],
                  'startedAt': '2026-11-03T10:40:00Z', 'finishedAt': '2026-11-03T10:44:00Z',
                  'observedAt': '2026-11-03T10:44:05Z',
                  'coverage': 'Applicable search tests, including large-refresh interactive progress',
                  'provenance': 'Proposed Factory-owned direct runner receipt; not agent stdout'})
    build = deepcopy(common)
    build.update({'id': 'build-f5-h2', 'argv': ['vp', 'run', '--filter', '@t3tools/web', 'build'],
                  'startedAt': '2026-11-03T10:44:00Z', 'finishedAt': '2026-11-03T10:48:00Z',
                  'observedAt': '2026-11-03T10:48:05Z',
                  'coverage': 'Applicable web build only, not desktop packaging or release',
                  'provenance': 'Proposed Factory-owned direct runner receipt; not agent stdout'})
    scan = deepcopy(common)
    scan.update({'id': 'scan-f5-h2',
                 'argv': ['betterleaks', 'git', '../factory-issue-237-evidence',
                          '--revision=' + BASE_SHA + '..' + HEAD_SHA,
                          '--config', 'betterleaks.toml', '--output', 'evidence/scan-f5-h2.json'],
                 'startedAt': '2026-11-03T10:48:06Z', 'finishedAt': '2026-11-03T10:49:00Z',
                 'observedAt': '2026-11-03T10:49:05Z',
                 'scanState': 'complete', 'numFindings': 0,
                 'coverage': 'Complete pinned base..correctedHead range; no network validation',
                 'provenance': 'Proposed Factory-owned direct runner receipt; incomplete scan never passes'})
    return {'tests': tests, 'build': build, 'scanner': scan,
            'hosted': {'illustrative': True, 'observedRuntime': False,
                       'invocationRef': 'inv-f5-ci-02', 'externalRunId': '19542', 'attempt': 1,
                       'nativeThreadId': None, 'retainedWorkRef': None,
                       'candidateCommit': HEAD_SHA, 'workflowDigest': base['fixtures']['versionDigest'],
                       'requestedBy': 'Mara', 'requestedAt': '2026-11-03T10:50:00Z',
                       'finishedAt': '2026-11-03T10:58:00Z', 'observedAt': '2026-11-03T11:00:00Z',
                       'provenance': 'Fictional later host-read receipt, not live host observation',
                       'hostPolicy': {'requiredness': 'declared in this later fixture',
                                      'digest': DIGESTS['policy'],
                                      'requiredChecks': ['Test', 'Build', 'Security'],
                                      'requiredConversations': []},
                       'requiredResults': {'Test': 'pass', 'Build': 'pass', 'Security': 'pass'},
                       'coverage': 'Exact corrected candidate/tree and complete three-file scope'},
            'independentReview': {'id': 'ready-f5-h2', 'reviewer': 'Imani', 'implemented': False,
                                  'context': 'fresh private context, no implementer summary',
                                  'headSha': HEAD_SHA, 'diffDigest': DIGESTS['diff'],
                                  'reviewDigest': DIGESTS['review'], 'coverage': '3/3 complete files and both finding criteria',
                                  'verdict': 'Ready for human acceptance only',
                                  'observedRuntime': False},
            'protectedApproval': {'id': 'owner-f5-h2', 'actor': 'Mara', 'headSha': HEAD_SHA,
                                  'diffDigest': DIGESTS['diff'], 'glob': 'harness/**',
                                  'scope': 'Add large-refresh interactive-progress case only',
                                  'recordedAt': '2026-11-03T11:01:00Z'},
            'requiredUnknownRule': 'Any unavailable requiredness, coverage, receipt binding or tool identity holds'}


def _capture_readers(scenes, base, packet):
    readers = []

    def add(identifier, title, rows, capture, origins):
        record = _history(base, identifier, title, rows, head='corrected')
        record['shell']['section'] = 'Work'
        record['tag'] = 'Proposed AB:66 · fictional receipt detail'
        record['caption'] = (
            'Read-only synthetic capture fields, not observed execution or raw evidence. '
            'Back restores the actual incoming reader. Opening this record runs no command or review.')
        record['shell']['breadcrumb'] = 'Review / evidence / ' + title
        record['state']['capture'] = deepcopy(capture)
        record['state']['rawCaptureAvailability'] = 'not included in this design study'
        _back(record, origins)
        _button(record, 'capture-full-pins', 'Full record pins', 706, 190, 'F5-D-PROVENANCE')
        scenes[identifier] = record
        readers.append(identifier)
        return record

    for key, label, x in (('tests', 'Tests', 666), ('build', 'Build', 778), ('scanner', 'Scan', 890)):
        capture = packet[key]
        identifier = 'F5-D-CAPTURE-' + key.upper()
        result = 'Exit ' + str(capture['exit']) + ' · coverage: ' + capture['coverage']
        if key == 'scanner':
            result += ' · scanState=' + capture['scanState'] + ' · numFindings=' + str(capture['numFindings'])
        rows = [
            ['Producer and complete argv', capture['provenance'] + '\nargv: ' + json.dumps(capture['argv']), 'row'],
            ['Worktree and tested tree',
             capture['worktree'] + ' · testedTree=' + capture['testedTreeSha']
             + '\nheadBefore=' + capture['headBefore'] + ' · headAfter=' + capture['headAfter']
             + ' · dirty=' + json.dumps(capture['dirty']) + ' · untracked=' + json.dumps(capture['untracked'])
             + ' · mergeGroupSha=' + json.dumps(capture['mergeGroupSha']), 'row'],
            ['Times, cache and result',
             'Started ' + capture['startedAt'] + ' · finished ' + capture['finishedAt']
             + ' · observed ' + capture['observedAt'] + '\nCache ' + json.dumps(capture['cache'])
             + '\n' + result, 'row'],
            ['Base capture and raw-evidence boundary',
             'Comparison base ' + capture['comparisonBaseSha'] + ' · captured target base ' + capture['liveTargetBaseSha']
             + '\nRaw log bytes are not included in this study. This captured base is not through-write fencing or merge authority.', 'warning'],
        ]
        record = add(identifier, capture['id'] + ' · local evidence', rows, capture, ['F5-D-PACKET'])
        _button(record, 'capture-runner', 'Runner provenance', 464, 230, 'F5-D-CAPTURE-RUNNER')
        _button(scenes['F5-D-PACKET'], 'capture-' + key, label, x, 100, identifier)

    common = packet['tests']
    runner_rows = [
        ['Shared local capture fixture · tool identities',
         json.dumps(common['toolchain']) + '\nThese are declared fictional capture values, not installed-tool attestations.', 'row'],
        ['Full capture/configuration pins',
         'Configuration ' + common['configDigest'] + '\nLocks ' + common['lockDigest']
         + '\nSynthetic local capture pin ' + common['receiptDigest'], 'row'],
        ['Scope of the shared capture',
         'The three local receipts share this authored runner/configuration fixture and the candidate shown above. '
         'Their argv, individual times, outcomes, cache and coverage remain separate records. '
         'The local evidence producer is not the owner of external CI invocation19542.', 'row'],
        ['Raw files and version stdout · unavailable in this study',
         'No raw stdout, logs, configuration or lock-file bytes are included. '
         'Synthetic pins are not calculated hashes of real evidence. A real unknown tool/config identity must hold.', 'warning'],
    ]
    add('F5-D-CAPTURE-RUNNER', 'Runner provenance · local capture fixture', runner_rows,
        {'toolchain': common['toolchain'], 'configDigest': common['configDigest'],
         'lockDigest': common['lockDigest'], 'syntheticCapturePin': common['receiptDigest']},
        ['F5-D-PACKET'] + readers[:])
    _button(scenes['F5-D-PACKET'], 'capture-runner', 'Runner provenance', 1224, 230, 'F5-D-CAPTURE-RUNNER')

    hosted, review, approval = packet['hosted'], packet['independentReview'], packet['protectedApproval']
    hosted_rows = [
        ['Host observation, request and completion',
         hosted['invocationRef'] + ' / external' + hosted['externalRunId'] + ' / attempt' + str(hosted['attempt'])
         + ' · nativeThreadId=null · retainedWorkRef=null.\n' + hosted['provenance'] + ' · scope: ' + hosted['coverage']
         + '\nRequested by ' + hosted['requestedBy'] + ' at ' + hosted['requestedAt']
         + ' · finished ' + hosted['finishedAt'] + ' · observed ' + hosted['observedAt'], 'row'],
        ['Declared host policy and exact-head results',
         json.dumps(hosted['hostPolicy']) + '\nRequired results ' + json.dumps(hosted['requiredResults']), 'row'],
        ['Separate independent review',
         review['id'] + ' · reviewer ' + review['reviewer'] + ' · implemented=' + json.dumps(review['implemented'])
         + ' · context: ' + review['context'] + '\nHead ' + review['headSha'] + ' · diff ' + review['diffDigest']
         + ' · review ' + review['reviewDigest'] + '\nCoverage ' + review['coverage'] + ' · ' + review['verdict'], 'row'],
        ['Separate protected-path approval',
         approval['id'] + ' · actor ' + approval['actor'] + ' · recorded ' + approval['recordedAt']
         + ' · glob ' + approval['glob'] + '\nHead ' + approval['headSha'] + ' · diff ' + approval['diffDigest']
         + '\nScope ' + approval['scope'] + '. Raw host/review capture bytes are not included in this design study.', 'row'],
    ]
    add('F5-D-CAPTURE-HOSTED', 'Host, review and owner records', hosted_rows,
        {'hosted': hosted, 'independentReview': review, 'protectedApproval': approval}, ['F5-D-PACKET'])
    _button(scenes['F5-D-PACKET'], 'capture-hosted', 'Host & review', 1002, 210, 'F5-D-CAPTURE-HOSTED')
    return readers



def integrate(scenes, base) -> None:
    """Derive owned records and retarget bounded contextual entries, without IO."""
    originals = list(scenes.values())
    authored = [scene for scene in originals if scene['id'].startswith('F5-D-')]
    for scene in authored:
        _paint(scene, base)
    scenes['F5-D-PACKET']['state']['receiptPacket'] = _receipt_data(base)

    provenance_rows = [
        ['Local receipt identity', 'Node24.13.1 · vp0.1.11 · fictional project-pinned installation; version output captured by the proposed runner. Config and lock bytes use the synthetic record pins below. Not real tool/file attestation.', 'row'],
        ['Current evidence pins', 'Policy  ' + DIGESTS['policy'] + '\nLocal receipt  ' + DIGESTS['local'] + '\nConfig  ' + DIGESTS['config'], 'row'],
        ['Content pins', 'Locks  ' + DIGESTS['locks'] + '\nDiff  ' + DIGESTS['diff'] + '\nIndependent review  ' + DIGESTS['review'], 'row'],
        ['Conditional delivery pins', 'Payload  ' + DIGESTS['payload'] + '\nServer seal  ' + DIGESTS['seal'] + '\nTested tree  ' + TREE_SHA, 'row']]
    provenance = _history(base, 'F5-D-PROVENANCE', 'Evidence record pins · full values', provenance_rows, head='corrected')
    provenance['shell']['breadcrumb'] = 'Review / evidence / full record pins'
    provenance['shell']['section'] = 'Work'
    scenes[provenance['id']] = provenance

    histories = {
        'empty': ('F5-D-HISTORY-EMPTY', 'Workflow history · no run loaded', [
            ['No invocation at this catalog snapshot', 'No run selected or loaded here. This is not a universal log containing future manual/automatic examples. Choose an existing invocation from its Work, thread or receipt context.', 'row'],
            ['Definitions are not runs', 'A pinned workflow definition is not an invocation. Opening project history starts nothing and changes no binding. No future manual/automatic run or admission is inferred.', 'row']]),
        'factory-accepted': ('F5-D-HISTORY-FACTORY-ACCEPTED', 'Factory history · accepted dispatch', [
            ['09:12 · Mara requested the Factory example', 'inv-f5-factory-01 · Review change v1 · exact original candidate · Factory owner. Plan237 links admitted WorkRef env-ws/issue/8b42f1d3 and native root8b42f1d3.', 'row'],
            ['09:12 · dispatch accepted', 'Provider start has not yet been observed in this snapshot. Acceptance of dispatch is not completion or candidate acceptance. No CI result or Ready verdict is borrowed.', 'row']]),
        'factory-working': ('F5-D-HISTORY-FACTORY-WORKING', 'Factory history · provider working', [
            ['09:12 · accepted dispatch retained', 'inv-f5-factory-01 · Factory · admitted WorkRef env-ws/issue/8b42f1d3 · native root8b42f1d3 · exact original candidate and workflow version.', 'row'],
            ['09:13 · later provider-working observation', 'Codex is working in the existing native thread. Completion and exact output/message association are not yet available. No Ready, acceptance or delivery is implied.', 'row'],
            ['Independent CI example is not this run', 'inv-f5-ci-01/external19541 belongs to the separate manual CI fixture. It has no native thread and cannot answer which Factory message completed.', 'row']]),
        'ci-queued': ('F5-D-HISTORY-CI-QUEUED', 'CI history · queued external run', [
            ['09:14 · Mara requested the CI example', 'inv-f5-ci-01 · Review change v1 · original candidate · execution owner GitHub Actions. Source acme/factory#237 rev3 and plan237 are inputs, not retained native Work.', 'row'],
            ['09:14 · external19541/attempt1 queued', 'Dispatch accepted. No worker finish/report has been observed in this snapshot. NativeThreadId and retainedWorkRef remain null. No findings, Ready or acceptance inferred.', 'row']]),
        'ci-completed': ('F5-D-HISTORY-CI-COMPLETED', 'CI history · append-only review provenance', [
            ['09:14 · accepted / queued', 'inv-f5-ci-01 · external19541/attempt1 · manual by Mara · GitHub Actions owner · exact original candidate and Review change v1 digest.', 'row'],
            ['09:24 · finished; observed09:25 UTC', 'Illustrative external receipt imported review-report.md and two findings. Raw host conclusion is not supplied; even Success would not be a clean verdict. Reviewer model/runtime, complete coverage and requiredness remain unknown.', 'row'],
            ['No deletion or silent replacement', 'Both finding ids remain. Old-head observations, failures and subsequent dispositions append under their exact subject/attempt. Later corrected evidence has a different invocation19542/02, never an edit of run19541.', 'row']]),
        'automatic': ('F5-D-HISTORY-AUTOMATIC', 'Automatic history · issue238 dispatch', [
            ['Separate issue238 event · dispatch accepted', 'inv-f5-auto-01 · Implement issue v1 · Factory owner · source acme/factory#238 revision1 · project plan-238. This event is not the manual issue237 example.', 'row'],
            ['Starting-commit provenance', 'A starting commit must come from this automatic invocation snapshot, not the manual example. Workflow source and definition digest are independent inputs. Missing provenance is unavailable, not a readiness pass.', 'row'],
            ['Admission and provider outcome not yet observed', 'No retained native WorkRef, native thread, CI receipt, provider finish, Ready verdict, candidate acceptance or delivery grant is supplied in this dispatch snapshot.', 'warning']])}
    automatic_workflow = next(workflow for workflow in base['workflowCatalog']
                              if workflow['id'] == 'wf-implement-issue')
    automatic_source = scenes['F5-C13']['state']
    if automatic_source['invocationRef'] != base['fixtures']['automaticInvocation']:
        raise ValueError('Automatic history requires the qualified issue238 invocation snapshot')
    automatic_context = {
        'fixture': True, 'observedRuntime': False, 'recordHead': 'automatic',
        'environmentId': automatic_source['environmentId'], 'projectId': automatic_source['projectId'],
        'selection': deepcopy(automatic_source['selection']),
        'sourceRef': deepcopy(automatic_source['sourceRef']),
        'workflowId': automatic_workflow['id'], 'workflowName': automatic_workflow['name'],
        'workflowVersion': automatic_workflow['version'], 'workflowDigest': automatic_workflow['digest'],
        'workflowSourceCommit': base['fixtures']['workflowSourceCommit'],
        'candidateCommit': automatic_source.get('candidateCommit'),
        'candidateRepository': automatic_source.get('candidateRepository'),
        'candidateProvenance': deepcopy(automatic_source.get('candidateProvenance')),
        'resolvedInputSnapshot': deepcopy(automatic_source.get('resolvedInputSnapshot')),
        'frozenCandidateAtDispatchSha': automatic_source.get('frozenCandidateAtDispatchSha',
                                                            automatic_source.get('candidateCommit')),
        'invocationRef': automatic_source['invocationRef'],
        'nativeThreadId': None, 'retainedWorkRef': None, 'externalRunId': None,
        'comparisonBaseSha': None, 'targetBaseSha': None,
        'sourceInvocationRef': None, 'sourceCandidateSha': None,
        'recordScope': 'one automatic issue238 invocation snapshot',
        'invocationSnapshotSource': 'F5-C13',
    }
    provenance = automatic_context['candidateProvenance']
    if provenance is not None:
        histories['automatic'][2][1] = [
            'Starting-commit resolution record',
            'Repository ' + provenance['repository'] + ' · selector ' + provenance['selector']
            + ' · resolved branch ' + provenance['resolvedBranch']
            + '\nCaptured ' + provenance['resolvedCommit']
            + ' · resolvedBeforeDispatch=' + json.dumps(provenance['resolvedBeforeDispatch'])
            + ' · fixtureOnly=' + json.dumps(provenance['fixtureOnly']), 'row']
    for kind, (identifier, title, rows) in histories.items():
        record = _history(base, identifier, title, rows, kind.startswith('factory'),
                          context=automatic_context if kind == 'automatic' else None)
        record['shell']['breadcrumb'] = (
            'Workflows / Implement issue / run history' if kind == 'automatic'
            else 'Workflows / project run history' if kind == 'empty'
            else record['shell']['breadcrumb'])
        record['state']['historySnapshot'] = kind
        if kind == 'factory-working':
            record['state']['nativeExecution'] = 'provider-working'
        if kind == 'empty':
            for field in ('selection', 'sourceRef', 'invocationRef', 'externalRunId', 'retainedWorkRef',
                          'nativeThreadId', 'candidateCommit', 'frozenCandidateAtDispatchSha',
                          'sourceInvocationRef', 'sourceCandidateSha', 'comparisonBaseSha', 'targetBaseSha',
                          'workflowId', 'workflowName', 'workflowVersion', 'workflowDigest', 'workflowSourceCommit'):
                record['state'][field] = None
            record['state']['historyLoad'] = 'empty-or-not-loaded at this pre-run catalog snapshot'
            record['regions'][0]['props']['lines'][1]['t'] = 'project-factory / env-ws · no invocation selected'
            # A pre-run catalog must not visually display candidate/CI future records.
            record['regions'][1]['props']['lines'] = [
                _line('Project history · no invocation selected or loaded', 30),
                _line('No invocation loaded. No admission, external run or candidate evidence inferred.', 62),
                _line('Back preserves the incoming catalog and binding snapshot.', 92, 12, color='MUT')]
        scenes[identifier] = record
    _button(scenes['F5-D-HISTORY-AUTOMATIC'], 'captured-inputs', 'Captured inputs', 464, 248,
            'F5-T-AUTO-DELIVERY')

    incoming = {identifier: [] for identifier, _, _ in histories.values()}
    review_origins = []
    for scene in originals:
        if scene['id'].startswith('F5-D-'):
            continue
        state = scene.get('state', {})
        context = state.get('collectionContext', state)
        invocation = context.get('invocationRef')
        stage = str(context.get('execution', context.get('nativeExecution', context.get('providerState', '')))).lower()
        if invocation == base['fixtures']['manualFactoryInvocation']:
            kind = 'factory-working' if 'working' in stage else 'factory-accepted'
        elif invocation == base['fixtures']['manualCIInvocation']:
            kind = 'ci-completed' if 'complete' in stage else 'ci-queued'
        elif invocation == base['fixtures']['automaticInvocation']:
            kind = 'automatic'
        else:
            kind = 'empty'
        history_id = histories[kind][0]
        wired_history = False
        for region in scene.get('regions', []) + scene.get('studyLinks', []):
            props = region.get('props', {})
            label = props.get('label', '')
            if 'history' in region.get('id', '').lower() and 'run' in label.lower():
                props['link'] = _link(scene['id'], region['id'], history_id)
                if props.get('variant') == 'disabled':
                    props['variant'] = 'secondary'
                    scene['staticControls'] = [
                        text for text in scene.get('staticControls', [])
                        if not text.startswith(region['id'] + ':')]
                if label == 'Run history study':
                    props['label'] = 'Run history'
                wired_history = True
            if kind == 'ci-completed' and region.get('id') in ('finding-one', 'finding-two', 'review-evidence'):
                target = {'finding-one': 'F5-D-FINDING-ONE', 'finding-two': 'F5-D-FINDING-TWO',
                          'review-evidence': 'F5-D-REVIEW'}[region['id']]
                props['link'] = _link(scene['id'], region['id'], target)
                review_origins.append((target, scene['id']))
        is_catalog = scene['id'].startswith(('F5-W03', 'F5-W04')) and not scene['id'].endswith('BINDINGS')
        if is_catalog and not wired_history:
            _button(scene, 'delivery-run-history', 'Run history', 360, 168, history_id, y=766)
            wired_history = True
        if wired_history:
            incoming[history_id].append(scene['id'])
        if kind == 'ci-completed' and scene['id'].startswith('F5-W10'):
            _button(scene, 'delivery-review-evidence', 'Review & evidence', 556, 202, 'F5-D-REVIEW')
            review_origins.append(('F5-D-REVIEW', scene['id']))
            scene['staticControls'] = [
                text for text in scene.get('staticControls', [])
                if 'finding disposition' not in text.lower()]
            scene['staticControls'].append(
                'Finding/report rows read fictional evidence/disposition records; report download and external host mutations remain static.')
        if (kind == 'ci-completed' and scene['id'].startswith('F5-C')
                and scene.get('shell', {}).get('mode') == 'workspace'):
            _button(scene, 'delivery-review-evidence', 'Review & evidence', 1178, 218,
                    'F5-D-REVIEW', y=740)
            review_origins.append(('F5-D-REVIEW', scene['id']))

    for identifier, origins in incoming.items():
        _back(scenes[identifier], origins)
    # Completed histories remain read-only; only this snapshot opens its two findings.
    complete = scenes['F5-D-HISTORY-CI-COMPLETED']
    _button(complete, 'review-candidate', 'Review & evidence', 464, 202, 'F5-D-REVIEW')
    review_origins.append(('F5-D-REVIEW', complete['id']))

    routes = {
        'F5-D-REVIEW': [('finding-one', 'Finding one', 464, 150, 'F5-D-FINDING-ONE'),
                        ('finding-two', 'Finding two', 626, 150, 'F5-D-FINDING-TWO'),
                        ('changed-study', 'Later changed-head study', 1240, 320, 'F5-D-CHANGED')],
        'F5-D-CHANGED': [('fresh-study', 'Later fresh-evidence record', 1240, 320, 'F5-D-FRESH')],
        'F5-D-FRESH': [('patch', 'Review changed hunks', 360, 228, 'F5-D-PATCH'),
                       ('packet', 'Evidence packet', 600, 184, 'F5-D-PACKET'),
                       ('acceptance-record', 'Later exact-head acceptance', 1216, 344, 'F5-D-ACCEPTED')],
        'F5-D-PACKET': [('record-pins', 'Full record pins', 464, 190, 'F5-D-PROVENANCE')],
        'F5-D-ACCEPTED': [('prepare-result', 'Separate preparation result', 1216, 344, 'F5-D-PREPARE-HELD')],
        'F5-D-PREPARE-HELD': [('future-study', 'Conditional future study', 1240, 320, 'F5-D-FUTURE-PREPARE')],
        'F5-D-FUTURE-PREPARE': [('grant-record', 'Read separate later grant', 1240, 320, 'F5-D-FUTURE-GRANT')],
        'F5-D-FUTURE-GRANT': [('receipt-record', 'Read later conditional receipt', 1216, 344, 'F5-D-FUTURE-RECEIPT')],
    }
    for identifier, actions in routes.items():
        for control_id, label, x, width, target in actions:
            _button(scenes[identifier], control_id, label, x, width, target)
    _back(scenes['F5-D-REVIEW'], [origin for target, origin in review_origins if target == 'F5-D-REVIEW'])
    for identifier in ('F5-D-FINDING-ONE', 'F5-D-FINDING-TWO'):
        origins = ['F5-D-REVIEW'] + [origin for target, origin in review_origins if target == identifier]
        _back(scenes[identifier], origins)
    _back(scenes['F5-D-PATCH'], ['F5-D-FRESH'])
    _back(scenes['F5-D-PACKET'], ['F5-D-FRESH'])
    capture_readers = _capture_readers(scenes, base, scenes['F5-D-PACKET']['state']['receiptPacket'])
    _back(scenes['F5-D-PROVENANCE'], ['F5-D-PACKET'] + capture_readers)
    _button(scenes['F5-D-PREPARE-HELD'], 'grant-unavailable', 'Grant merge unavailable', 360, 270, variant='disabled')
    # Receipt is terminal. No native Back or link to a pregrant/actionable snapshot.
    receipt = scenes['F5-D-FUTURE-RECEIPT']
    receipt['state'].update({'mergeSha': MERGE_SHA, 'laterMovedBaseSha': MOVED_BASE_SHA,
                             'productionSlot': 'retained on conditional confirmed receipt'})
    receipt['regions'][-1]['props']['lines'].append(
        _line('Conditional merge SHA  ' + MERGE_SHA, 82, 12))
