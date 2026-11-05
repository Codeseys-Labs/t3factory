"""Build a self-contained gallery of the task journey and wayfinders."""
from pathlib import Path
import base64
import json

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "task-journey/scene-manifest.json").read_text(encoding="utf-8"))
native = json.loads((HERE / "native-evidence.json").read_text(encoding="utf-8"))
native_status = ("Native Figma design navigation verified for fifteen controls; runtime remains unqualified."
                 if native["status"] == "NATIVE_DESIGN_NAVIGATION_VERIFIED"
                 else "Native Figma import remains unconfirmed.")
items = [{"id":s["id"], "title":s["title"], "width":s["width"], "height":s["height"], "path":HERE/"task-journey/previews"/(s["id"]+".png")} for s in manifest["scenes"]]
items += [{"id":"R9-WF01", "title":"Navigation wayfinder", "path":HERE/"wayfinder/01-task-navigation.png"}, {"id":"R9-WF02", "title":"Lifecycle wayfinder", "path":HERE/"wayfinder/02-task-lifecycle.png"}]
for item in items:
    item["src"] = "data:image/png;base64," + base64.b64encode(item.pop("path").read_bytes()).decode()
html = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T3 Factory task-return refinement</title><style>
:root{font-family:var(--font-sans,system-ui,sans-serif);color:var(--foreground,#e7e9ed)}*{box-sizing:border-box}body{margin:0}h2{font-size:18px;margin:0 0 6px}p{font-size:13px;line-height:1.5;margin:0 0 14px;color:var(--muted-foreground,#a8b0bd)}nav{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}button{font:inherit;font-size:12px;padding:7px 10px;border:1px solid var(--border,#485263);border-radius:6px;background:var(--secondary,#202630);color:var(--foreground,#e7e9ed);cursor:pointer}button[aria-pressed=true]{background:var(--primary,#346bf1);color:var(--primary-foreground,#fff)}button:focus-visible{outline:2px solid var(--ring,#8cb7ff);outline-offset:2px}figure{margin:0}img{display:block;width:100%;height:auto;border:1px solid var(--border,#485263);border-radius:6px}figcaption{font-size:12px;margin:8px 0;color:var(--muted-foreground,#a8b0bd)}.priorities{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:12px}.priorities span{background:var(--card,#171d26);border-radius:6px;padding:8px}strong{color:var(--foreground,#e7e9ed)}
.canvas{position:relative}#hotspots{position:absolute;inset:0}#hotspots button{position:absolute;margin:0;padding:0;border:1px solid transparent;background:transparent;color:transparent;border-radius:3px}#hotspots button:hover,#hotspots button:focus-visible{border-color:var(--ring);background:color-mix(in srgb,var(--primary) 18%,transparent)}
</style></head><body><p>Click the task controls or choose a state. Fifteen links connect fictional source states; inputs and actions are illustrative. Native Figma import remains unconfirmed.</p><nav aria-label="Design states"></nav><figure><div class="canvas"><img id="screen" alt=""><div id="hotspots" aria-label="Source prototype controls"></div></div><figcaption id="caption" aria-live="polite"></figcaption></figure><div class="priorities" aria-label="Proposed delivery priorities"><span><strong>P1</strong> Core task loop</span><span><strong>P2</strong> Integrations</span><span><strong>P3</strong> Workflows + machines</span><span><strong>P4</strong> Optional platform CI</span></div><p style="margin-top:10px">P1–P4 retain the tracker’s milestone IDs. Task PNGs use bound Inter outline derivatives. Runtime, mobile and accessibility qualification remain separate.</p><script>
const items=ITEMS; const controls=CONTROLS; const nav=document.querySelector('nav');
function show(i){const s=items[i];document.getElementById('screen').src=s.src;document.getElementById('screen').alt=s.id+' — '+s.title;document.getElementById('caption').textContent=s.id+' · '+s.title;[...nav.children].forEach((b,n)=>b.setAttribute('aria-pressed',String(i===n)));const h=document.getElementById('hotspots');h.replaceChildren();controls.filter(c=>c.screen===s.id).forEach(c=>{const b=document.createElement('button');b.type='button';b.setAttribute('aria-label',c.label);b.title=c.label;const [x,y,w,z]=c.box;Object.assign(b.style,{left:(100*x/s.width)+'%',top:(100*y/s.height)+'%',width:(100*w/s.width)+'%',height:(100*z/s.height)+'%'});b.onclick=()=>show(items.findIndex(t=>t.id===c.target));h.appendChild(b);});}
items.forEach((s,i)=>{const b=document.createElement('button');b.type='button';b.textContent=s.id;b.setAttribute('aria-label',s.title);b.onclick=()=>show(i);nav.appendChild(b);});show(items.findIndex(s=>s.id==='R9-T05'));
</script></body></html>'''.replace("ITEMS", json.dumps(items, ensure_ascii=False, separators=(",",":"))).replace("CONTROLS", json.dumps([c for c in manifest["controls"] if c.get("target")],ensure_ascii=False,separators=(",",":")))
html = html.replace("Native Figma import remains unconfirmed.", native_status)
(HERE/"review.html").write_text(html, encoding="utf-8")
inline_items = [item for item in items if item["id"] in {"R9-T02", "R9-T04", "R9-T08"}]
for filename, scene_id, title in [("01-task-navigation.svg", "R9-WF01", "Navigation wayfinder"), ("02-task-lifecycle.svg", "R9-WF02", "Lifecycle wayfinder")]:
    inline_items.append({"id":scene_id,"title":title,"src":"data:image/svg+xml;base64,"+base64.b64encode((HERE/"wayfinder"/filename).read_bytes()).decode()})
inline_html = html.replace(json.dumps(items, ensure_ascii=False, separators=(",",":")), json.dumps(inline_items, ensure_ascii=False, separators=(",",":")), 1)
inline_html = inline_html.replace(json.dumps([c for c in manifest["controls"] if c.get("target")], ensure_ascii=False, separators=(",",":")), "[]", 1)
inline_html = inline_html.replace("s.id==='R9-T05'", "s.id==='R9-T08'")
inline_html = inline_html.replace("Click the task controls or choose a state. Fifteen links connect fictional source states; inputs and actions are illustrative.", "Choose a view to compare direct work, preparation acceptance, reopened history and the maps. The complete clickable journey is in review.html.")
if len(inline_html)>512000:
    raise ValueError("Inline review exceeds the presentation limit")
(HERE/"inline-review.html").write_text(inline_html, encoding="utf-8")
print(json.dumps({"screens":len(items),"file":"review.html","bytes":len(html.encode('utf-8'))}))
