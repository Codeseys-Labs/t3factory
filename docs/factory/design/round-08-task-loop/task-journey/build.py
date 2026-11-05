"""Editable task-journey design source; no application or connector behavior."""

from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
DESIGN = HERE.parents[1]
SPEC = importlib.util.spec_from_file_location(
    "r7_design", DESIGN / "round-07-optional-linear/build/build_optional_linear.py"
)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
K, C = M.K, M.C
SCENES, REGIONS, EDGES = [], [], []
TASK = {"environmentId": "env-demo", "projectId": "customer-ops", "id": "local-084", "displayId": "T-084"}
BLUE = C["BLUE"]
GREEN, AMBER = "#74c69d", "#e8bf78"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class Page(M.Canvas):
    def __init__(self, sid, title, caption, state, active=False, intake=False):
        super().__init__(sid, title, caption, section="Intake" if intake else "Work")
        M.REGIONS[:] = [r for r in M.REGIONS if r["screen"] != sid]
        M.EDGES[:] = [e for e in M.EDGES if e["from"] != sid]
        self.state = {"taskRef": TASK, **state}
        self.containers = []
        for el in self.svg.iter():
            if el.tag.endswith("text") and el.text == "T3 Code":
                el.text = "T3 Factory"
            if el.tag.endswith("text") and el.text == "No active turns" and active:
                el.text = "Preparing customer follow-up"
            if el.tag.endswith("text") and el.get("x") == "300" and el.get("y") == "614":
                el.text = "1" if active else "0"
            if el.tag.endswith("text") and el.text and el.text.startswith("PROPOSED DESIGN"):
                el.text = "PROPOSED DESIGN · Fictional task, assignments and receipts · No runtime, connector, native-import or accessibility proof"
        if intake:
            self.txt(340, 137, "Intake", 20, weight=600)
            self.txt(340, 161, "Capture an outcome. The factory figures out the work.", 13, C["MUT"])
        else:
            self.txt(340, 133, "Customer operations  /  T-084", 12, C["MUT"])
            self.txt(340, 165, "Prepare the customer follow-up", 22, weight=600)
            self.txt(340, 190, "Mara · Local task · Customer thread + incident note", 12, C["MUT"])
        self.action("nav-work", [340, 56, 72, 34], "Work", kind="out-of-slice", effect="Return to the current Work query without changing this task.")
        self.action("nav-intake", [416, 56, 76, 34], "Intake", kind="out-of-slice", effect="Open capture without discarding or replaying this task.")
        self.action("nav-workflows", [496, 56, 110, 34], "Workflows", kind="out-of-slice", effect="Optional reusable workflows; never a prerequisite for this task.")
        self.action("nav-more", [610, 56, 70, 34], "More", kind="out-of-slice", effect="Existing project menu; connections remain optional.")

    def panel(self, gid, x, y, w, h, fill="#0b0b0b", stroke=None):
        with self.group(gid):
            self.rect(x, y, w, h, fill, stroke or C["BORDER"], 8)
        self.containers.append({"id": gid, "box": [x, y, w, h]})

    def status(self, label, hint, color=BLUE):
        self.rect(340, 214, 1240, 54, "#10141c", "#283244", 8)
        self.el("circle", cx=358, cy=241, r=4, fill=color)
        self.txt(374, 239, label, 14, weight=600)
        self.txt(374, 258, hint, 12, C["MUT"])

    def right(self, label="Task details"):
        self.panel("task-details", 1250, 288, 330, 500)
        self.txt(1270, 317, label, 14, weight=600)
        details = [("Human owner", "Mara"), ("Assignment", "Auto · workspace policy"),
                   ("Execution", self.state.get("execution", "Not started")),
                   ("Source", "Pasted context · local"), ("Outcome", "Summary, meeting, reply")]
        for i, (key, value) in enumerate(details):
            self.txt(1270, 353+i*58, key, 12, C["MUT"])
            self.txt(1270, 375+i*58, value, 13)
        self.rule(1270, 630, 290)
        self.lines("policy-summary", 1270, 659, "Research and drafts may advance automatically. Sending and calendar writes need reviewed authority.", 290, 13, C["MUT"], leading=20)
        self.txt(1270, 752, "Connections are optional", 12, C["DIM"])

    def phase(self, selected, y=294):
        labels = ["Investigate", "Deep-dive", "Architect", "Plan", "Act", "Review"]
        x = 340
        for label in labels:
            w = max(90, int(K.text_width(label, 12, 500))+24)
            self.rect(x, y, w, 28, "#191a1d" if label == selected else "#000", radius=5)
            self.txt(x+12, y+19, label, 12, C["FG"] if label == selected else C["DIM"], 500)
            x += w+4

    def finish(self, composition):
        for el in self.svg.iter():
            if el.tag.endswith("g") and el.get("id"):
                el.set("id", self.sid+"--"+el.get("id"))
        local_regions = [r for r in M.REGIONS if r["screen"] == self.sid]
        for r in local_regions:
            r["groupId"] = self.sid+"--"+r["groupId"]
        REGIONS.extend(local_regions)
        for e in [e for e in M.EDGES if e["from"] == self.sid]:
            e["groupId"] = self.sid+"--"+e["groupId"]
            EDGES.append(e)
        output = HERE / "screens" / (self.sid+".svg")
        saved = self.save(output)
        SCENES.append({**self.meta, "composition": composition, "svg": "screens/"+output.name,
                       "svgSha256": saved["sha256"], "state": self.state,
                       "containers": self.containers})


