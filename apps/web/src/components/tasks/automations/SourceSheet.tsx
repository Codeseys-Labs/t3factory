import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { FactoryTaskCatalog } from "@t3tools/client-runtime/state/factory-task-view";
import {
  CommandId,
  type EnvironmentId,
  type FactoryAgentProfile,
  type FactoryIntakeRule,
  type FactoryIntakeSource,
  type FactoryIntakeSourceConfig,
  type FactoryIntakeSourceKind,
  type FactoryTaskAssignment,
  type FactoryTaskType,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { factoryIntake, useFactoryTaskCommand } from "../../../state/factoryTasks";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { TASK_TYPE_LABELS } from "../kit";
import { assigneeSelect } from "./assignee";
import { readRefusal, refusalText, TASK_TYPES, WEEKDAYS } from "./automationText";
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

const KINDS: Record<FactoryIntakeSourceKind, { label: string; hint: string }> = {
  issues: { label: "Issues", hint: "Brings in the project's GitHub issues." },
  feed: { label: "Feed", hint: "Brings in each new entry of an RSS or Atom feed." },
  schedule: {
    label: "Schedule",
    hint: "Makes the task below at the set times. It goes straight to the board.",
  },
};

interface SourceFields {
  kind: FactoryIntakeSourceKind;
  projectId: ProjectId | "";
  url: string;
  timeOfDay: string;
  weekdays: readonly number[];
  title: string;
  description: string;
  type: FactoryTaskType;
  assignment: FactoryTaskAssignment;
  lane: "backlog" | "ready";
}

const sourceFields = ({ config, projectId }: FactoryIntakeSource): SourceFields => ({
  kind: config.kind,
  projectId,
  url: config.kind === "feed" ? config.url : "",
  timeOfDay: config.kind === "schedule" ? config.schedule.timeOfDay : "09:00",
  weekdays: config.kind === "schedule" ? config.schedule.weekdays : [1],
  title: config.kind === "schedule" ? config.task.title : "",
  description: config.kind === "schedule" ? config.task.description : "",
  type: config.kind === "schedule" ? config.task.type : "task",
  assignment: config.kind === "schedule" ? config.task.assignment : { mode: "unassigned" },
  lane: config.kind === "schedule" ? config.task.lane : "backlog",
});

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The source sheet. Opened by Add source (`?sheet=source`) and a click on a source row. */
export function SourceSheet({
  environmentId,
  source,
  projects,
  rules,
  profiles,
  catalog,
  close,
}: {
  environmentId: EnvironmentId;
  source: FactoryIntakeSource | undefined;
  projects: readonly EnvironmentProject[];
  rules: readonly FactoryIntakeRule[];
  profiles: readonly FactoryAgentProfile[];
  catalog: FactoryTaskCatalog;
  close: () => void;
}) {
  const draft = useVersionedDraft(source, sourceFields, {
    kind: "issues",
    projectId: projects[0]?.id ?? "",
    url: "",
    timeOfDay: "09:00",
    weekdays: [1],
    title: "",
    description: "",
    type: "task",
    assignment: { mode: "unassigned" },
    lane: "backlog",
  });
  const { values } = draft;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const config: FactoryIntakeSourceConfig =
    values.kind === "issues"
      ? { kind: "issues" }
      : values.kind === "feed"
        ? { kind: "feed", url: values.url.trim() }
        : {
            kind: "schedule",
            schedule: {
              timeOfDay: values.timeOfDay,
              weekdays: [...values.weekdays].toSorted((a, b) => a - b),
            },
            task: {
              title: values.title.trim(),
              description: values.description.trim(),
              type: values.type,
              assignment: values.assignment,
              lane: values.lane,
            },
          };
  const projectId = values.projectId === "" ? undefined : values.projectId;
  const save = useFactoryTaskCommand(
    factoryIntake.saveIntakeSource,
    {
      environmentId,
      input: {
        commandId,
        ...(draft.item ? { id: draft.item.id, expectedVersion: draft.item.version } : {}),
        projectId: projectId ?? ("" as ProjectId),
        config,
        enabled: draft.item?.enabled ?? true,
      },
    },
    { reportFailure: false },
  );
  const remove = useFactoryTaskCommand(
    factoryIntake.deleteIntakeSource,
    {
      environmentId,
      input: { commandId, id: draft.item?.id ?? "", expectedVersion: draft.item?.version ?? 0 },
    },
    { reportFailure: false },
  );
  const complete =
    projectId !== undefined &&
    (values.kind === "issues" ||
      (values.kind === "feed" && values.url.trim().length > 0) ||
      (values.kind === "schedule" &&
        TIME_OF_DAY.test(values.timeOfDay) &&
        values.title.trim().length > 0));
  const assignee = assigneeSelect(values.assignment, profiles, catalog);
  const readers = draft.item
    ? rules.filter((rule) => rule.match.sourceId === draft.item?.id).map((rule) => rule.name)
    : [];

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
    else setError(refusalText(refusal.reason, "source"));
  }

  return (
    <AutomationSheet
      title={draft.item ? draft.item.label : "Add source"}
      description="Source"
      onClose={close}
      footer={
        <>
          {draft.item ? (
            <DeleteAction
              label="Delete source"
              title={`Delete ${draft.item.label}?`}
              consequence={
                readers.length === 0
                  ? "Tasks and Inbox items it already brought in stay."
                  : `Tasks and Inbox items it already brought in stay. ${readers.length === 1 ? "This rule reads" : "These rules read"} from it and will match nothing: ${readers.join(", ")}.`
              }
              disabled={!remove.permission || pending}
              onConfirm={() => void run(remove)}
            />
          ) : null}
          <SheetActions
            saveLabel={draft.item ? "Save" : "Add source"}
            canSave={save.permission && !pending && !draft.reloading && complete}
            onCancel={close}
            onSave={() => void run(save)}
          />
        </>
      }
    >
      <SelectField
        label="Kind"
        value={values.kind}
        disabled={draft.item !== undefined}
        items={(Object.keys(KINDS) as FactoryIntakeSourceKind[]).map((kind) => ({
          value: kind,
          label: KINDS[kind].label,
        }))}
        hint={KINDS[values.kind].hint}
        onChange={(value) => draft.set("kind", value)}
      />
      <SelectField
        label="Project"
        value={values.projectId}
        items={projects.map((project) => ({ value: project.id, label: project.title }))}
        onChange={(value) => draft.set("projectId", value)}
      />
      {values.kind === "feed" ? (
        <Field label="Feed URL" htmlFor="source-url">
          <Input
            id="source-url"
            type="url"
            value={values.url}
            placeholder="https://example.com/feed.xml"
            onChange={(event) => draft.set("url", event.target.value)}
          />
        </Field>
      ) : null}
      {values.kind === "schedule" ? (
        <>
          <SheetSection title="When">
            <Field label="Time" htmlFor="source-time" hint="This machine's local time.">
              <Input
                id="source-time"
                type="time"
                value={values.timeOfDay}
                onChange={(event) => draft.set("timeOfDay", event.target.value)}
              />
            </Field>
            <Field label="Days" hint="None selected runs it every day.">
              <ToggleGroup
                multiple
                aria-label="Days"
                value={values.weekdays.map(String)}
                onValueChange={(days) => draft.set("weekdays", days.map(Number))}
              >
                {WEEKDAYS.map(({ day, short, plural }) => (
                  <Toggle key={day} value={String(day)} aria-label={plural}>
                    {short}
                  </Toggle>
                ))}
              </ToggleGroup>
            </Field>
          </SheetSection>
          <SheetSection title="Task it makes">
            <Field label="Title" htmlFor="source-task-title">
              <Input
                id="source-task-title"
                value={values.title}
                maxLength={512}
                onChange={(event) => draft.set("title", event.target.value)}
              />
            </Field>
            <Field label="Description" htmlFor="source-task-description">
              <Textarea
                id="source-task-description"
                value={values.description}
                maxLength={8000}
                onChange={(event) => draft.set("description", event.target.value)}
              />
            </Field>
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
            <SelectField
              label="Status"
              value={values.lane}
              items={[
                { value: "backlog", label: "Backlog" },
                { value: "ready", label: "Ready" },
              ]}
              onChange={(value) => draft.set("lane", value)}
            />
          </SheetSection>
        </>
      ) : null}
      {save.permission ? null : (
        <p className="text-muted-foreground text-xs">
          Changing sources needs permission to change this machine's settings.
        </p>
      )}
      <SheetNotice
        error={error}
        changed={
          draft.reloading
            ? "This source changed on another device. Loading the latest version…"
            : draft.reloaded
              ? "This source changed on another device. It now shows that version, with your edits kept where you changed a different field."
              : null
        }
      />
    </AutomationSheet>
  );
}
