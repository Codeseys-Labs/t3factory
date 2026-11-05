"""Review corrections; source-only design, preserving the first author submission."""
from pathlib import Path
import importlib.util, json, sys, xml.etree.ElementTree as ET
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('original', ROOT/'build/build_optional_linear.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.OUT = ROOT/'refined/screens'; m.HERE = ROOT/'refined'
m.OUT.mkdir(parents=True, exist_ok=True)
C=m.C; NS=m.K.NS; Canvas=m.Canvas
ORIGINAL_FINISH=Canvas.finish
ALL_LOCAL=[m.LOCAL_ROWS[0],m.NEW_LOCAL]+m.LOCAL_ROWS[1:]
MIXED=m.MIXED_ROWS.copy(); MIXED.insert(1,m.LOCAL_ROWS[1])
FRESH=('L-044','Document retry expectations','Local','Ready','—','Ilan','Not started')
UNLINKED=[m.NEW_LOCAL if r[0]=='L-041' else r for r in MIXED]
CAPTIONS={
    'R7-03': 'L-041 remains local. Connect a source opens optional setup; no authorization or link is inferred. Local edits stay local.',
    'R7-10': 'Existing read connection required. Confirm keeps L-041 and opens its linked local brief. Cancel returns to the unchanged seven-item collection.',
}

def correct_caption(root, text):
    group=next(el for el in root.iter() if el.get('id','').endswith('specification-outside-product'))
    notes=[el for el in group if el.tag.endswith('text') and 950 <= float(el.get('y','0')) < 1000]
    assert notes
    notes[0].text=text
    for el in notes[1:]: group.remove(el)

def route(sid,group,target):
    m.EDGES[:]=[e for e in m.EDGES if not(e['from']==sid and e['groupId']==group)]
    for r in m.REGIONS:
        if r['screen']==sid and r['groupId']==group:
            r['target']=target
            if target: m.EDGES.append(dict(id=sid+'--'+group,from_=sid,to=target,groupId=group,box=r['box'],kind='navigate',effect='Bounded fictional navigation; no external operation.'))
    for e in m.EDGES:
        if 'from_' in e: e['from']=e.pop('from_')

def finish(cv,composition):
    sid=cv.sid
    if sid in CAPTIONS:
        correct_caption(cv.svg,CAPTIONS[sid])
        cv.meta['caption']=CAPTIONS[sid]
    local=sid in ['R7-01','R7-02','R7-03','R7-12','R7-14','R7-15']
    if local:
        for g,t in [('nav-intake','R7-15'),('nav-more','R7-14')]: route(sid,g,t)
    if sid=='R7-03':
        for g,t in [('nav-work','R7-12'),('close-local-inspector','R7-12'),('save-local-edits',None),('review-existing-link','R7-14')]: route(sid,g,t)
    if sid in ['R7-14','R7-15']: route(sid,'nav-work',None)
    if sid=='R7-12': route(sid,'nav-work','R7-12')
    if sid=='R7-04': route(sid,'create-local','R7-18')
    if sid in ['R7-05','R7-11']:
        cv.btn('edit-local-brief',340,800,174,'Edit local brief','R7-19')
    if sid in ['R7-09','R7-16','R7-17']:
        for g,t in [('nav-work','R7-16'),('nav-intake',None),('nav-more','R7-17'),('recovery-back','R7-16'),('reconnect-review','R7-17')]: route(sid,g,t)
    if sid=='R7-10':
        for g,t in [('nav-work','R7-22'),('cancel-link-top','R7-22'),('cancel-link','R7-22'),('confirm-existing-link','R7-13')]: route(sid,g,t)
    for el in cv.svg.iter():
        if el.tag.endswith('text'):
            if el.text=='6 items': el.text='7 items'
            if el.text=='Link existing issue…' and sid=='R7-03': el.text='Connect a source…'
            if el.text and el.text.startswith('PROPOSED DESIGN ·'): el.text='PROPOSED DESIGN · Fictional fixtures · Inputs and external actions are static · No runtime or integration proof'
    ORIGINAL_FINISH(cv,composition)
Canvas.finish=finish

def table(cv,rows,selected=None,narrow=False,x=340,y=236,width=None):
    width=width or cv.width-x-20
    local=all(r[2]=='Local' for r in rows)
    h=62 if len(rows)>7 else 68 if len(rows)>6 else 76
    if narrow: cols=[('Work item',12),('Planning stage',width-160)]
    elif local: cols=[('Work item',12),('Planning stage',640),('Human owner',840),('Execution',1030)]
    else: cols=[('Work item',12),('Source',430),('Planning stage',640),('Source status',790),('Human owner',940),('Execution',1090)]
    with cv.group('work-table-column-headers'):
        cv.rect(x,y,width,38,'#151515',C['BORDER'],6)
        for label,dx in cols: cv.txt(x+dx,y+25,label,12,C['MUT'],600)
    for i,row in enumerate(rows):
        key,title,source,stage,status,owner,execution=row; yy=y+38+i*h; gid='row-'+key.lower()
        with cv.group(gid):
            cv.rect(x,yy,width,h,'#121c30' if key==selected else '#080808',C['BORDER'],6)
            cv.lines(gid+'-title',x+12,yy+23,title,width-200 if narrow else 402,14,weight=500,leading=18)
            cv.txt(x+12,yy+h-10,key,11,C['MUT'])
            vals=[(stage,width-160)] if narrow else [(stage,640),(owner,840),(execution,1030)] if local else [(source,430),(stage,640),(status,790),(owner,940),(execution,1090)]
            for value,dx in vals: cv.txt(x+dx,yy+29,value,13)
        target=None
        if key=='ENG-237': target='R7-09' if cv.sid=='R7-16' else 'R7-05'
        if key=='L-041': target='R7-03' if local else 'R7-10' if cv.sid=='R7-22' else 'R7-13'
        if target: cv.action(gid,[x,yy,width,h],'Inspect '+key,target)
    cv.txt(x,y+38+len(rows)*h+24,str(len(rows))+' items · ordered by Planning stage',12,C['MUT'])
m.table=table

def collection(sid,rows,title,subtitle,disconnected=False):
    cv=Canvas(sid,title,'Collection state preserves every local identity. Source status, local planning and execution are separate.')
    m.page_head(cv,subtitle,str(len(rows))+' items'); m.toolbar(cv,create=sid=='R7-04')
    table(cv,rows,y=236)
    if disconnected:
        cv.lines('saved-state',340,824,'Linear disconnected · saved at 10:12 · ENG-237 status request outcome unknown',1190,13,C['WARN'])
    elif sid=='R7-04': cv.lines('retained-state',340,824,'L-041 linked to ENG-244 · local brief, all five local records and history retained',1180,13,C['BLUE_TEXT'])
    cv.finish('work-collection')

def local_linked():
    cv=Canvas('R7-13','Linked local work retains its brief','L-041 and plan-local-041 are unchanged. Local title, brief and history remain editable. ENG-244 properties are read-only.')
    m.page_head(cv,'All planned · L-041 selected','7 items')
    cv.btn('back-to-work',340,176,130,'← Back to Work','R7-04')
    cv.txt(340,260,'Local work · L-041',22,weight=600)
    cv.field('local-title',340,315,720,'Local title','Clarify API error responses')
    cv.field('local-brief',340,410,720,'Local brief','Explain the failure and next step when an API request is rejected.',110)
    cv.field('local-owner',340,584,340,'Human owner','Mara')
    cv.field('local-stage',700,584,360,'Planning stage · local','Ready')
    cv.btn('save-local-brief',340,690,174,'Save local changes',primary=True,kind='fixture-edit')
    cv.txt(340,768,'History · created by Mara at 10:12; existing issue linked at 10:16.',13,C['MUT'])
    cv.txt(340,806,'No thread · execution not started · acceptance not reviewed · delivery held',13,C['MUT'])
    with cv.group('linked-source'):
        cv.rect(1100,236,480,620,'#0b0b0b',C['BORDER'],10)
        cv.txt(1124,278,'Linked source',16,weight=600)
        cv.txt(1124,320,'Linear · ENG-244',15,C['BLUE_TEXT'])
        cv.txt(1124,358,'Acme / Engineering · checked at 10:16',12,C['MUT'])
        cv.rule(1124,386,432)
        for y,l,v in [(424,'Linear status','Backlog'),(478,'Source owner','Mara'),(532,'Source properties','Read-only')]:
            cv.txt(1124,y,l,12,C['MUT']); cv.txt(1340,y,v,14)
        cv.lines('source-separation',1124,604,'Local brief edits do not change the issue description in Linear.',420,14)
        cv.btn('connection-scope',1124,710,190,'Connection permissions','R7-07')
    cv.finish('linked-local-editor')

def no_connection():
    cv=Canvas('R7-14','Optional connection setup','Standalone caller retained using native Back. Authorize is an external step, not a successful connection fixture.',section='More')
    cv.btn('return',340,118,100,'← Back',kind='back')
    cv.txt(340,220,'Connections',24,weight=600)
    cv.txt(340,257,'Factory works with local work. Add an issue source when you need one.',14,C['MUT'])
    cv.rect(340,310,1000,350,'#0b0b0b',C['BORDER'],10)
    cv.txt(364,355,'Linear · not connected',18,weight=600)
    cv.lines('connection-details',364,402,'Connect a workspace, choose teams and projects, then review what Factory can read. Linking an issue never creates a connection by itself.',940,14)
    cv.txt(364,495,'Start with read-only access. Status updates require a separate opt-in.',13,C['MUT'])
    cv.btn('authorize-linear',364,551,202,'Connect Linear…',kind='external-authorization')
    cv.txt(364,625,'Local items, briefs and execution stay in Factory.',13,C['MUT'])
    cv.finish('connections')

def empty_intake():
    cv=Canvas('R7-15','Standalone Intake','No connection is assumed. Native Back returns to the originating collection or inspector.',section='Intake')
    cv.btn('return',340,118,100,'← Back',kind='back')
    cv.txt(340,220,'Intake',24,weight=600)
    cv.txt(340,254,'Review new arrivals before adding them to your plan.',14,C['MUT'])
    cv.rect(340,310,1000,300,'#0b0b0b',C['BORDER'],10)
    cv.txt(372,365,'No arrivals to review',22,weight=600)
    cv.lines('intake-empty-copy',372,411,'Your local work is already in Work. Sources are optional; you can keep planning and running workflows without connecting one.',920,15)
    cv.btn('optional-sources',372,516,202,'Manage sources','R7-14')
    cv.finish('intake-reader')

def reconnect():
    cv=Canvas('R7-17','Reconnect review retains uncertainty','External authorization and reconciliation remain unrun. Opening this review does not reconnect or resolve the previous request.',section='More')
    cv.btn('return',340,118,100,'← Back',kind='back')
    cv.txt(340,220,'Reconnect Linear',24,weight=600)
    cv.txt(340,257,'Acme / Engineering · Workstation',14,C['MUT'])
    cv.rect(340,310,1100,460,'#0b0b0b',C['BORDER'],10)
    cv.txt(364,355,'Disconnected · last checked at 10:12',18,weight=600)
    cv.lines('retained-intent',364,412,'ENG-237 requested Ready to Merge at 10:13. The request timed out; the outcome is still unknown.',1000,16,C['WARN'])
    cv.lines('after-authorization',364,494,'After authorization, check the current issue before deciding what to do. A matching status alone does not prove this request caused it.',1000,14)
    cv.btn('authorize-again',364,590,244,'Continue to Linear…',kind='external-authorization')
    cv.txt(364,679,'No automatic resend. Local planning and saved history remain available.',14,C['MUT'])
    cv.finish('connections')

def mixed_create():
    cv=Canvas('R7-18','Create local work in a mixed collection','Creates fresh L-044. Cancel preserves the seven-item mixed collection, including linked L-041.')
    m.page_head(cv,'New local work','Local draft')
    cv.btn('cancel-create-top',340,176,96,'← Work','R7-04')
    cv.txt(480,256,'Create local work',22,weight=600)
    cv.field('local-title',480,330,820,'Title',FRESH[1])
    cv.field('local-description',480,421,820,'Local brief','Explain when a failed attempt can be retried, and when its outcome is unknown.',114)
    cv.field('local-owner',480,598,392,'Human owner','Ilan'); cv.field('local-stage',900,598,400,'Planning stage','Ready')
    cv.btn('cancel-create',994,700,100,'Cancel','R7-04')
    cv.btn('save-create-local',1106,700,194,'Create local work','R7-20',True,kind='fixture-transition')
    cv.finish('local-editor')

def brief():
    cv=Canvas('R7-19','Local brief for ENG-237','Separate local content for plan-linear-237. Native Back restores the 1600 or 1280 caller. No remote-description edit or save acknowledgement is simulated.')
    cv.btn('return',340,118,100,'← Back',kind='back')
    cv.txt(340,220,'Local brief · ENG-237',24,weight=600)
    cv.txt(340,260,'Linked source: Linear · Acme / Engineering · In Review',14,C['MUT'])
    cv.field('local-brief',340,344,1000,'Local brief','Measure typing responsiveness while indexing. Preserve cancellation and report progress.',180)
    cv.btn('save-local-brief',340,596,174,'Save local changes',primary=True,kind='fixture-edit')
    cv.txt(340,680,'Local planning: Ready · execution: Not started · delivery: Held',14,C['MUT'])
    cv.txt(340,720,'The source description stays read-only. Prepared run inputs remain pinned.',14,C['MUT'])
    cv.finish('local-editor')

def main():
    m.standalone(); m.create(); m.local_inspector()
    collection('R7-04',MIXED,'Mixed Work','All planned')
    m.linked();m.intake();m.connections();m.conflict();m.disconnected();m.link_existing();m.linked('R7-11',1280)
    collection('R7-12',ALL_LOCAL,'Standalone Work after creation','All planned · local work')
    local_linked();no_connection();empty_intake()
    saved=[tuple('In Progress' if i==4 and r[0]=='ENG-237' else v for i,v in enumerate(r)) for r in MIXED]
    collection('R7-16',saved,'Disconnected Work','All planned · saved source details',True)
    reconnect();mixed_create();brief()
    collection('R7-20',MIXED[:5]+[FRESH]+MIXED[5:],'Mixed Work after local creation','All planned · L-044 created locally')
    collection('R7-22',UNLINKED,'Connected Work before linking','All planned · L-041 is local; connection already authorized')
    # Avoid invented continuity through unmodeled states. Native Back is used for shared review views.
    for sid in ['R7-14','R7-15','R7-19']:
        for g in ['nav-work','nav-intake','nav-more']: route(sid,g,None)
    for sid in ['R7-18','R7-20']: route(sid,'nav-work','R7-04' if sid=='R7-18' else 'R7-20')
    for g in ['nav-intake','nav-more','row-eng-237','row-l-041']: route('R7-20',g,None)
    route('R7-22','nav-work','R7-22')
    for sid in ['R7-10','R7-18','R7-22']:
        for g in ['nav-intake','nav-more']: route(sid,g,None)
    route('R7-22','row-eng-237',None)
    route('R7-16','row-l-041',None)
    # Shared connection review returns by history; other section changes are outside these journeys.
    for g in ['connections-back','nav-work','nav-intake']: route('R7-07',g,None)
    for r in m.REGIONS:
        if r['screen']=='R7-07' and r['groupId']=='connections-back': r['kind']='back'
    # Prefix names for unambiguous native lookup while preserving the immutable first draft.
    for scene in m.SCENES:
        old=scene['id']; new=old.replace('R7-','R7F-'); path=Path(scene['svg']); root=ET.parse(path).getroot()
        for el in root.iter():
            if el.get('id'): el.set('id',new+'--'+el.get('id'))
            if el.tag.endswith('text') and el.text: el.text=el.text.replace(old+' ·',new+' ·')
        target=m.OUT/(new+'.svg'); ET.ElementTree(root).write(target,encoding='utf-8',xml_declaration=True)
        path.unlink(); scene.update(id=new,svg=str(target),png=str(m.OUT/(new+'.png')),svgSha256=m.digest(target))
    for r in m.REGIONS:
        r['screen']=r['screen'].replace('R7-','R7F-'); r['groupId']=r['screen']+'--'+r['groupId']
        if r['target']: r['target']=r['target'].replace('R7-','R7F-')
    for e in m.EDGES:
        e.update(id=e['id'].replace('R7-','R7F-'),groupId=e['from'].replace('R7-','R7F-')+'--'+e['groupId'],**{'from':e['from'].replace('R7-','R7F-'),'to':e['to'].replace('R7-','R7F-')})
    checked=m.geometry(); m.write_json(m.HERE/'action-regions.json',m.REGIONS); m.write_json(m.HERE/'edges.json',m.EDGES)
    m.write_json(m.HERE/'scene-manifest.json',{'status':'CORRECTED_SOURCE_UNWIRED','scenes':m.SCENES,'inputSha256':m.digest(ROOT/'build/build_optional_linear.py')})
    print(json.dumps({'scenes':len(m.SCENES),'geometry':checked['status'],'issues':checked['issues']}),flush=True)
    if checked['issues']: return
    for s in m.SCENES:
        m.K.render(s['svg'],s['png']);s['pngSha256']=m.digest(s['png']);print(s['id'],flush=True)
    m.write_json(m.HERE/'scene-manifest.json',{'status':'CORRECTED_SOURCE_UNWIRED','scenes':m.SCENES,'inputSha256':m.digest(ROOT/'build/build_optional_linear.py')})
if __name__=='__main__': main()
