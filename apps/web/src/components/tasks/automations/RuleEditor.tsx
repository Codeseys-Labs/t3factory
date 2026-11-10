import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type FactoryAgentProfile,
  type FactoryIntakeRule,
  type FactoryIntakeSource,
  type FactoryIntakeAutonomy,
  type FactoryTaskAssignment,
  type FactoryTaskType,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { randomUUID } from "../../../lib/utils";
import {
  factoryIntake,
  useFactoryIntakePreview,
  useFactoryTaskCommand,
} from "../../../state/factoryTasks";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";

export function RuleEditor({
  environmentId,
  rule,
  sources,
  profiles,
  close,
}: {
  environmentId: EnvironmentId;
  rule: FactoryIntakeRule | undefined;
  sources: readonly FactoryIntakeSource[];
  profiles: readonly FactoryAgentProfile[];
  close: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [sourceId, setSourceId] = useState(rule?.match.sourceId ?? sources[0]?.id ?? "");
  const [labels, setLabels] = useState(rule?.match.labels.join(", ") ?? "");
  const [title, setTitle] = useState(rule?.match.titleContains ?? "");
  const [type, setType] = useState<FactoryTaskType>(rule?.action.type ?? "task");
  const [assignee, setAssignee] = useState(
    rule?.action.assignment.mode === "profile"
      ? rule.action.assignment.profileId
      : rule?.action.assignment.mode === "auto"
        ? "auto"
        : "unassigned",
  );
  const [autonomy, setAutonomy] = useState<FactoryIntakeAutonomy>(rule?.autonomy ?? "suggest");
  const [trial, setTrial] = useState(rule?.state === "trial");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const assignment: FactoryTaskAssignment =
    assignee === "auto"
      ? { mode: "auto" }
      : assignee === "unassigned"
        ? { mode: "unassigned" }
        : { mode: "profile", profileId: assignee };
  const match = {
    sourceId,
    labels: labels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    titleContains: title,
  };
  const input = {
    commandId,
    ...(rule ? { id: rule.id, expectedVersion: rule.version } : {}),
    name,
    match,
    action: { type, assignment },
    autonomy,
    state:
      autonomy === "auto-start"
        ? ("off" as const)
        : trial
          ? ("trial" as const)
          : rule?.state === "on"
            ? ("on" as const)
            : ("off" as const),
  };
  const save = useFactoryTaskCommand(
    factoryIntake.saveIntakeRule,
    { environmentId, input },
    { reportFailure: false },
  );
  const remove = useFactoryTaskCommand(
    factoryIntake.deleteIntakeRule,
    {
      environmentId,
      input: { commandId, id: rule?.id ?? "", expectedVersion: rule?.version ?? 0 },
    },
    { reportFailure: false },
  );
  async function run(deleting: boolean) {
    setPending(true);
    setError("");
    const result = await (deleting ? remove.run() : save.run());
    setPending(false);
    setCommandId(CommandId.make(randomUUID()));
    if (result._tag === "Success") {
      close();
      return;
    }
    const failure = squashAtomCommandFailure(result);
    const reason =
      typeof failure === "object" && failure !== null && "reason" in failure
        ? failure.reason
        : null;
    setError(
      reason === "autonomy-not-allowed"
        ? "Every start needs a person."
        : reason === "version-conflict"
          ? "This rule changed. Close and reopen it to see the latest version."
          : "Couldn't save the rule. Check its fields and try again.",
    );
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetPopup>
        <SheetHeader>
          <SheetTitle>{rule ? "Edit rule" : "New rule"}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6 text-sm">
          <div className="space-y-1">
            <Label htmlFor="rule-name">Name</Label>
            <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <h3 className="font-medium">When</h3>
          <Field
            label="Source"
            value={sourceId}
            onChange={setSourceId}
            items={sources.map((s) => ({ value: s.id, label: `${s.label} · ${s.detail}` }))}
          />
          <div className="space-y-1">
            <Label htmlFor="rule-labels">Labels</Label>
            <Input
              id="rule-labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="Comma-separated labels"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-title">Title contains</Label>
            <Input id="rule-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <h3 className="font-medium">Then</h3>
          <Field
            label="Type"
            value={type}
            onChange={(value) => setType(value as FactoryTaskType)}
            items={["task", "bug", "feature", "docs", "research"].map((v) => ({
              value: v,
              label: v[0]!.toUpperCase() + v.slice(1),
            }))}
          />
          <Field
            label="Assignee"
            value={assignee}
            onChange={setAssignee}
            items={[
              { value: "auto", label: "Auto" },
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
              { value: "unassigned", label: "Unassigned" },
            ]}
          />
          <h3 className="font-medium">Autonomy</h3>
          <Field
            label="Autonomy level"
            value={autonomy}
            onChange={(value) => setAutonomy(value as FactoryIntakeAutonomy)}
            items={[
              { value: "manual", label: "Manual" },
              { value: "suggest", label: "Suggest" },
              { value: "auto-start", label: "Auto-start" },
            ]}
          />
          <label className="flex items-center gap-2">
            <Checkbox
              checked={trial && autonomy !== "auto-start"}
              disabled={autonomy === "auto-start"}
              onCheckedChange={setTrial}
            />
            Try once on the next match, then ask me
          </label>
          {autonomy === "auto-start" ? (
            <p className="text-muted-foreground">Every start needs a person.</p>
          ) : null}
          {sourceId ? <Preview environmentId={environmentId} match={match} /> : null}
          {error ? <p role="alert">{error}</p> : null}
          {rule ? (
            <Button
              variant="ghost-destructive"
              size="sm"
              disabled={!remove.permission || pending}
              onClick={() => {
                if (window.confirm(`Delete ${rule.name}? Existing tasks and arrivals stay.`))
                  void run(true);
              }}
            >
              Delete rule
            </Button>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!save.permission || pending || !name.trim() || !sourceId}
            onClick={() => void run(false)}
          >
            Save rule
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
function Preview({
  environmentId,
  match,
}: {
  environmentId: EnvironmentId;
  match: FactoryIntakeRule["match"];
}) {
  const result = useFactoryIntakePreview(environmentId, { match });
  const preview = AsyncResult.getOrElse(result, () => null);
  return result._tag === "Failure" ? (
    <p role="status">Couldn't load the match count.</p>
  ) : preview ? (
    <p className="text-muted-foreground">
      In the last 30 days this would have matched {preview.matchedLast30Days} issues.
    </p>
  ) : (
    <p role="status">Loading match count…</p>
  );
}
function Field({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: readonly { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
