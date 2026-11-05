"""Additive, fictional editable task-return design sources; never app behavior."""

from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
DESIGN = HERE.parents[1]
R8_HOME = DESIGN / "round-08-task-loop"
SPEC = importlib.util.spec_from_file_location("r8_source_definitions", R8_HOME / "task-journey/build.py")
R8 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R8)
M, K, C = R8.M, R8.K, R8.C
SCENES, REGIONS, EDGES = [], [], []
GREEN, AMBER = "#74c69d", "#e8bf78"
TASK084 = dict(R8.TASK)
TASK085 = {"environmentId": "env-demo", "projectId": "customer-ops", "id": "local-085", "displayId": "T-085"}
CHILD084 = {**TASK084, "id": "local-084-2", "displayId": "T-084.2"}
NOTE = "Refresh can be interrupted without losing the last complete index. Retry the refresh once. If it repeats, capture the trace and send it to support. We have not confirmed what caused the interruption."
SUMMARY = "An interrupted refresh keeps the last complete index. Retry once; if it happens again, capture the trace for support. The cause is still unconfirmed."
BRIEF = "The supplied incident note says an interrupted refresh keeps the last complete index. Ask Alex to retry the refresh once, then share a trace if the interruption repeats. The customer email reports the interruption but does not establish its cause. A follow-up can check recovery; no customer invitation has been sent."
REPLY = "Hi Alex — the incident note says interrupted refreshes keep the last complete index. Please retry refresh and share the trace if it happens again.\nWould Thursday 12 Nov at 2:30 pm PST work for a 30-minute follow-up?\nSources: Incident note.md §2; Customer email.eml."


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def r8_binding():
    return {p.relative_to(DESIGN).as_posix(): sha(p) for p in sorted(R8_HOME.rglob("*")) if p.is_file()}


class Page(M.Canvas):
    def __init__(self, sid, title, caption, task, state, section="Work", active=None):
        super().__init__(sid, title, caption, section=section)
        REGIONS[:] = [r for r in REGIONS if r["screen"] != sid]
        EDGES[:] = [e for e in EDGES if e["from"] != sid]
        self.state = {"taskRef": task, "startsWorkOnOpen": False, **state}
        self.containers = []
        for el in self.svg.iter():
            if el.tag.endswith("text") and el.text == "T3 Code":
                el.text = "T3 Factory"
            if el.tag.endswith("text") and el.text == "No active turns" and active:
                el.text = active
            if el.tag.endswith("text") and el.get("x") == "300" and el.get("y") == "614":
                el.text = "1" if active else "0"
            if el.tag.endswith("text") and el.text and el.text.startswith("PROPOSED DESIGN"):
                el.text = "PROPOSED / FICTIONAL · Editable source · No runtime, native, connector, mobile or accessibility proof"
        if task is None:
            crumb, heading, subtitle = "Intake  /  Unassigned draft", "What needs doing?", "Save useful context first. No agent starts just by opening this draft."
        elif task["id"] == "local-085":
            crumb, heading, subtitle = "Customer operations  /  T-085", "Summarize the supplied note", "Mara · Local input · One concise summary"
        elif task["id"] == "local-084-2":
            crumb, heading, subtitle = "T-084  /  T-084.2  /  Completed child", "Customer knowledge brief", "Read-only result · Original parent: completed T-084 with action receipts"
        else:
            crumb, heading, subtitle = "Customer operations  /  T-084", "Prepare the customer follow-up", "Mara · Local task · Customer thread + incident note"
        self.txt(340, 133, crumb, 12, C["MUT"])
        self.txt(340, 165, heading, 22, weight=600)
        self.txt(340, 190, subtitle, 12, C["MUT"])
        for label, x, w in [("Work", 340, 72), ("Intake", 416, 76), ("Workflows", 496, 110), ("More", 610, 70)]:
            self.action("nav-" + label.lower(), [x, 56, w, 34], label, kind="out-of-slice", effect="Workspace navigation is outside this bounded source journey; no task action or state change.")

    def action(self, group, box, label, target=None, kind="navigate", effect="", **extra):
        REGIONS.append({"screen": self.sid, "groupId": group, "box": box, "label": label, "target": target, "kind": kind, "effect": effect, **extra})
        if target:
            EDGES.append({"id": self.sid + "--" + group, "from": self.sid, "to": target, "groupId": group, "box": box, "kind": kind, "effect": effect})

    def panel(self, gid, x, y, w, h):
        with self.group(gid):
            self.rect(x, y, w, h, "#0b0b0b", C["BORDER"], 8)
        self.containers.append({"id": gid, "box": [x, y, w, h]})

    def status(self, label, hint, color=C["BLUE"]):
        self.rect(340, 214, 1240, 54, "#10141c", "#283244", 8)
        self.el("circle", cx=358, cy=241, r=4, fill=color)
        self.txt(374, 239, label, 14, weight=600)
        self.txt(374, 258, hint, 12, C["MUT"])

    def finish(self, composition):
        for el in self.svg.iter():
            if el.tag.endswith("g") and el.get("id"):
                el.set("id", self.sid + "--" + el.get("id"))
        for r in REGIONS:
            if r["screen"] == self.sid:
                r["groupId"] = self.sid + "--" + r["groupId"]
        for e in EDGES:
            if e["from"] == self.sid:
                e["groupId"] = self.sid + "--" + e["groupId"]
        output = HERE / "screens" / (self.sid + ".svg")
        saved = self.save(output)
        SCENES.append({**self.meta, "composition": composition, "svg": "screens/" + output.name, "svgSha256": saved["sha256"], "state": self.state, "containers": self.containers})