def child_rows(cv, states, y=385):
    cols = [("Task / expected result", 356), ("State", 798), ("Agent", 950), ("Depends on", 1118)]
    cv.rect(340, y-32, 890, 32, "#151515", C["BORDER"], 6)
    for label, x in cols:
        cv.txt(x, y-11, label, 11, C["MUT"], 500)
    children = [
        ("T-084.1", "Investigate the reported issue", "Diagnosis with sources", "Research agent", "Context"),
        ("T-084.2", "Summarize relevant knowledge", "Customer-ready brief", "Knowledge agent", "Context"),
        ("T-084.3", "Find a meeting time", "Checked time options", "Calendar agent", "Context"),
        ("T-084.4", "Draft the customer reply", "Reply + linked evidence", "Writing agent", ".1 + .2 + .3"),
    ]
    for i, ((key, title, result, agent, dep), state) in enumerate(zip(children, states)):
        yy = y+i*78
        gid="child-task-"+str(i+1)
        with cv.group(gid):
            cv.rect(340, yy, 890, 78, "#080808", C["BORDER"], 4)
            cv.txt(356, yy+22, key+"  "+title, 13, weight=500)
            cv.txt(356, yy+47, result, 12, C["MUT"])
            cv.txt(798, yy+27, state, 12, AMBER if "input" in state else GREEN if state == "Complete" else C["FG"])
            cv.txt(950, yy+27, agent, 12)
            cv.txt(1118, yy+27, dep, 11, C["MUT"])
        target="R8-T06" if cv.sid=="R8-T05" and i==2 else None
        cv.action(gid,[340,yy,890,78],"Open "+key,target,
                  "history-read" if target else "out-of-slice",
                  "Read the later recorded child-task decision and assignment; opening it starts no work." if target else "Open this child within the same parent context; full child-detail variants remain outside the bounded source journey.")


