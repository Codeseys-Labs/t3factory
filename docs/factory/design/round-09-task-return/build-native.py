"""Package the editable sources for an additive Figma Scripter import."""
from pathlib import Path
import hashlib
import os
import json

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "task-journey/scene-manifest.json").read_text(encoding="utf-8"))
sources = []
for scene in manifest["scenes"]:
    path = HERE / "task-journey" / scene["svg"]
    sources.append({"id": scene["id"], "svg": path.read_text(encoding="utf-8"), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
for filename, scene_id in [("01-task-navigation.svg", "R9-WF01"), ("02-task-lifecycle.svg", "R9-WF02")]:
    path = HERE / "wayfinder" / filename
    sources.append({"id": scene_id, "svg": path.read_text(encoding="utf-8"), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
controls = [control for control in manifest["controls"] if control.get("target")]
payload = json.dumps({"sources": sources, "controls": controls, "taskCount": len(manifest["scenes"])}, ensure_ascii=False, separators=(",", ":"))
digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
task_count = len(manifest["scenes"])
token = "__R9_SCENE_ID__"
normalized = [source["svg"].replace(source["id"], token) for source in sources[:task_count]]
if any(token in source["svg"] for source in sources):
    raise ValueError("Reserved import token occurs in source")
prefix = os.path.commonprefix(normalized)
packed = []
for i, source in enumerate(sources):
    if i < task_count:
        suffix = normalized[i][len(prefix):]
        restored = (prefix + suffix).replace(token, source["id"])
        if restored != source["svg"]:
            raise ValueError("Lossless source packaging check failed")
        packed.append({"id": source["id"], "suffix": suffix, "sha256": source["sha256"]})
    else:
        packed.append(source)
payload = json.dumps({"sources": packed, "controls": controls, "taskCount": task_count, "commonPrefix": prefix, "sourceToken": token}, ensure_ascii=False, indent=2)
program = r'''const data = PAYLOAD;
for (const source of data.sources) {if ('suffix' in source) source.svg = (data.commonPrefix + source.suffix).split(data.sourceToken).join(source.id);}
const sourceDigest = DIGEST;
const page = figma.currentPage;
if (page.id !== '4:80' || page.name !== '02 · Factory studies') throw new Error('Select the existing Factory studies page before import.');
if (page.children.some(n => (n.name.startsWith('R9 · Task return') || n.name.startsWith('R9-T') || n.name.startsWith('R9-WF')))) throw new Error('An R9 import already exists. Inspect its recorded identity; do not duplicate or replace it.');
const existing = page.children.map(n => ({id:n.id, x:n.x, y:n.y, w:n.width, h:n.height}));
const bottom = Math.max(0, ...existing.map(n => n.y + n.h));
if (!Number.isFinite(bottom)) throw new Error('Cannot establish a safe additive placement.');
const root = figma.createFrame();
root.name = 'R9 · Task return · INCOMPLETE';
root.fills = [];
root.clipsContent = false;
root.x = 50000;
root.y = bottom + 2400;
root.resize(7200, 6000);
const frames = {};
const wiring = [];
try {
  for (let i = 0; i < data.sources.length; i++) {
    const source = data.sources[i];
    const frame = figma.createFrame();
    page.appendChild(frame);
    frame.name = source.id;
    frame.fills = [];
    frame.clipsContent = false;
    const composition = figma.createNodeFromSvg(source.svg);
    frame.appendChild(composition);
    composition.name = 'Editable source composition';
    composition.x = 0; composition.y = 0;
    frame.resize(composition.width, composition.height);
    frame.x = root.x + (i < data.taskCount ? (i % 4) * 1800 : (i - data.taskCount) * 2700);
    frame.y = root.y + (i < data.taskCount ? Math.floor(i / 4) * 1240 : Math.ceil(data.taskCount / 4) * 1240 + 160);
    frames[source.id] = frame;
  }
  for (const control of data.controls) {
    const frame = frames[control.screen], target = frames[control.target];
    if (!frame || !target) throw new Error('Missing in-slice control destination.');
    const hit = figma.createRectangle();
    frame.appendChild(hit);
    hit.name = control.groupId + ' · ' + control.label;
    hit.x = control.box[0]; hit.y = control.box[1];
    hit.resize(control.box[2], control.box[3]);
    hit.fills = [{type:'SOLID', color:{r:0,g:0,b:0}, opacity:0}];
    hit.strokes = [];
    hit.reactions = [{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:target.id,navigation:'NAVIGATE',transition:null,preserveScrollPosition:false}]}];
    if (hit.reactions.length !== 1) throw new Error('Prototype reaction was not stored.');
    wiring.push({from:control.screen,to:control.target,nodeId:hit.id,label:control.label,kind:control.kind,effect:control.effect});
  }
  root.resize(1,1);
  root.visible = false;
  if (page.children.filter(n => existing.some(e=>e.id===n.id)).length !== existing.length) throw new Error('Original page identities changed; inspect concurrent edits.');
  root.name = 'R9 · Task return + wayfinders · 2026-11-04';
  page.selection = [frames['R9-T01']];
  figma.viewport.scrollAndZoomIntoView([frames['R9-T01']]);
  figma.notify('R9BINDING:'+JSON.stringify({rootId:root.id,pageId:page.id,before:existing.length,after:page.children.length,frames:Object.fromEntries(Object.entries(frames).map(([k,v])=>[k,v.id])),links:wiring.length}),{timeout:60000});
  print('R9IMPORT:'+JSON.stringify({status:'IMPORTED_WIRING_CONFIGURED_POINTER_UNVERIFIED',sourceDigest,rootId:root.id,pageId:page.id,frames:data.sources.map(s=>({scene:s.id,nodeId:frames[s.id].id,sourceSha256:s.sha256,width:frames[s.id].width,height:frames[s.id].height})),wiring,originalTopLevelIdentitiesRetained:existing.length,limits:['Fictional design states only','No functional inputs, providers, integrations or persistence','No component/auto-layout/accessibility/mobile qualification']}));
} catch (error) {
  print('R9IMPORT:'+JSON.stringify({status:'INCOMPLETE',rootId:root.id,sourceDigest,frames:Object.entries(frames).map(([scene,n])=>({scene,nodeId:n.id})),wiring,error:String(error)}));
  throw error;
}
'''
program = program.replace("PAYLOAD", payload, 1).replace("DIGEST", json.dumps(digest), 1)
(HERE / "native-import.js").write_text(program, encoding="utf-8")
(HERE / "native-package.json").write_text(json.dumps({"status":"SOURCE_PACKAGE_NATIVE_EVIDENCE_SEPARATE","sourceDigest":digest,"frames":len(sources),"configuredSourceEdges":len(controls),"sourceHashes":{s["id"]:s["sha256"] for s in sources}}, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"frames":len(sources),"sourceEdges":len(controls),"sourceDigest":digest,"scriptBytes":len(program.encode('utf-8'))}))