def mixed_review():
    cv = Page("R9-T01", "Review the assembled outcome", "R9 contextual copy of R8-T07. Two alternate fictional histories begin here: preparation acceptance, or separate acceptance + action approval followed by later observed receipts.", TASK084, {"historyBranch": "mixed-review-fork", "execution": "Complete", "status": "ready-for-review", "resultRevision": 1, "stopState": "acknowledged", "planRevision": 1})
    cv.status("Ready to review · all 4 child results assembled", "One supported outcome · drafts are prepared · no external actions taken", GREEN)
    cv.panel("assembled-result", 340, 288, 720, 276)
    cv.txt(360, 320, "Customer follow-up", 17, weight=600)
    cv.lines("result-summary", 360, 357, "The refresh interruption matches the supplied incident note. The response explains the recovery step and links the evidence; the meeting proposal uses the confirmed time zone.", 674, 15, leading=23)
    for i, (name, detail) in enumerate([("Diagnosis.md", "2 evidence links · assumption stated"), ("Customer brief.md", "3 supplied sources · reviewed summary"), ("Reply.eml + Meeting proposal", "Draft only · Thu 12 Nov, 2:30 pm PST")]):
        yy = 460 + i * 29
        cv.txt(360, yy, name, 13, weight=500)
        cv.txt(1040, yy, detail, 11, C["MUT"], anchor="end")
    cv.panel("reply-preview", 340, 584, 720, 178)
    cv.txt(360, 616, "Reply preview", 14, weight=600)
    cv.lines("reply-body", 360, 649, REPLY, 672, 14, leading=22)
    cv.panel("external-review", 1080, 288, 500, 474)
    cv.txt(1100, 320, "Optional actions · review before approval", 15, weight=600)
    for i, (label, a, b) in enumerate([("Email", "To: alex@example.test", "Subject: Search refresh follow-up"), ("Calendar hold", "Mara only · no customer invitation", "12 Nov 2026 · 2:30–3:00 pm PST")]):
        yy = 360 + i * 116
        cv.txt(1100, yy, "✓  " + label, 14, weight=500)
        cv.txt(1100, yy + 29, a, 13)
        cv.txt(1100, yy + 53, b, 12, C["MUT"])
    cv.txt(1100, 553, "Title: Customer follow-up · private hold", 12, C["MUT"])
    cv.rule(1100, 586, 460)
    cv.lines("approval-boundary", 1100, 616, "Approve exactly this reply and this private hold. Any changed recipient, content or time needs another review.", 450, 13, C["MUT"], leading=21)
    cv.txt(340, 790, "Preparation acceptance settles drafts only; it does not claim delivery.", 12, C["MUT"])
    cv.btn("accept-preparation", 340, 812, 226, "Accept preparation only", "R9-T02", kind="fixture-transition", effect="Accept exact mixed revision 1 as preparation only under accept-084-prep-1. Narrow settlement to prepared artifacts; no action approval, send, calendar change or receipt.")
    cv.btn("approve-external", 1270, 812, 310, "Accept + approve actions", "R9-T03", True, kind="fixture-transition", effect="Record separate original accept-084-1 and approval-084-1 for the unchanged exact R8 action envelope. Read a later fictional confirmed-receipt fixture; approval alone does not establish success.")
    cv.finish("task-assembled-review-context-copy")


def preparation_accepted():
    cv = Page("R9-T02", "Preparation accepted · drafts retained", "Alternate preparation-only history. This branch never contains approval-084-1 or sent/held receipts. No fixed Back control enters the action-completed branch.", TASK084, {"historyBranch": "mixed-preparation-only", "execution": "Complete", "status": "preparation-accepted", "acceptedRevision": 1, "acceptanceId": "accept-084-prep-1", "actionApproval": None, "actionReceipts": [], "settlement": "prepared-artifacts-only"})
    cv.status("Preparation accepted", "Email: not sent · Calendar: not changed · drafts remain attached", GREEN)
    cv.panel("accepted-preparation", 340, 288, 820, 270)
    cv.txt(360, 323, "Prepared outcome · revision 1", 17, weight=600)
    cv.lines("prepared-summary", 360, 362, "Diagnosis, knowledge brief, customer reply and meeting proposal are accepted as prepared work. Sending and scheduling were not part of this acceptance.", 770, 16, leading=25)
    cv.txt(360, 478, "Mara accepted · accept-084-prep-1", 13, C["MUT"])
    cv.txt(360, 514, "Accepted outcome narrowed to preparation. Delivery is not claimed.", 13, C["MUT"])
    cv.panel("drafts-retained", 340, 580, 820, 176)
    cv.txt(360, 614, "Retained artifacts", 15, weight=600)
    cv.txt(360, 653, "Diagnosis.md     Customer brief.md", 14)
    cv.txt(360, 690, "Reply.eml · draft     Meeting proposal · draft", 14)
    cv.txt(360, 728, "No new agent attempt or external action", 12, C["MUT"])
    cv.panel("unperformed-actions", 1180, 288, 400, 468)
    cv.txt(1200, 323, "External actions", 15, weight=600)
    cv.txt(1200, 368, "Email", 13, C["MUT"])
    cv.txt(1200, 397, "Not sent", 17, weight=600)
    cv.txt(1200, 454, "Calendar", 13, C["MUT"])
    cv.txt(1200, 483, "Not changed", 17, weight=600)
    cv.lines("later-action-boundary", 1200, 548, "A later action needs its current reply, recipient or time reviewed and approved separately.", 350, 14, C["MUT"], leading=23)
    cv.btn("new-task", 340, 812, 160, "New task", "R9-T05", True, kind="navigate", effect="Leave accepted preparation retained. Open unassigned draft; no task identity or work is created by navigation.")
    cv.txt(526, 833, "T-084 stays accepted as preparation only.", 13, C["MUT"])
    cv.finish("task-preparation-accepted")