def capture():
    cv = Page("R8-T01", "Capture an outcome", "Capture is local-first. Main example creates T-084; Save for later starts nothing. Inputs and results are fictional design fixtures.", {"execution": "none", "capture": "draft"}, intake=True)
    cv.panel("capture-composer", 340, 204, 860, 315, "#111111", "#303030")
    cv.txt(360, 236, "What needs doing?", 14, weight=600)
    cv.lines("outcome-input", 360, 276, "Prepare the customer follow-up: investigate their issue, summarize our knowledge, propose a meeting time, and draft the reply.", 818, 18, leading=29)
    cv.action("outcome-input", [356, 252, 824, 123], "Desired outcome", kind="fixture-edit", effect="Editable design text; no functional prototype input is claimed.")
    cv.txt(360, 402, "Attached context", 12, C["MUT"])
    cv.txt(360, 430, "Customer email.eml     Incident note.md     Availability.txt", 13)
    cv.txt(360, 458, "Assign automatically · Research and drafts only", 12, C["MUT"])
    cv.btn("capture-later", 780, 471, 170, "Save for later", "R8-T02", kind="fixture-transition", effect="Create durable local T-084 in Needs analysis; no turn, child task or external action starts.")
    cv.btn("capture-analyze", 962, 471, 218, "Capture and analyze", "R8-T03", True, kind="fixture-transition", effect="Create durable T-084 once and admit analysis under the displayed research-and-draft policy; do not send or schedule.")
    cv.panel("capture-options", 1220, 204, 360, 315)
    cv.txt(1240, 236, "Capture settings", 14, weight=600)
    for i, (label, value) in enumerate([("Area", "Customer operations"), ("Human owner", "Mara · you"),
                                      ("Assignment", "Auto · research and drafts"), ("Deadline / budget", "Optional · not set")]):
        cv.txt(1240, 277+i*55, label, 12, C["MUT"])
        cv.txt(1240, 299+i*55, value, 13)
    cv.txt(340, 561, "New arrivals", 16, weight=600)
    for i, (title, source, status) in enumerate([
        ("Customer follow-up", "Pasted email + note", "Draft above"),
        ("Review the launch brief", "Local action item", "Needs analysis"),
        ("Summarize the supplied note", "Local note · simple task", "Direct path"),
    ]):
        yy=581+i*70
        cv.rect(340, yy, 1240, 70, "#080808", C["BORDER"], 4)
        cv.txt(356, yy+26, title, 14, weight=500)
        cv.txt(356, yy+49, source, 12, C["MUT"])
        cv.txt(1562, yy+33, status, 12, C["MUT"], anchor="end")
    cv.txt(340, 829, "Local capture works without a tracker or repository. Connected sources can feed this same queue.", 13, C["MUT"])
    cv.finish("intake-composer")


def saved():
    cv = Page("R8-T02", "Saved task · needs analysis", "T-084 exists independently of a source, provider turn or workflow. Capture-only is a genuine non-executing path.", {"execution": "Not started", "status": "needs-analysis"})
    cv.status("Needs analysis", "Saved locally · no agent started")
    cv.panel("saved-brief", 340, 288, 890, 350)
    cv.txt(360, 320, "Desired outcome", 15, weight=600)
    cv.lines("saved-goal", 360, 356, "Investigate the customer's issue, summarize what we know, propose a meeting time, and draft a reply.", 840, 18, leading=28)
    cv.txt(360, 454, "Context", 12, C["MUT"])
    cv.txt(360, 480, "Customer email.eml · Incident note.md · Availability.txt", 14)
    cv.txt(360, 535, "A useful result", 12, C["MUT"])
    cv.lines("completion-criteria", 360, 563, "A supported explanation, a concise brief, checked meeting options, and a customer-ready reply.", 840, 14, leading=22)
    cv.right()
    cv.btn("analyze-saved", 340, 674, 170, "Analyze task", "R8-T03", True, kind="fixture-transition", effect="Admit analysis for existing T-084 under research-and-draft scope; preserve the original capture and identity.")
    cv.btn("edit-brief", 522, 674, 132, "Edit brief", kind="fixture-edit", effect="Local source text remains editable; no persistence is simulated.")
    cv.txt(340, 758, "Recent activity", 14, weight=600)
    cv.txt(340, 792, "10:12  Mara captured the task · Saved for later", 13, C["MUT"])
    cv.finish("task-detail-saved")


