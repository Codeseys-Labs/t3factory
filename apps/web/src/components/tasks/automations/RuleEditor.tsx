import type { FactoryTaskCatalog } from "@t3tools/client-runtime/state/factory-task-view";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  CommandId,
  type EnvironmentId,
  type FactoryAgentProfile,
  type FactoryIntakeAutonomy,
  type FactoryIntakeRule,
  type FactoryIntakeRuleMatch,
  type FactoryIntakeRuleState,
  type FactoryIntakeSource,
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
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { TASK_TYPE_LABELS } from "../kit";
import { assigneeSelect } from "./assignee";
import {
  AUTONOMY,
  EVERY_START_NEEDS_A_PERSON,
  plural,
  readRefusal,
  refusalText,
  sourceDetail,
  TASK_TYPES,
} from "./automationText";
import {
  AutomationSheet,
  DeleteAction,
  Field,
  SelectField,
  SheetActions,
  SheetNotice,
  SheetSection,
} from "./sheetParts";
import { useVersionedDraft } from "./useVersionedDraft";

interface RuleFields {
  name: string;
  sourceId: string;
  labels: string;
  titleContains: string;
  type: FactoryTaskType;
  assignment: FactoryTaskAssignment;
  autonomy: FactoryIntakeAutonomy;
  trial: boolean;
}

const ruleFields = (rule: FactoryIntakeRule): RuleFields => ({
  name: rule.name,
  sourceId: rule.match.sourceId,
  labels: rule.match.labels.join(", "),
  titleContains: rule.match.titleContains,
  type: rule.action.type,
  assignment: rule.action.assignment,
  autonomy: rule.autonomy,
  trial: rule.state === "trial",
});