def completed():
    cv = Page("R9-T03", "Completed outcome · observed receipts", "R9 contextual copy of R8-T08, using original accept-084-1, approval-084-1, mail-receipt-084 and event-084. All values and observed outcomes are fictional.", TASK084, {"historyBranch": "mixed-original-actions", "execution": "Complete", "status": "completed", "acceptedRevision": 1, "acceptanceId": "accept-084-1", "approvalId": "approval-084-1", "actionReceipts": ["mail-receipt-084", "event-084"], "settlement": "closed"})
    cv.status("Completed · follow-up prepared and approved actions confirmed", "Original T-084 history · revision 1 accepted · receipts retained", GREEN)
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
    cv.txt(360, 674, "4 child tasks complete · stop acknowledged · no unknown write marked successful", 12, C["MUT"])
    cv.panel("continue-options", 1250, 288, 330, 418)
    cv.txt(1270, 320, "Continue from the result", 14, weight=600)
    cv.lines("reopen-hint", 1270, 358, "Reopen to describe further work on this outcome. Prior acceptance and action history remain intact.", 280, 14, C["MUT"], leading=23)
    cv.btn("reopen-task", 1270, 470, 170, "Reopen task", "R9-T04", True, kind="fixture-transition", effect="Reopen the same T-084 as idle. Preserve acceptance, all child results and receipts; start no attempt, reset no child, replay no action.")
    cv.txt(340, 748, "Artifacts and completed children", 14, weight=600)
    cv.txt(340, 778, "Diagnosis.md     Customer brief.md     Reply.eml     Meeting proposal", 13, C["MUT"])
    cv.btn("read-child", 340, 812, 246, "Read T-084.2 · knowledge brief", "R9-T11", kind="history-read", effect="Open the complete child result without work or authority changes; return only to this exact completed parent scene.")
    cv.btn("new-task", 604, 812, 160, "New task", "R9-T05", kind="navigate", effect="Open an unassigned draft; retain completed T-084 and receipts. No attempt starts.")
    cv.finish("task-completed-context-copy")


def reopened():
    cv = Page("R9-T04", "Reopened · no new work started", "Same T-084, reopened idle. Reopening changes settlement only. The earlier accepted revision, consumed approval and observed fictional receipts are preserved; no new attempt/action is created.", TASK084, {"historyBranch": "mixed-original-actions", "execution": "Idle", "status": "reopened-idle", "acceptedRevision": 1, "acceptanceId": "accept-084-1", "approvalId": "approval-084-1", "actionReceipts": ["mail-receipt-084", "event-084"], "newAttempts": [], "newActions": [], "completedChildrenReset": False, "settlement": "open"})
    cv.status("Reopened · no new work started", "Previously accepted revision 1 is unchanged · describe follow-up work when needed", AMBER)
    cv.panel("follow-up-intent", 340, 288, 720, 270)
    cv.txt(360, 323, "What needs further work?", 17, weight=600)
    cv.lines("intent-placeholder", 360, 365, "Describe a follow-up request…", 670, 17, C["DIM"], leading=26)
    cv.txt(360, 421, "No new work begins until you provide a follow-up request.", 12, C["MUT"])
    cv.lines("scope-followup", 360, 464, "A new request may continue research and drafts within the existing scope. Another send or calendar change needs a new reviewed approval.", 670, 14, C["MUT"], leading=22)
    cv.panel("retained-result", 340, 580, 720, 180)
    cv.txt(360, 614, "Previously accepted · revision 1", 15, weight=600)
    cv.txt(360, 652, "Diagnosis.md · Customer brief.md · Reply.eml · Meeting proposal", 13)
    cv.txt(360, 691, "4 children remain complete · no new attempt · no action replay", 13, GREEN)
    cv.txt(360, 730, "Prior acceptance is not a new approval to send.", 12, C["MUT"])
    cv.panel("preserved-history", 1080, 288, 500, 472)
    cv.txt(1100, 323, "History", 15, weight=600)
    entries = [("Now", "Mara reopened T-084 · idle"), ("Previously accepted · rev 1", "accept-084-1 · retained"), ("Separate action approval", "approval-084-1 · already used"), ("Observed email result", "mail-receipt-084 · sent"), ("Observed calendar result", "event-084 · private hold created")]
    for i, (label, value) in enumerate(entries):
        yy = 365 + i * 70
        cv.txt(1100, yy, label, 13, weight=500)
        cv.txt(1100, yy + 26, value, 13, C["MUT"])
    cv.btn("close-without-work", 340, 812, 228, "Close without new work", "R9-T03", True, kind="fixture-transition", effect="Close unchanged reopened T-084 with no new work. Restore exact completed parent display; retain original acceptance and receipts without accepting again or replaying actions.")
    cv.btn("new-task", 586, 812, 160, "New task", "R9-T05", kind="navigate", effect="Leave T-084 idle and preserved. Open an independent unassigned draft; no work starts.")
    cv.finish("task-reopened-idle-history")


