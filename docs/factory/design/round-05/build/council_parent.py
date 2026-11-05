"""Final presentation adjustments after the council's independent helpers."""


def integrate(scenes, base):
    for sid in ('F5-C11-PLANNING', 'F5-C12-PLANNING'):
        scenes[sid]['caption'] = scenes[sid]['caption'].replace('Source stays Open and stage Ready.', 'Source stays Open and stage In progress.')
    for region in scenes['F5-C06']['regions']:
        for line in region.get('props', {}).get('lines', []):
            if line.get('t') == 'Creates a project PlanItemRef in Ready.':
                line['t'] = 'Creates a planned item in Ready.'
    for item in scenes.values():
        labels = [r.get('props', {}).get('label', '') for r in item.get('regions', [])]
        if any(label in ('Move to In progress', 'Move back to Ready') for label in labels):
            item['staticControls'] = [text.replace('Stage edit is demonstrated from Board only.', 'Planning-stage changes are demonstrated through the inspector controls.') for text in item.get('staticControls', [])]
    scene = scenes['F5-W12']
    controls = {r['id']: r for r in scene['regions']}
    if 'review-saved-changes' not in controls:
        return
    controls['review-saved-changes']['props']['variant'] = 'primary'
    if 'later-observed' in controls:
        later = controls['later-observed']
        later['box'] = [1248, 950, 328, 32]
        later['props']['label'] = 'Study: later shared-ready record'
        later['props']['size'] = 13
        later['props']['link']['effect'] = 'history-read'
        scene['regions'].remove(later)
        scene.setdefault('studyLinks', []).append(later)
    for target in ('F5-W12-GIT-REVIEW', 'F5-W12-GIT-REVIEW-DEFINITION', 'F5-W12-GIT-REVIEW-CI-ENTRY'):
        origins = []
        for source in scenes.values():
            links = [r.get('props', {}).get('link', {}) for r in source.get('regions', []) + source.get('studyLinks', [])]
            if any(link.get('type', 'navigate') != 'back' and link.get('to') == target for link in links):
                origins.append(source['id'])
        for region in scenes[target]['regions']:
            link = region.get('props', {}).get('link')
            if link and link.get('type') == 'back':
                link['allowedOrigins'] = sorted(set(origins) - {target})
        if 'allowedOrigins' in scenes[target].get('state', {}):
            scenes[target]['state']['allowedOrigins'] = sorted(set(origins) - {target})