def analysis():
    cv = Page("R8-T03", "Analysis · a focused question", "The task stays T-084. One missing fact pauses the dependent calendar work; the policy permits useful investigation and drafting within scope.", {"execution": "Analyzing", "status": "needs-context", "question": "customer-timezone"}, True)
    cv.status("Analyzing · one detail needed", "Research and drafts are allowed · no email or calendar changes")
    cv.phase("Investigate")
    cv.panel("analysis-message", 340, 342, 890, 168)
    cv.txt(360, 372, "Factory", 13, weight=600)
    cv.lines("analysis-result", 360, 407, "I found four useful pieces of work. The incident note and supplied email support the investigation; meeting options need the customer's time zone.", 840, 16, leading=25)
    cv.txt(360, 487, "Research and the knowledge summary can proceed while this detail is clarified.", 12, C["MUT"])
    cv.panel("context-question", 340, 530, 890, 212)
    cv.txt(360, 562, "Which time zone should I use?", 16, weight=600)
    cv.field("timezone-answer", 360, 588, 820, "Customer time zone", "America/Los_Angeles · supplied by Mara", h=38)
    cv.btn("answer-context", 988, 690, 192, "Use this and continue", "R8-T04", True, kind="fixture-transition", effect="Record the supplied time zone against T-084 and continue analysis; no external side effect.")
    cv.right()
    cv.txt(340, 796, "Original request and attachments stay available in the task history.", 13, C["MUT"])
    cv.finish("task-analysis-question")


def plan():
    cv = Page("R8-T04", "A plan that can run", "These are durable proposed child tasks, not provider-native children started twice. The current policy permits automatic analysis/drafts; external actions remain outside it.", {"execution": "Ready to delegate", "status": "plan-ready", "planRevision": 1})
    cv.status("Plan ready · 4 child tasks", "Three independent inputs → one assembled reply · Auto assignment")
    cv.phase("Plan")
    child_rows(cv, ["Ready", "Ready", "Ready", "Waiting"], 390)
    cv.right("How this will run")
    cv.txt(340, 744, "Continue automatically within Research and drafts", 14, weight=500)
    cv.txt(340, 771, "Each child returns evidence. The factory reconciles the result before review.", 13, C["MUT"])
    cv.btn("continue-with-policy", 340, 812, 216, "View running tasks", "R8-T05", True, kind="history-read", effect="Open the later running state. The displayed standing policy, not this navigation click, authorizes admission of ready children; no per-child approval gate.")
    cv.btn("adjust-plan", 568, 812, 138, "Adjust plan", kind="fixture-edit", effect="A plan edit needs a new revision and dependency re-evaluation before new dispatches; existing attempt ownership is retained.")
    cv.finish("task-child-plan")


def running():
    cv = Page("R8-T05", "Delegated work in progress", "Assignments are fictional admission fixtures. A selected model does not move the workspace. Waiting children start only after their explicit dependencies are satisfied.", {"execution": "Working", "status": "working", "planRevision": 1, "completeChildren": 1}, True)
    cv.status("Working · 1 of 4 child tasks complete", "Two agents working · reply waits for the evidence and meeting options")
    cv.phase("Act")
    child_rows(cv, ["Working", "Complete", "Working", "Waiting"], 390)
    cv.right("Automatic assignment")
    cv.txt(340, 744, "Latest result", 14, weight=600)
    cv.txt(340, 773, "Knowledge brief is ready · 3 supplied sources · one open assumption", 13, C["MUT"])
    cv.btn("open-decision", 340, 812, 212, "Open task decision", "R8-T06", True, kind="history-read", effect="Open the later recorded decision state; navigation itself does not manufacture progress or request a stop.")
    cv.btn("pause-task", 564, 812, 140, "Pause new work", kind="out-of-slice", effect="Pause future admissions only; running attempts remain visible until completion or acknowledged/fenced stop.")
    cv.finish("task-running-children")