def capture(filled=False):
    sid = "R9-T06" if filled else "R9-T05"
    cv = Page(sid, "Supplied-note draft" if filled else "New task · empty unassigned draft", "Static capture variant. No TaskRef until capture. The explicit fixture-selection control fills an illustrated example; it is not functional typing. Completed T-085 never routes back into this first-cycle fixture.", None, {"historyBranch": "simple-first-capture", "execution": "none", "status": "draft", "draftFixture": "note-supplied" if filled else "empty", "inputId": "input-085-note-v1" if filled else None}, section="Intake")
    cv.panel("capture-composer", 340, 214, 850, 530)
    cv.txt(360, 249, "Desired outcome", 14, weight=600)
    cv.lines("capture-outcome", 360, 292, "Summarize the supplied note in three sentences or fewer." if filled else "Describe an outcome…", 800, 19, C["FG"] if filled else C["DIM"], leading=29)
    cv.txt(360, 379, "Supplied context", 14, weight=600)
    cv.lines("capture-context", 360, 421, NOTE if filled else "No note or attachment supplied.", 795, 16, C["FG"] if filled else C["DIM"], leading=26)
    cv.txt(360, 589, "Research and drafts · supplied input only", 13, C["MUT"])
    cv.txt(360, 622, "No account access, browsing or external changes are needed.", 13, C["MUT"])
    cv.txt(360, 656, "Save for later when you want to return before starting work.", 12, C["DIM"])
    if filled:
        cv.btn("capture-later", 360, 688, 166, "Save for later", "R9-T07", kind="fixture-transition", effect="Capture input-085-note-v1 as local-085 exactly once in this alternate saved path. No provider attempt starts; draft no longer unassigned.")
        cv.btn("capture-analyze", 544, 688, 220, "Capture and analyze", "R9-T08", True, kind="fixture-transition", effect="Assign local-085 to the same supplied input and admit direct summary work in displayed scope. Destination is the fictional working state; zero children and external actions.")
    else:
        cv.btn("select-supplied-note-fixture", 360, 688, 322, "Show supplied-note example (fixture)", "R9-T06", True, kind="fixture-selection", effect="Select the illustrated populated draft, still taskRef=null. Does not simulate typing, capture, persistence, model work or elapsed time.")
    cv.panel("capture-settings", 1210, 214, 370, 530)
    cv.txt(1230, 249, "Capture settings", 15, weight=600)
    for i, (label, value) in enumerate([("Task", "Unassigned · no task ID"), ("Human owner", "Mara · you"), ("Assignment", "Automatic · when admitted"), ("Allowed input", "Supplied note only"), ("Deadline / budget", "Optional · not set")]):
        yy = 299 + i * 72
        cv.txt(1230, yy, label, 12, C["MUT"])
        cv.txt(1230, yy + 27, value, 14)
    cv.lines("capture-identity", 340, 790, "Opening a draft starts nothing. Capture assigns a new identity; completed work remains in its own history.", 1150, 14, C["MUT"], leading=23)
    cv.finish("unassigned-capture-filled" if filled else "unassigned-capture-empty")


def simple_side(cv, execution):
    cv.panel("simple-details", 1210, 288, 370, 480)
    cv.txt(1230, 322, "Task details", 15, weight=600)
    for i, (label, value) in enumerate([("Human owner", "Mara"), ("Input", "Supplied note · input-085-note-v1"), ("Execution", execution), ("Children / external actions", "None needed"), ("Scope", "Supplied note → concise summary")]):
        yy = 368 + i * 70
        cv.txt(1230, yy, label, 12, C["MUT"])
        cv.txt(1230, yy + 26, value, 13)


def saved():
    cv = Page("R9-T07", "Saved T-085 · no work started", "Alternate capture-only path for the same first T-085 input. Analyze retains local-085; it does not capture a second task. No child or external action records exist for T-085.", TASK085, {"historyBranch": "simple-first-capture", "execution": "Not started", "status": "needs-analysis", "inputId": "input-085-note-v1", "attempts": [], "children": [], "externalActions": []})
    cv.status("Saved for later · no agent started", "T-085 exists locally · analyze when ready")
    cv.panel("saved-input", 340, 288, 850, 480)
    cv.txt(360, 323, "Desired outcome", 15, weight=600)
    cv.lines("saved-goal", 360, 366, "Summarize the supplied note in three sentences or fewer.", 800, 19, leading=29)
    cv.txt(360, 454, "Supplied note · input-085-note-v1", 14, weight=600)
    cv.lines("saved-note", 360, 496, NOTE, 795, 16, leading=26)
    cv.txt(360, 680, "Captured by Mara · no attempt, children or actions", 13, C["MUT"])
    simple_side(cv, "Not started")
    cv.btn("analyze-saved", 340, 812, 190, "Analyze task", "R9-T08", True, kind="fixture-transition", effect="Admit direct work on existing local-085 using the same captured input and valid supplied-note draft scope. Do not recapture or create children or external actions.")
    cv.finish("simple-task-saved")


def working():
    cv = Page("R9-T08", "Direct summary in progress", "Fictional direct execution of T-085. There are no child tasks, plan/phase gates or external actions. Reading the later result is an explicitly temporal fixture navigation, not fabricated progress.", TASK085, {"historyBranch": "simple-first-capture", "execution": "Working directly", "status": "working", "inputId": "input-085-note-v1", "attemptId": "attempt-085-1", "children": [], "externalActions": []}, active="Summarizing supplied note")
    cv.status("Working directly · summarizing the supplied note", "One short result · no decomposition or external actions")
    cv.panel("direct-work", 340, 288, 850, 480)
    cv.txt(360, 325, "Factory", 15, weight=600)
    cv.lines("direct-message", 360, 369, "This is a short supplied note. I’m preparing a concise summary and preserving its uncertainty about the cause.", 795, 19, leading=29)
    cv.txt(360, 492, "Assignment", 14, weight=600)
    for i, (label, value) in enumerate([("Model", "GPT-6.1 Luna"), ("Harness", "Codex"), ("Environment", "Workstation · env-demo"), ("Attempt", "attempt-085-1 · working")]):
        yy = 532 + i * 44
        cv.txt(360, yy, label, 13, C["MUT"])
        cv.txt(530, yy, value, 14)
    simple_side(cv, "Working directly")
    cv.btn("read-later-result", 340, 812, 280, "Read later result (fixture)", "R9-T09", True, kind="temporal-fixture-read", effect="Read the later fictional completed attempt and exact summary revision 1. Clicking does not finish an attempt or simulate time; no external action.")
    cv.finish("simple-task-direct-working")


