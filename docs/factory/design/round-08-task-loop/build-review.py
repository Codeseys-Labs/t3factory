"""Build a self-contained gallery of the task journey and wayfinders."""
from pathlib import Path
import base64
import json

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "task-journey/scene-manifest.json").read_text(encoding="utf-8"))
items = [{"id":s["id"], "title":s["title"], "path":HERE/"task-journey"/s["svg"]} for s in manifest["scenes"]]
items += [{"id":"R8-WF01", "title":"Navigation wayfinder", "path":HERE/"wayfinder/01-task-navigation.svg"}, {"id":"R8-WF02", "title":"Lifecycle wayfinder", "path":HERE/"wayfinder/02-task-lifecycle.svg"}]
for item in items:
    item["src"] = "data:image/svg+xml;base64," + base64.b64encode(item.pop("path").read_bytes()).decode()
html = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T3 Factory task-loop refinement</title><style>
:root{font-family:var(--font-sans,system-ui,sans-serif);color:var(--foreground,#e7e9ed)}*{box-sizing:border-box}body{margin:0}h2{font-size:18px;margin:0 0 6px}p{font-size:13px;line-height:1.5;margin:0 0 14px;color:var(--muted-foreground,#a8b0bd)}nav{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}button{font:inherit;font-size:12px;padding:7px 10px;border:1px solid var(--border,#485263);border-radius:6px;background:var(--secondary,#202630);color:var(--foreground,#e7e9ed);cursor:pointer}button[aria-pressed=true]{background:var(--primary,#346bf1);color:var(--primary-foreground,#fff)}button:focus-visible{outline:2px solid var(--ring,#8cb7ff);outline-offset:2px}figure{margin:0}img{display:block;width:100%;height:auto;border:1px solid var(--border,#485263);border-radius:6px}figcaption{font-size:12px;margin:8px 0;color:var(--muted-foreground,#a8b0bd)}.priorities{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;margin-top:12px}.priorities span{background:var(--card,#171d26);border-radius:6px;padding:8px}strong{color:var(--foreground,#e7e9ed)}
</style></head><body><p>Proposed desktop journey and wayfinders. Explore the design states; this gallery does not run tasks or external actions.</p><nav aria-label="Design states"></nav><figure><img id="screen" alt=""><figcaption id="caption" aria-live="polite"></figcaption></figure><div class="priorities" aria-label="Proposed delivery priorities"><span><strong>P1</strong> Core task loop</span><span><strong>P2</strong> Integrations</span><span><strong>P3</strong> Workflows + machines</span><span><strong>P4</strong> Optional platform CI</span></div><p style="margin-top:10px">P1–P4 preserve the tracker’s existing milestone IDs. Static designs and fictional records; runtime, mobile and accessibility qualification remain separate.</p><script>
const items=ITEMS; const nav=document.querySelector('nav'); function show(i){document.getElementById('screen').src=items[i].src; document.getElementById('screen').alt=items[i].id+' — '+items[i].title; document.getElementById('caption').textContent=items[i].id+' · '+items[i].title; [...nav.children].forEach((b,n)=>b.setAttribute('aria-pressed',String(i===n)));} items.forEach((s,i)=>{const b=document.createElement('button');b.type='button';b.textContent=s.id;b.setAttribute('aria-label',s.title);b.onclick=()=>show(i);nav.appendChild(b);});show(0);
</script></body></html>'''.replace("ITEMS", json.dumps(items, ensure_ascii=False, separators=(",",":")))
(HERE/"review.html").write_text(html, encoding="utf-8")
print(json.dumps({"screens":len(items),"file":"review.html","bytes":len(html.encode('utf-8'))}))