def decision():
    cv = Page("R8-T06", "Needs your decision · observed attempts", "A stop request is not Stopped. The old attempt keeps its claim until acknowledgement or fencing. Choosing a meeting time does not authorize sending or scheduling.", {"execution": "Waiting for input", "status": "needs-decision", "stopState": "requested-not-acknowledged", "planRevision": 1}, True)
    cv.status("Needs your decision · choose a meeting time", "Research results are saved · an older calendar attempt is still stopping", AMBER)
    cv.panel("meeting-choice", 340, 288, 860, 278)
    cv.txt(360, 321, "Both options fit the supplied availability", 16, weight=600)
    cv.txt(360, 355, "Customer: America/Los_Angeles · 30 minutes", 13, C["MUT"])
    cv.rect(360, 378, 820, 54, "#121c30", "#34578e", 6)
    cv.txt(378, 410, "●  Thursday 12 Nov · 2:30–3:00 pm PST", 14, weight=500)
    cv.rect(360, 444, 820, 54, "#080808", C["BORDER"], 6)
    cv.txt(378, 476, "○  Friday 13 Nov · 10:00–10:30 am PST", 14)
    cv.txt(360, 540, "This selects the proposal; it does not create an event.", 12, C["MUT"])
    cv.panel("attempt-detail", 1220, 288, 360, 500)
    cv.txt(1240, 319, "T-084.3 · execution details", 14, weight=600)
    for i, (key,value) in enumerate([
        ("Harness / model", "Codex / GPT-6.1 Sol"),
        ("Execution environment", "Ops node · linked T3 environment"),
        ("Assignment", "Auto · admitted before launch"),
        ("Attempt", "Attempt 1 · stop requested"),
        ("Observed state", "Awaiting executor acknowledgement"),
    ]):
        cv.txt(1240, 356+i*57, key, 12, C["MUT"])
        cv.txt(1240, 378+i*57, value, 12, AMBER if i==4 else C["FG"])
    cv.rule(1240, 650, 320)
    cv.lines("replacement-fence", 1240, 680, "Replacement is held. A disconnect or timeout does not prove the old worker stopped.", 310, 13, C["MUT"], leading=21)
    cv.panel("saved-results", 340, 588, 860, 150)
    cv.txt(360, 620, "Results already available", 14, weight=600)
    cv.txt(360, 652, "✓ Diagnosis with sources     ✓ Customer knowledge brief", 13, GREEN)
    cv.txt(360, 686, "Reply draft waits for this choice. Other results are preserved.", 13, C["MUT"])
    cv.btn("choose-meeting", 340, 812, 210, "Use Thursday and continue", "R8-T07", True, kind="fixture-transition", effect="Record Thursday as the proposal. The destination is a later fictional state after stop acknowledgement and dependent drafting complete; this click alone is not stop acknowledgement or external authority.")
    cv.txt(570, 833, "Review follows after the remaining work completes.", 12, C["MUT"])
    cv.finish("task-decision-attempt-detail")


def review():
    cv = Page("R8-T07", "Review the assembled outcome", "Preparation and observed worker completion precede this later review fixture. The optional external actions are reviewed here; no live connector or send is implemented.", {"execution": "Complete", "status": "ready-for-review", "stopState": "acknowledged", "planRevision": 1})
    cv.status("Ready to review · all 4 child results assembled", "One supported outcome · drafts are prepared · no external actions taken", GREEN)
    cv.panel("assembled-result", 340, 288, 720, 276)
    cv.txt(360, 320, "Customer follow-up", 17, weight=600)
    cv.lines("result-summary", 360, 357, "The refresh interruption matches the supplied incident note. The response explains the recovery step and links the evidence; the meeting proposal uses the confirmed time zone.", 674, 15, leading=23)
    for i,(name,detail) in enumerate([
        ("Diagnosis.md", "2 evidence links · assumption stated"),
        ("Customer brief.md", "3 supplied sources · reviewed summary"),
        ("Reply.eml + Meeting proposal", "Draft only · Thursday 12 Nov, 2:30 pm PST"),
    ]):
        yy=460+i*29
        cv.txt(360, yy, name, 13, weight=500)
        cv.txt(1040, yy, detail, 11, C["MUT"], anchor="end")
    cv.panel("reply-preview", 340, 584, 720, 178)
    cv.txt(360, 616, "Reply preview", 14, weight=600)
    cv.lines("reply-body", 360, 649, "Hi Alex — the incident note says interrupted refreshes keep the last complete index. Please retry refresh and share the trace if it happens again.\nWould Thursday 12 Nov at 2:30 pm PST work for a 30-minute follow-up?\nSources: Incident note.md §2; Customer email.eml.", 672, 14, leading=22)
    cv.panel("external-review", 1080, 288, 500, 474)
    cv.txt(1100, 320, "Optional actions · review before approval", 15, weight=600)
    rows = [("Email", "To: alex@example.test", "Subject: Search refresh follow-up"),
            ("Calendar hold", "Mara only · no customer invitation", "12 Nov 2026 · 2:30–3:00 pm PST")]
    for i,(label,a,b) in enumerate(rows):
        yy=360+i*116
        cv.txt(1100, yy, "☑  "+label, 14, weight=500)
        cv.txt(1100, yy+29, a, 13)
        cv.txt(1100, yy+53, b, 12, C["MUT"])
    cv.rule(1100, 586, 460)
    cv.lines("approval-boundary", 1100, 616, "Approve exactly this reply and this private hold. Any changed recipient, content or time needs another review.", 450, 13, C["MUT"], leading=21)
    cv.btn("accept-preparation", 340, 812, 226, "Accept preparation only", kind="out-of-slice", effect="Accept the prepared outcome and complete T-084 without sending email or changing a calendar. Preserve the draft artifacts and distinct action states.")
    cv.btn("approve-external", 1270, 812, 310, "Accept + approve actions", "R8-T08", True, kind="fixture-transition", effect="Accept the assembled outcome revision and separately approve the exact reviewed email and private calendar hold. Record acceptance accept-084-1 and action approval approval-084-1 separately. The destination is later confirmed fictional receipts, never evidence that approval alone completed an external write.")
    cv.txt(340, 796, "Worker stop acknowledged · evidence retained · source content unchanged", 12, C["MUT"])
    cv.finish("task-assembled-review")