def simple_review():
    cv = Page("R9-T09", "Review the exact summary", "Same T-085 input and completed attempt. Accept binds summary-085-r1 and its SHA-256; it grants no external action approval. The supplied-note summary is a fictional authored result.", TASK085, {"historyBranch": "simple-first-capture", "execution": "Complete", "status": "ready-for-review", "inputId": "input-085-note-v1", "attemptId": "attempt-085-1", "resultId": "summary-085-r1", "resultRevision": 1, "children": [], "externalActions": []})
    cv.status("Ready to review · concise summary", "Completed work is ready for your acceptance · no action approval needed", GREEN)
    cv.panel("summary-result", 340, 288, 850, 236)
    cv.txt(360, 324, "Summary · revision 1", 17, weight=600)
    cv.lines("summary-body", 360, 368, SUMMARY, 790, 19, leading=30)
    cv.txt(360, 492, "summary-085-r1 · exact text shown above", 12, C["MUT"])
    cv.panel("source-and-uncertainty", 340, 544, 850, 224)
    cv.txt(360, 579, "Source and uncertainty", 15, weight=600)
    cv.lines("source-evidence", 360, 618, "Source: the note supplied by Mara · input-085-note-v1. No independent verification or additional source was used.", 790, 14, C["MUT"], leading=23)
    cv.lines("uncertainty", 360, 696, "The note does not establish the cause of the interruption. The summary preserves that uncertainty.", 790, 14, C["MUT"], leading=23)
    simple_side(cv, "Complete · awaiting acceptance")
    cv.btn("accept-summary", 340, 812, 232, "Accept this summary", "R9-T10", True, kind="fixture-transition", effect="Accept exact summary-085-r1 with acceptance accept-085-1 and settle only this concise-summary outcome. No action approval, child or external write.")
    cv.finish("simple-task-exact-review")


def simple_accepted():
    cv = Page("R9-T10", "Summary accepted", "T-085 remains the accepted original task. Next-cycle capture and reopening variants are explicitly outside this slice; no control recycles completed local-085 as a new task.", TASK085, {"historyBranch": "simple-first-capture", "execution": "Complete", "status": "accepted", "inputId": "input-085-note-v1", "resultId": "summary-085-r1", "acceptedRevision": 1, "acceptanceId": "accept-085-1", "children": [], "externalActions": [], "settlement": "closed"})
    cv.status("Accepted · summary retained", "Mara accepted revision 1 · accept-085-1 · no external actions", GREEN)
    cv.panel("accepted-summary", 340, 288, 850, 380)
    cv.txt(360, 325, "Summary · revision 1", 17, weight=600)
    cv.lines("accepted-body", 360, 372, SUMMARY, 790, 19, leading=30)
    cv.txt(360, 525, "Source: supplied note · input-085-note-v1", 13, C["MUT"])
    cv.txt(360, 568, "Cause remains unconfirmed · no independent verification", 13, C["MUT"])
    cv.txt(360, 620, "Summary, source and completed attempt stay in T-085 history.", 14)
    simple_side(cv, "Complete · accepted")
    cv.panel("next-cycle-boundary", 340, 688, 850, 94)
    cv.lines("next-cycle-note", 360, 723, "Your summary is ready to use. The supplied note and accepted result remain together in this task.", 790, 14, C["MUT"], leading=23)
    cv.btn("new-task-later", 340, 812, 170, "New task…", kind="out-of-slice", effect="Next-cycle capture not wired: requires another unassigned draft and a future identity distinct from local-085.", disabled=True)
    cv.btn("reopen-later", 528, 812, 170, "Reopen task…", kind="out-of-slice", effect="T-085 reopened variant is outside this bounded source journey; acceptance and history must be retained.", disabled=True)
    cv.finish("simple-task-accepted")


def child_reader():
    cv = Page("R9-T11", "Completed child · full knowledge brief", "Read-only full T-084.2 result with original R8 assignment and explicit originating parent. This child reader returns only to R9-T03, the completed action-receipt parent; opening it starts nothing.", CHILD084, {"historyBranch": "mixed-original-actions", "execution": "Complete", "status": "read-only-child", "parentTaskRef": TASK084, "originScene": "R9-T03", "returnScene": "R9-T03", "resultId": "brief-084-2-r1", "attemptId": "attempt-084-2-1", "startsWorkOnOpen": False})
    cv.status("T-084.2 complete · Customer brief.md", "Knowledge agent result · read-only · parent acceptance remains separate", GREEN)
    cv.panel("full-child-output", 340, 288, 820, 280)
    cv.txt(360, 323, "Customer-ready knowledge brief · full output", 17, weight=600)
    cv.lines("child-output", 360, 368, BRIEF, 770, 17, leading=27)
    cv.txt(360, 539, "Customer brief.md · brief-084-2-r1", 12, C["MUT"])
    cv.panel("child-sources", 340, 588, 820, 192)
    cv.txt(360, 621, "Sources and uncertainty", 15, weight=600)
    cv.txt(360, 659, "Incident note.md §2 · Customer email.eml · Availability.txt", 13)
    cv.lines("child-uncertainty", 360, 699, "Supplied sources only. The reported cause is unconfirmed; availability supports a proposal, not a booking or customer invitation.", 770, 14, C["MUT"], leading=23)
    cv.panel("child-assignment", 1180, 288, 400, 492)
    cv.txt(1200, 323, "Recorded assignment", 15, weight=600)
    for i, (label, value) in enumerate([("Model", "Sonnet 5.5"), ("Harness", "Claude Code"), ("Environment", "Workstation · env-demo"), ("Attempt", "attempt-084-2-1 · complete")]):
        yy = 367 + i * 62
        cv.txt(1200, yy, label, 12, C["MUT"])
        cv.txt(1200, yy + 25, value, 14)
    cv.rule(1200, 602, 360)
    cv.txt(1200, 635, "Dependency context", 14, weight=600)
    cv.lines("child-dependencies", 1200, 672, "Inputs: supplied context; no child prerequisite. T-084.4 used this brief with .1 and .3. No child is restarted by reading it.", 350, 14, C["MUT"], leading=22)
    cv.btn("return-origin-parent", 340, 812, 328, "Return to completed T-084", "R9-T03", True, kind="history-read", effect="Return exactly to originScene R9-T03 with accept-084-1, approval-084-1 and original action receipts. No dispatch, acceptance or action.")
    cv.finish("completed-child-full-reader")