/** E2. Opened by `?sheet=rule`, and `&id=` to edit one. */
export function RuleEditor({
  environmentId,
  rule,
  sources,
  profiles,
  catalog,
  close,
}: {
  environmentId: EnvironmentId;
  rule: FactoryIntakeRule | undefined;
  sources: readonly FactoryIntakeSource[];
  profiles: readonly FactoryAgentProfile[];
  catalog: FactoryTaskCatalog;
  close: () => void;
}) {
  // A schedule makes its task directly, so only issue and feed sources have items to match.
  const matchable = sources.filter((source) => source.config.kind !== "schedule");
  const draft = useVersionedDraft(rule, ruleFields, {
    name: "",
    sourceId: matchable[0]?.id ?? "",
    labels: "",
    titleContains: "",
    type: "task",
    assignment: { mode: "auto" },
    autonomy: "suggest",
    // A new rule tries one match before it is trusted.
    trial: true,
  });
  const { values } = draft;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const autoStart = values.autonomy === "auto-start";
  const seenState = draft.item?.state;
  const state: FactoryIntakeRuleState = autoStart
    ? "off"
    : values.trial
      ? "trial"
      : seenState === undefined || seenState === "trial"
        ? "on"
        : seenState;
  const match: FactoryIntakeRuleMatch = {
    sourceId: values.sourceId,
    labels: [
      ...new Set(
        values.labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    ],
    titleContains: values.titleContains.trim(),
  };
  const save = useFactoryTaskCommand(
    factoryIntake.saveIntakeRule,
    {
      environmentId,
      input: {
        commandId,
        ...(draft.item ? { id: draft.item.id, expectedVersion: draft.item.version } : {}),
        name: values.name.trim(),
        match,
        action: { type: values.type, assignment: values.assignment },
        autonomy: values.autonomy,
        state,
      },
    },
    { reportFailure: false },
  );
  const remove = useFactoryTaskCommand(
    factoryIntake.deleteIntakeRule,
    {
      environmentId,
      input: { commandId, id: draft.item?.id ?? "", expectedVersion: draft.item?.version ?? 0 },
    },
    { reportFailure: false },
  );
  const assignee = assigneeSelect(values.assignment, profiles, catalog);
  const source = matchable.find((candidate) => candidate.id === values.sourceId);

  async function run(command: typeof save | typeof remove) {
    setPending(true);
    setError(null);
    const result = await command.run();
    setPending(false);
    setCommandId(CommandId.make(randomUUID()));
    if (result._tag === "Success") {
      close();
      return;
    }
    const refusal = readRefusal(result);
    if (refusal.reason === "version-conflict") draft.conflict(refusal.currentVersion);
    else setError(refusalText(refusal.reason, "rule"));
  }

  return (
    <AutomationSheet
      title={rule ? rule.name : "New rule"}
      onClose={close}
      footer={
        <>
          {draft.item ? (
            <DeleteAction
              label="Delete rule"
              title={`Delete ${draft.item.name}?`}
              consequence="Tasks and Inbox items it already made stay."
              disabled={!remove.permission || pending}
              onConfirm={() => void run(remove)}
            />
          ) : null}
          <SheetActions
            saveLabel="Save rule"
            canSave={
              save.permission &&
              !pending &&
              !draft.reloading &&
              values.name.trim().length > 0 &&
              source !== undefined
            }
            onCancel={close}
            onSave={() => void run(save)}
          />
        </>
      }
    >
      <Field label="Name" htmlFor="rule-name">
        <Input
          id="rule-name"
          value={values.name}
          maxLength={64}
          placeholder="Bugs from GitHub"
          onChange={(event) => draft.set("name", event.target.value)}
        />
      </Field>
      <SheetSection title="When">
        <SelectField
          label="Source"
          value={values.sourceId}
          items={matchable.map((candidate) => ({
            value: candidate.id,
            label: `${candidate.label} · ${sourceDetail(candidate)}`,
          }))}
          onChange={(value) => draft.set("sourceId", value)}
        />
        <Field label="Labels" htmlFor="rule-labels" hint="Matches an item with any of these.">
          <Input
            id="rule-labels"
            value={values.labels}
            placeholder="bug, regression"
            onChange={(event) => draft.set("labels", event.target.value)}
          />
        </Field>
        <Field label="Title contains" htmlFor="rule-title">
          <Input
            id="rule-title"
            value={values.titleContains}
            maxLength={256}
            onChange={(event) => draft.set("titleContains", event.target.value)}
          />
        </Field>
      </SheetSection>
      <SheetSection title="Then">
        <SelectField
          label="Type"
          value={values.type}
          items={TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABELS[type] }))}
          onChange={(value) => draft.set("type", value)}
        />
        <SelectField
          label="Assignee"
          value={assignee.value}
          items={assignee.items}
          onChange={(value) => draft.set("assignment", assignee.pick(value))}
        />
      </SheetSection>
      <Field label="Autonomy">
        <div className="rounded-lg border p-1">
          <RadioGroup
            aria-label="Autonomy"
            value={values.autonomy}
            onValueChange={(value) => draft.set("autonomy", value as FactoryIntakeAutonomy)}
          >
            {(Object.keys(AUTONOMY) as FactoryIntakeAutonomy[]).map((level) => (
              <label
                key={level}
                className="flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 has-data-checked:bg-accent"
              >
                <Radio value={level} />
                <span className="shrink-0 font-medium">{AUTONOMY[level].label}</span>
                <span className="text-muted-foreground text-xs leading-5">
                  {AUTONOMY[level].description}
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
      </Field>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2">
          <Checkbox
            checked={values.trial && !autoStart}
            disabled={autoStart}
            onCheckedChange={(checked) => draft.set("trial", checked)}
          />
          Try once on the next match, then ask me
        </label>
        {autoStart ? (
          <p className="text-muted-foreground text-xs">{EVERY_START_NEEDS_A_PERSON}</p>
        ) : null}
      </div>
      {source ? (
        <MatchPreview
          environmentId={environmentId}
          match={match}
          noun={source.config.kind === "issues" ? "issue" : "item"}
        />
      ) : null}
      <SheetNotice
        error={error}
        changed={
          draft.reloading
            ? "This rule changed on another device. Loading the latest version…"
            : draft.reloaded
              ? "This rule changed on another device. It now shows that version, with your edits kept where you changed a different field."
              : null
        }
      />
    </AutomationSheet>
  );
}

function MatchPreview({
  environmentId,
  match,
  noun,
}: {
  environmentId: EnvironmentId;
  match: FactoryIntakeRuleMatch;
  noun: string;
}) {
  // Typing in Labels or Title contains asks the server once it settles, not on every key.
  const [settled] = useDebouncedValue(JSON.stringify(match), { wait: 300 });
  const result = useFactoryIntakePreview(environmentId, {
    match: JSON.parse(settled) as FactoryIntakeRuleMatch,
  });
  const preview = AsyncResult.getOrElse(result, () => null);
  if (result._tag === "Failure")
    return <p className="text-muted-foreground text-xs">Couldn't count past matches.</p>;
  if (!preview)
    return (
      <p role="status" className="text-muted-foreground text-xs">
        Counting past matches…
      </p>
    );
  return (
    <p className="text-muted-foreground text-xs">
      In the last 30 days this would have matched {plural(preview.matchedLast30Days, noun)}.
    </p>
  );
}