def completed():
    cv = Page("R8-T08", "Completed outcome · observed receipts", "All receipt IDs, times and outputs are fictional. Approval, confirmed action results and task completion are distinct milestones; this fixture illustrates the later observed result.", {"execution": "Complete", "status": "completed", "acceptance": "accepted", "delivery": "confirmed-fixture", "planRevision": 1})
    cv.status("Completed · follow-up prepared and approved actions confirmed", "T-084 retains the original request, child tasks, evidence and receipts", GREEN)
    cv.panel("completed-result", 340, 288, 890, 204)
    cv.txt(360, 321, "Outcome", 15, weight=600)
    cv.lines("completed-summary", 360, 358, "The customer reply is sent. A private meeting hold is on Mara's calendar; the customer has not been invited. The diagnosis, brief and draft remain attached.", 834, 16, leading=25)
    cv.txt(360, 461, "Accepted by Mara · accept-084-1 · actions approved by approval-084-1", 12, C["MUT"])
    cv.panel("action-receipts", 340, 512, 890, 194)
    cv.txt(360, 544, "Observed action results", 14, weight=600)
    cv.txt(360, 582, "✓  Email sent", 14, GREEN, 500)
    cv.txt(1210, 582, "mail-receipt-084 · 10:24 · approved content", 12, C["MUT"], anchor="end")
    cv.txt(360, 622, "✓  Private calendar hold created", 14, GREEN, 500)
    cv.txt(1210, 622, "event-084 · 12 Nov, 2:30 pm PST", 12, C["MUT"], anchor="end")
    cv.txt(360, 674, "4 child tasks complete · stop acknowledged · no unobserved write is marked successful", 12, C["MUT"])
    cv.panel("completion-options", 1250, 288, 330, 418)
    cv.txt(1270, 320, "Continue from the result", 14, weight=600)
    cv.lines("workflow-promotion", 1270, 357, "This plan worked. Save a reusable workflow when you want the same outcome again.", 282, 14, C["MUT"], leading=22)
    cv.btn("save-workflow", 1270, 438, 224, "Save as workflow…", kind="out-of-slice", effect="Propose a parameterized version of this successful plan. Saving alone grants no standing authority or automatic activation.")
    cv.btn("reopen-task", 1270, 490, 166, "Reopen task", kind="out-of-slice", effect="Reopen T-084 without replaying any external action or erasing prior receipts.")
    cv.lines("settlement-boundary", 1270, 567, "Reopen to add follow-up work. Existing results and action history stay attached.", 282, 12, C["MUT"], leading=20)
    cv.txt(340, 748, "Artifacts", 14, weight=600)
    cv.txt(340, 778, "Diagnosis.md     Customer brief.md     Reply.eml     Meeting proposal", 13, C["MUT"])
    cv.btn("new-capture", 340, 822, 164, "Capture another task", kind="out-of-slice", effect="Open a fresh unassigned draft variant before wiring. Never return to the T-084 capture fixture: T-084 remains completed with its prior receipts and no action is replayed.")
    cv.finish("task-completed-receipts")