def validate():
    issues, counts = [], []
    ids = {s["id"] for s in SCENES}
    for scene in SCENES:
        root = ET.parse(HERE / scene["svg"]).getroot()
        groups = [el.get("id") for el in root.iter() if el.tag.endswith("g")]
        if len(groups) != len(set(groups)):
            issues.append({"screen": scene["id"], "kind": "duplicate-group"})
        if root.get("viewBox") != "0 0 1600 1040":
            issues.append({"screen": scene["id"], "kind": "frame-bounds"})
        boxes = []
        for el in root.iter():
            if el.tag.endswith("image"):
                issues.append({"screen": scene["id"], "kind": "raster-node"})
            if not el.tag.endswith("text"):
                continue
            txt, size, weight = el.text or "", int(el.get("font-size")), int(el.get("font-weight"))
            ink = K.font(size, weight).getbbox(txt, anchor="ls")
            x, y = float(el.get("x")), float(el.get("y"))
            width = K.text_width(txt, size, weight)
            if el.get("text-anchor") == "end":
                x -= width
            elif el.get("text-anchor") == "middle":
                x -= width / 2
            box = [x + ink[0], y + ink[1], x + ink[2], y + ink[3]]
            if box[0] < 0 or box[1] < 0 or box[2] > 1600 or box[3] > 1040 or (y < 900 and box[3] > 900):
                issues.append({"screen": scene["id"], "kind": "text-bounds", "text": txt, "box": box})
            boxes.append((txt, box))
        for i, (a, ba) in enumerate(boxes):
            for b, bb in boxes[i + 1:]:
                if min(ba[2], bb[2]) - max(ba[0], bb[0]) > 1 and min(ba[3], bb[3]) - max(ba[1], bb[1]) > 1:
                    issues.append({"screen": scene["id"], "kind": "text-overlap", "a": a, "b": b})
        controls = [r for r in REGIONS if r["screen"] == scene["id"]]
        for r in controls:
            x, y, w, h = r["box"]
            if r["groupId"] not in groups or x < 0 or y < 0 or x + w > 1600 or y + h > 900:
                issues.append({"screen": scene["id"], "kind": "control-bounds-or-group", "control": r["groupId"]})
        for box in scene["containers"]:
            x, y, w, h = box["box"]
            if min(x, y) < 0 or x + w > 1600 or y + h > 900:
                issues.append({"screen": scene["id"], "kind": "container-bounds", "container": box["id"]})
        counts.append({"screen": scene["id"], "textNodes": len(boxes), "controls": len(controls)})
    for edge in EDGES:
        if edge["to"] not in ids:
            issues.append({"kind": "missing-destination", "edge": edge["id"]})
    for scene in SCENES:
        task = scene["state"]["taskRef"]
        if scene["id"] in ("R9-T05", "R9-T06") and task is not None:
            issues.append({"kind": "fresh-draft-has-task", "screen": scene["id"]})
        if task == TASK085 and (scene["state"]["children"] or scene["state"]["externalActions"]):
            issues.append({"kind": "simple-task-invented-work", "screen": scene["id"]})
    reachable = {"R9-T02"}
    for _ in SCENES:
        reachable |= {e["to"] for e in EDGES if e["from"] in reachable}
    if "R9-T03" in reachable:
        issues.append({"kind": "preparation-path-enters-action-history"})
    if any(e["to"] == "R9-T05" for e in EDGES if e["from"] == "R9-T10"):
        issues.append({"kind": "completed-085-recycled-as-fresh"})
    result = {"status": "PASS" if not issues else "NEEDS_CORRECTION", "scenes": counts, "issues": issues, "method": "XML parse; unique namespaced vector groups; raster exclusion; exact Inter PIL ink bounds and pair overlaps; control/group/container bounds; destination existence; fresh-draft identity, simple-task record, preparation-history separation and no completed-085 recycling checks.", "fonts": [{"weight": w, "source": str((K.FONTS / name).relative_to(DESIGN)), "sha256": sha(K.FONTS / name)} for w, name in K.WEIGHTS.items()], "limits": "Static source geometry and authored fixture invariants only; no functional inputs, native import/pointer test, runtime, persistence, provider, connector, mobile or accessibility proof."}
    write_json(HERE / "validation.json", result)
    return result


