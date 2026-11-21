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
import { msg, T, useGT, useMessages } from "gt-react";

import { m } from "../../../i18n/messages";

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
  issues: {
    label: msg("Issues", { $context: "source kind" }),
    hint: msg("Brings in the project's GitHub issues."),
  },
  feed: {
    label: msg("Feed", { $context: "source kind" }),
    hint: msg("Brings in each new entry of an RSS or Atom feed."),
  },
  schedule: {
    label: msg("Schedule", { $context: "source kind" }),
    hint: msg("Makes the task below at the set times. It goes straight to the board."),
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
  const gt = useGT();
  const messages = useMessages();
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
  const assignee = assigneeSelect(values.assignment, profiles, catalog, messages);
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
    else setError(refusalText(refusal.reason, "source", m));
  }

  return (
    <AutomationSheet
      title={draft.item ? draft.item.label : msg("Add source")}
      description={msg("Source")}
      onClose={close}
      footer={
        <>
          {draft.item ? (
            <DeleteAction
              label={msg("Delete source")}
              title={msg("Delete {label}?", { label: draft.item.label })}
              consequence={
                readers.length === 0
                  ? msg("Tasks and Inbox items it already brought in stay.")
                  : msg(
                      "Tasks and Inbox items it already brought in stay. {rules} also be deleted: {readers}.",
                      {
                        rules:
                          readers.length === 1 ? msg("This rule will") : msg("These rules will"),
                        readers: readers.join(", "),
                      },
                    )
              }
              disabled={!remove.permission || pending}
              onConfirm={() => void run(remove)}
            />
          ) : null}
          <SheetActions
            saveLabel={draft.item ? msg("Save") : msg("Add source")}
            canSave={save.permission && !pending && !draft.reloading && complete}
            onCancel={close}
            onSave={() => void run(save)}
          />
        </>
      }
    >
      <SelectField
        label={msg("Kind")}
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
        label={msg("Project")}
        value={values.projectId}
        disabled={draft.item !== undefined}
        items={projects.map((project) => ({ value: project.id, label: project.title }))}
        onChange={(value) => draft.set("projectId", value)}
      />
      {values.kind === "feed" ? (
        <Field label={msg("Feed URL")} htmlFor="source-url">
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
          <SheetSection title={msg("When", { $context: "when the task is made" })}>
            <Field
              label={msg("Time")}
              htmlFor="source-time"
              hint={msg("This machine's local time.")}
            >
              <Input
                id="source-time"
                type="time"
                value={values.timeOfDay}
                onChange={(event) => draft.set("timeOfDay", event.target.value)}
              />
            </Field>
            <Field label={msg("Days")} hint={msg("None selected runs it every day.")}>
              <ToggleGroup
                multiple
                aria-label={gt("Days")}
                value={values.weekdays.map(String)}
                onValueChange={(days) => draft.set("weekdays", days.map(Number))}
              >
                {WEEKDAYS.map(({ day, short, plural }) => (
                  <Toggle key={day} value={String(day)} aria-label={messages(plural)}>
                    {messages(short)}
                  </Toggle>
                ))}
              </ToggleGroup>
            </Field>
          </SheetSection>
          <SheetSection title={msg("Task it makes")}>
            <Field label={msg("Title")} htmlFor="source-task-title">
              <Input
                id="source-task-title"
                value={values.title}
                maxLength={512}
                onChange={(event) => draft.set("title", event.target.value)}
              />
            </Field>
            <Field label={msg("Description")} htmlFor="source-task-description">
              <Textarea
                id="source-task-description"
                value={values.description}
                maxLength={8000}
                onChange={(event) => draft.set("description", event.target.value)}
              />
            </Field>
            <SelectField
              label={msg("Type", { $context: "noun, the task type it makes" })}
              value={values.type}
              items={TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABELS[type] }))}
              onChange={(value) => draft.set("type", value)}
            />
            <SelectField
              label={msg("Assignee")}
              value={assignee.value}
              items={assignee.items}
              onChange={(value) => draft.set("assignment", assignee.pick(value))}
            />
            <SelectField
              label={msg("Status", { $context: "noun, the made task's lane" })}
              value={values.lane}
              items={[
                { value: "backlog", label: msg("Backlog", { $context: "task status" }) },
                { value: "ready", label: msg("Ready", { $context: "task status" }) },
              ]}
              onChange={(value) => draft.set("lane", value)}
            />
          </SheetSection>
        </>
      ) : null}
      {save.permission ? null : (
        <p className="text-muted-foreground text-xs">
          <T>Changing sources needs permission to change this machine's settings.</T>
        </p>
      )}
      <SheetNotice
        error={error}
        changed={
          draft.reloading
            ? msg("This source changed on another device. Loading the latest version…")
            : draft.reloaded
              ? msg(
                  "This source changed on another device. It now shows that version, with your edits kept where you changed a different field.",
                )
              : null
        }
      />
    </AutomationSheet>
  );
}