def validate():
    issues, counts = [], []
    for scene in SCENES:
        root = ET.parse(HERE/scene["svg"]).getroot()
        groups = [el.get("id") for el in root.iter() if el.tag.endswith("g")]
        if len(groups) != len(set(groups)):
            issues.append({"screen":scene["id"],"kind":"duplicate-group"})
        boxes=[]
        for el in root.iter():
            if el.tag.endswith("image"):
                issues.append({"screen":scene["id"],"kind":"raster-node"})
            if not el.tag.endswith("text"):
                continue
            text=el.text or ""; size=int(el.get("font-size")); weight=int(el.get("font-weight"))
            ink=K.font(size,weight).getbbox(text,anchor="ls")
            x,y=float(el.get("x")),float(el.get("y"))
            width=K.text_width(text,size,weight)
            if el.get("text-anchor")=="end": x-=width
            if el.get("text-anchor")=="middle": x-=width/2
            b=[x+ink[0],y+ink[1],x+ink[2],y+ink[3]]
            if b[0]<0 or b[1]<0 or b[2]>1600 or b[3]>1040 or (y<900 and b[3]>900):
                issues.append({"screen":scene["id"],"kind":"text-bounds","text":text,"box":b})
            boxes.append((text,b))
        for i,(a,ba) in enumerate(boxes):
            for b,bb in boxes[i+1:]:
                if min(ba[2],bb[2])-max(ba[0],bb[0])>1 and min(ba[3],bb[3])-max(ba[1],bb[1])>1:
                    issues.append({"screen":scene["id"],"kind":"text-overlap","a":a,"b":b})
        controls=[r for r in REGIONS if r["screen"]==scene["id"]]
        for r in controls:
            x,y,w,h=r["box"]
            if r["groupId"] not in groups or x<0 or y<0 or x+w>1600 or y+h>900:
                issues.append({"screen":scene["id"],"kind":"control-bounds-or-group","control":r["groupId"]})
        counts.append({"screen":scene["id"],"textNodes":len(boxes),"controls":len(controls)})
    for e in EDGES:
        if e["to"] not in {s["id"] for s in SCENES}:
            issues.append({"kind":"missing-destination","edge":e["id"]})
    result={"status":"PASS" if not issues else "NEEDS_CORRECTION","scenes":counts,"issues":issues,
            "method":"XML parse; unique groups; native text/raster scan; Inter PIL ink bounds and pair overlaps; control/group and destination existence.",
            "limits":"Static design-source geometry only. No native import, actual pointer journey, interactive input, persistence, connector, runtime, mobile or accessibility proof."}
    write_json(HERE/"validation.json",result)
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--render",action="store_true",help="Render authored SVGs with local rsvg-convert; never opens a browser.")
    args=parser.parse_args()
    (HERE/"screens").mkdir(exist_ok=True)
    capture();saved();analysis();plan();running();decision();review();completed()
    result=validate()
    action_envelope={"taskRef":TASK,"planRevision":1,
                     "email":{"to":["alex@example.test"],"subject":"Search refresh follow-up",
                              "body":"Hi Alex — the incident note says interrupted refreshes keep the last complete index. Please retry refresh and share the trace if it happens again.\nWould Thursday 12 Nov at 2:30 pm PST work for a 30-minute follow-up?\nSources: Incident note.md §2; Customer email.eml."},
                     "calendar":{"owner":"Mara","title":"Customer follow-up · private hold","start":"2026-11-12T14:30:00-08:00","end":"2026-11-12T15:00:00-08:00","timeZone":"America/Los_Angeles","attendees":[],"visibility":"private"}}
    envelope_hash=hashlib.sha256(json.dumps(action_envelope,sort_keys=True,ensure_ascii=False,separators=(",",":")).encode("utf-8")).hexdigest()
    manifest={"schema":"t3factory-task-journey-design/1","status":"EDITABLE_SOURCE_ONLY",
              "appHeight":900,"taskIdentity":"Proposed local task identity; not a claim that a universal TaskRef contract is implemented.",
              "scenes":SCENES,"controls":REGIONS,"edges":EDGES,
              "scopeFixture":{"id":"policy-research-drafts-01","owner":"Mara","automaticAdmissions":["read supplied context","research","summarize","propose","draft","independent review"],"externalWrites":[],"runtimeAuthority":"ILLUSTRATIVE_ONLY"},
              "children":[
                  {"id":"local-084-1","displayId":"T-084.1","parentId":"local-084","role":"Research agent","dependsOn":[],"output":"Diagnosis.md","harness":"Codex","model":"GPT-6.1 Sol","environment":"Workstation","attempt":1},
                  {"id":"local-084-2","displayId":"T-084.2","parentId":"local-084","role":"Knowledge agent","dependsOn":[],"output":"Customer brief.md","harness":"Claude Code","model":"Sonnet 5.5","environment":"Workstation","attempt":1},
                  {"id":"local-084-3","displayId":"T-084.3","parentId":"local-084","role":"Calendar agent","dependsOn":[],"output":"Meeting proposal","harness":"Codex","model":"GPT-6.1 Sol","environment":"Ops node","attempt":1,"replacementWhileStopPending":"held"},
                  {"id":"local-084-4","displayId":"T-084.4","parentId":"local-084","role":"Writing agent","dependsOn":["local-084-1","local-084-2","local-084-3"],"output":"Reply.eml","harness":"Claude Code","model":"Sonnet 5.5","environment":"Workstation","attempt":1}
              ],
              "journeys":{"captureAndAnalyze":["R8-T01","R8-T03","R8-T04","R8-T05","R8-T06","R8-T07","R8-T08"],
                          "saveForLater":["R8-T01","R8-T02","R8-T03"],
                          "simpleDirect":{"path":["R8-T01","R8-T03","R8-T07","R8-T08"],"status":"SEMANTIC_BRANCH_SPECIFIED_NOT_RENDERED_AS_SEPARATE_FIXTURES","input":"Summarize the supplied note","omittedPhases":["Deep-dive","Architect","Plan"],"childTasks":[],"externalActions":[],"requiresDistinctInputAndResultVariantsBeforeNativeWiring":True}},
              "externalActions":{"default":"Research and drafts only","optionalReviewedActions":["Send exactly the reviewed reply to alex@example.test","Create a private hold on Mara's calendar; no customer invite"],"approvalDoesNotProveSuccess":True,"unknownOutcomePolicy":"Retain intent; reconcile observed state before any resend."},
              "reviewedActionEnvelope":{"payload":action_envelope,"sha256":envelope_hash,"canonicalization":"UTF-8 JSON, sorted keys, compact separators, unescaped Unicode","acceptanceFixture":"accept-084-1","approvalFixture":"approval-084-1","receiptFixtures":["mail-receipt-084","event-084"],"allValuesFictional":True},
              "qualification":{"staticGeometry":result["status"],"figmaImport":"UNRUN","prototypeWiring":"UNRUN","runtime":"UNIMPLEMENTED_DESIGN_FIXTURE","mobile":"UNQUALIFIED","accessibility":"UNQUALIFIED"},
              "sourcePatterns":["../../round-07-optional-linear/build/build_optional_linear.py","../../round-05/build/native_svg.py","../../round-05/build/build_workspace.py"]}
    write_json(HERE/"scene-manifest.json",manifest)
    if result["issues"]:
        print(json.dumps(result,ensure_ascii=False,indent=2))
        raise SystemExit(1)
    rendered=[]
    if args.render:
        (HERE/"previews").mkdir(exist_ok=True)
        for scene in SCENES:
            png=HERE/"previews"/(scene["id"]+".png")
            subprocess.run(["rsvg-convert","-o",str(png),str(HERE/scene["svg"])],check=True,capture_output=True)
            rendered.append(png.name)
    print(json.dumps({"scenes":len(SCENES),"controls":len(REGIONS),"wiredSourceEdges":len(EDGES),"geometry":result["status"],"pngsRendered":rendered},indent=2))


if __name__=="__main__":
    main()