def outlined_render_copy(source, destination):
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.ttLib import TTFont

    fonts = {weight: TTFont(K.FONTS / filename) for weight, filename in K.WEIGHTS.items()}
    root = ET.parse(source).getroot()
    count = 0
    for parent in root.iter():
        for el in list(parent):
            if not el.tag.endswith("text"):
                continue
            text = el.text or ""
            size, weight = int(el.get("font-size")), int(el.get("font-weight"))
            font = fonts[weight]
            glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
            scale = size / font["head"].unitsPerEm
            x, y = float(el.get("x")), float(el.get("y"))
            if el.get("text-anchor") == "end":
                x -= K.text_width(text, size, weight)
            elif el.get("text-anchor") == "middle":
                x -= K.text_width(text, size, weight) / 2
            group = ET.Element("{%s}g" % K.NS, {"fill": el.get("fill"), "transform": f"translate({x},{y})"})
            for i, char in enumerate(text):
                if ord(char) not in cmap:
                    raise RuntimeError("Source glyph unavailable in Inter: " + hex(ord(char)))
                pen = SVGPathPen(glyphs)
                glyphs[cmap[ord(char)]].draw(pen)
                cursor = K.text_width(text[:i + 1], size, weight) - K.text_width(char, size, weight)
                ET.SubElement(group, "{%s}path" % K.NS, {"d": pen.getCommands(), "transform": f"translate({cursor},0) scale({scale},{-scale})"})
            parent.insert(list(parent).index(el), group)
            parent.remove(el)
            count += 1
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    baseline = r8_binding()
    (HERE / "screens").mkdir(parents=True, exist_ok=True)
    mixed_review(); preparation_accepted(); completed(); reopened(); capture(); capture(True)
    saved(); working(); simple_review(); simple_accepted(); child_reader()
    result = validate()
    old = json.loads((R8_HOME / "task-journey/scene-manifest.json").read_text(encoding="utf-8"))
    result_hash = hashlib.sha256(SUMMARY.encode("utf-8")).hexdigest()
    brief_hash = hashlib.sha256(BRIEF.encode("utf-8")).hexdigest()
    prepared_snapshot = {"id": "prepared-084-r1", "taskRef": TASK084, "revision": 1,
                         "summary": "The refresh interruption matches the supplied incident note. The response explains the recovery step and links the evidence; the meeting proposal uses the confirmed time zone.",
                         "artifactPreviews": [{"name": "Diagnosis.md", "detail": "2 evidence links · assumption stated"}, {"name": "Customer brief.md", "detail": "3 supplied sources · reviewed summary"}],
                         "replyDraft": REPLY, "meetingProposal": old["reviewedActionEnvelope"]["payload"]["calendar"],
                         "limits": "Exact displayed assembled revision, not an invented full diagnosis artifact; original artifact previews and reviewed envelope derive from bound R8 source."}
    prepared_hash = hashlib.sha256(json.dumps(prepared_snapshot, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    preserved = r8_binding() == baseline
    manifest = {"schema": "t3factory-task-journey-design/1", "round": "09", "status": "EDITABLE_SOURCE_ONLY", "namespace": "R9 task-return / fictional env-demo / customer-ops", "appHeight": 900,
        "taskIdentity": "Namespace-qualified proposed local identities, not implemented runtime contracts. Unassigned draft has taskRef=null; capturing assigns local-085 once per alternate first-capture history.",
        "scenes": SCENES, "controls": REGIONS, "edges": EDGES,
        "identities": {"mixedTask": TASK084, "simpleTask": TASK085, "child": CHILD084, "freshDraftTaskRef": None},
        "alternateHistories": [{"id": "mixed-preparation-only", "entry": "R9-T01", "acceptance": "accept-084-prep-1", "acceptedOutcome": "prepared-artifacts-only", "approval": None, "receipts": [], "cannotReachActionCompletedFixture": True}, {"id": "mixed-original-actions", "entry": "R9-T01", "acceptance": "accept-084-1", "approval": "approval-084-1", "receipts": ["mail-receipt-084", "event-084"], "reopenedSameTask": "R9-T04", "childReaderOriginAndReturn": "R9-T03"}, {"id": "simple-first-capture", "capturePaths": [["R9-T05", "R9-T06", "R9-T08"], ["R9-T05", "R9-T06", "R9-T07", "R9-T08"]], "oneTask": TASK085, "notSequentialDuplicateCaptures": True, "noCompletedTaskToFirstCycleCaptureEdge": True}],
        "scopeFixtures": [{"id": "scope-084-research-drafts", "taskRef": TASK084, "owner": "Mara", "inputs": ["Customer email.eml", "Incident note.md", "Availability.txt", "Mara-confirmed time zone"], "automaticAdmissions": ["read supplied context", "research within permitted context", "summarize", "propose", "draft", "independent review"], "externalWrites": [], "reopenAloneAdmitsNothing": True, "newFollowupRequiresIntentAndStillValidScope": True, "runtimeAuthority": "ILLUSTRATIVE_ONLY"}, {"id": "scope-085-note-summary", "taskRef": TASK085, "owner": "Mara", "inputs": ["input-085-note-v1"], "automaticAdmissions": ["read supplied note", "summarize", "self-review uncertainty"], "browsing": False, "accountAccess": False, "externalWrites": [], "runtimeAuthority": "ILLUSTRATIVE_ONLY"}],
        "preparedRevisionFixture": {"payload": prepared_snapshot, "sha256": prepared_hash, "canonicalization": "UTF-8 JSON, sorted keys, compact separators, unescaped Unicode", "reviewScene": "R9-T01", "reviewSceneSha256": next(s["svgSha256"] for s in SCENES if s["id"] == "R9-T01"), "acceptanceBindings": {"accept-084-prep-1": prepared_hash, "accept-084-1": prepared_hash}, "bindingIsR9AuthoredDesignEvidence": True},
        "inputs": [{"id": "input-085-note-v1", "text": NOTE, "provenance": "Fictional note supplied by Mara; no independent verification.", "sha256": hashlib.sha256(NOTE.encode("utf-8")).hexdigest()}],
        "results": [{"id": "summary-085-r1", "taskRef": TASK085, "revision": 1, "text": SUMMARY, "sha256": result_hash, "canonicalization": "UTF-8 text, no trailing newline", "source": "input-085-note-v1", "uncertainty": "Cause unconfirmed; supplied note only", "children": [], "externalActions": []}, {"id": "brief-084-2-r1", "taskRef": CHILD084, "artifact": "Customer brief.md", "text": BRIEF, "sha256": brief_hash, "sources": ["Incident note.md §2", "Customer email.eml", "Availability.txt"], "uncertainty": "Cause unconfirmed; availability is a proposal only", "dependsOn": [], "inputDependency": "supplied context", "usedBy": "local-084-4", "assignment": {"model": "Sonnet 5.5", "harness": "Claude Code", "environment": "Workstation", "environmentId": "env-demo", "attemptId": "attempt-084-2-1", "attempt": 1, "status": "Complete"}}],
        "simpleAssignment": {"taskRef": TASK085, "model": "GPT-6.1 Luna", "harness": "Codex", "environment": "Workstation", "environmentId": "env-demo", "attemptId": "attempt-085-1", "attempt": 1},
        "acceptanceFixtures": [{"id": "accept-084-prep-1", "taskRef": TASK084, "revision": 1, "branch": "mixed-preparation-only", "acceptedArtifactNames": ["Diagnosis.md", "Customer brief.md", "Reply.eml", "Meeting proposal"], "artifactBinding": "unchanged R8 reviewed action envelope + R8 source hash; email and proposal accepted as drafts", "reviewedEnvelopeSha256": old["reviewedActionEnvelope"]["sha256"], "owner": "Mara", "acceptsActions": False, "settledOutcome": "preparation-only", "email": "Not sent", "calendar": "Not changed"}, {"id": "accept-084-1", "taskRef": TASK084, "revision": 1, "branch": "mixed-original-actions", "owner": "Mara", "reviewedEnvelopeSha256": old["reviewedActionEnvelope"]["sha256"], "separateApproval": "approval-084-1"}, {"id": "accept-085-1", "taskRef": TASK085, "revision": 1, "resultId": "summary-085-r1", "resultSha256": result_hash, "owner": "Mara", "actionApproval": None}],
        "reviewedActionEnvelope": old["reviewedActionEnvelope"],
        "actionEvidence": {"allValuesFictional": True, "approvalDoesNotProveSuccess": True, "approval": "approval-084-1", "receipts": [{"id": "mail-receipt-084", "observed": "Email sent", "time": "10:24", "contentBinding": old["reviewedActionEnvelope"]["sha256"]}, {"id": "event-084", "observed": "Private calendar hold created", "start": "2026-11-12T14:30:00-08:00", "attendees": []}], "importedFromR8": True, "unknownOutcomePolicy": "Reconcile before proposing a duplicate; never infer a new approval from acceptance or reopen."},
        "reopenInvariant": {"taskRef": TASK084, "preservedAcceptance": "accept-084-1", "preservedRevision": 1, "preservedApproval": "approval-084-1", "preservedReceipts": ["mail-receipt-084", "event-084"], "newAttempts": [], "newActions": [], "resetsCompletedChildren": False, "closeWithoutNewWorkReturns": "R9-T03", "furtherWork": "Requires new intent within still-valid research/drafts scope; no continuation submission is simulated."},
        "journeys": {"preparationOnly": ["R9-T01", "R9-T02", "R9-T05"], "actionsThenReopen": ["R9-T01", "R9-T03", "R9-T04", "R9-T03"], "childReader": ["R9-T03", "R9-T11", "R9-T03"], "simpleDirect": ["R9-T05", "R9-T06", "R9-T08", "R9-T09", "R9-T10"], "simpleSaved": ["R9-T05", "R9-T06", "R9-T07", "R9-T08", "R9-T09", "R9-T10"]},
        "sourceBinding": {"r8Files": baseline, "r8ByteIdenticalAfterGeneration": preserved, "reuse": "Import R8 definitions without main(); own Page/action/finish/registries over R8.M.Canvas; no inherited T-084 page content or output globals."},
        "qualification": {"authored": True, "staticGeometry": result["status"], "rendered": False, "nativeImport": "UNRUN", "pointerVerified": "UNRUN", "runtime": "UNIMPLEMENTED_DESIGN_FIXTURE", "mobile": "UNQUALIFIED", "accessibility": "UNQUALIFIED"}}
    write_json(HERE / "scene-manifest.json", manifest)
    if result["issues"] or not preserved:
        print(json.dumps({"validation": result, "r8Preserved": preserved}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    rendered = []
    if args.render:
        (HERE / "previews").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="t3-r9-fonts-") as temporary:
            directory = Path(temporary)
            for scene in SCENES:
                png = HERE / "previews" / (scene["id"] + ".png")
                outlined = directory / (scene["id"] + ".svg")
                outlined_render_copy(HERE / scene["svg"], outlined)
                subprocess.run(["rsvg-convert", "-o", str(png), str(outlined)], check=True, capture_output=True)
                rendered.append(png.name)
        write_json(HERE / "render-evidence.json", {"method": "rsvg-convert of temporary outlined copies; glyph outlines from fontTools TTFont of bound Inter files, positions from PIL prefix advances. Authored SVGs retain editable native text. No fonts installed.", "fontWeights": result["fonts"], "previews": [{"scene": s["id"], "svgSha256": s["svgSha256"], "png": "previews/" + s["id"] + ".png", "pngSha256": sha(HERE / "previews" / (s["id"] + ".png"))} for s in SCENES], "limits": "Local derivative raster rendering only; not platform font matching, native Figma typography, shaping equivalence or native pointer proof. Visual inspection is recorded separately."})
        manifest["qualification"]["rendered"] = True
        manifest["qualification"]["renderEvidenceSha256"] = sha(HERE / "render-evidence.json")
        write_json(HERE / "scene-manifest.json", manifest)
    print(json.dumps({"scenes": len(SCENES), "controls": len(REGIONS), "wiredSourceEdges": len(EDGES), "geometry": result["status"], "r8ByteIdentical": preserved, "pngsRendered": rendered}, indent=2))


if __name__ == "__main__":
    main()
