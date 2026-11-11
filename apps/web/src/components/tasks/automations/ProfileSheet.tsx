import { Link } from "@tanstack/react-router";
import {
  CommandId,
  type EnvironmentId,
  type FactoryAgentProfile,
  type FactoryIntakeRule,
  type FactoryIntakeSource,
  type FactoryTaskType,
  type FactoryTaskWorkspace,
  type ProviderOptionSelection,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { ArrowRightIcon, HistoryIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { factoryTasks, useFactoryTaskCommand } from "../../../state/factoryTasks";
import { resolveEnvModeLabel } from "../../BranchToolbar.logic";
import { runtimeModeConfig, runtimeModeOptions } from "../../chat/runtimeModeConfig";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { TASK_TYPE_LABELS } from "../kit";
import { plural, readRefusal, refusalText, TASK_TYPES } from "./automationText";
import { useProfileHarnesses } from "./profileModels";
import {
  AutomationSheet,
  DeleteAction,
  Field,
  SelectField,
  SheetActions,
  SheetNotice,
} from "./sheetParts";
import { useVersionedDraft } from "./useVersionedDraft";

interface ProfileFields {
  name: string;
  instanceId: string;
  model: string;
  options: readonly ProviderOptionSelection[];
  runtimeMode: RuntimeMode;
  workspace: FactoryTaskWorkspace;
  handles: readonly FactoryTaskType[];
}

const profileFields = ({ name, setup, handles }: FactoryAgentProfile): ProfileFields => ({
  name,
  instanceId: setup.modelSelection.instanceId,
  model: setup.modelSelection.model,
  options: setup.modelSelection.options ?? [],
  runtimeMode: setup.runtimeMode,
  workspace: setup.workspace,
  handles,
});

const WORKSPACES: readonly { value: FactoryTaskWorkspace; label: string }[] = [
  { value: "worktree", label: resolveEnvModeLabel("worktree") },
  { value: "root", label: resolveEnvModeLabel("local") },
];

/** `12 tasks this week`, opening the task list of that profile. */
export function ProfileTasksLink({ profileId, count }: { profileId: string; count: number }) {
  return (
    <Link
      to="/tasks"
      search={{ layout: "list", filters: { assigneeKeys: [profileId], scope: "all" } }}
      className="inline-flex items-center gap-1.5 text-foreground text-xs hover:underline"
    >
      <HistoryIcon aria-hidden className="size-3.5 text-muted-foreground" />
      {plural(count, "task")} this week
      <ArrowRightIcon aria-hidden className="size-3.5" />
    </Link>
  );
}

/** E3. Opened by New profile (`?sheet=profile`) and a click on a profile card. */
export function ProfileSheet({
  environmentId,
  profile,
  tasksThisWeek,
  rules,
  sources,
  close,
}: {
  environmentId: EnvironmentId;
  profile: FactoryAgentProfile | undefined;
  tasksThisWeek: number;
  rules: readonly FactoryIntakeRule[];
  sources: readonly FactoryIntakeSource[];
  close: () => void;
}) {
  const draft = useVersionedDraft(profile, profileFields, {
    name: "",
    instanceId: "",
    model: "",
    options: [],
    runtimeMode: "approval-required",
    workspace: "worktree",
    handles: [],
  });
  const { values } = draft;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const harnesses = useProfileHarnesses(
    environmentId,
    values.instanceId === ""
      ? null
      : { instanceId: ProviderInstanceId.make(values.instanceId), model: values.model },
  );
  const instanceId = values.instanceId || (harnesses[0]?.instanceId ?? "");
  const harness = harnesses.find((candidate) => candidate.instanceId === instanceId);
  const model = values.model || (harness?.models[0]?.slug ?? "");
  const effort = harness?.models.find((candidate) => candidate.slug === model)?.effort ?? null;
  const chosenEffort = effort
    ? values.options.find((option) => option.id === effort.id)?.value
    : undefined;
  const effortValue = typeof chosenEffort === "string" ? chosenEffort : (effort?.defaultId ?? null);
  const modes = harness?.runtimeModes ?? runtimeModeOptions;
  const save = useFactoryTaskCommand(
    factoryTasks.saveAgentProfile,
    {
      environmentId,
      input: {
        commandId,
        ...(draft.item ? { id: draft.item.id, expectedVersion: draft.item.version } : {}),
        name: values.name.trim(),
        setup: {
          modelSelection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model,
            ...(values.options.length > 0 ? { options: values.options } : {}),
          },
          runtimeMode: values.runtimeMode,
          interactionMode: draft.item?.setup.interactionMode ?? "default",
          workspace: values.workspace,
        },
        handles: TASK_TYPES.filter((type) => values.handles.includes(type)),
      },
    },
    { reportFailure: false },
  );
  const remove = useFactoryTaskCommand(
    factoryTasks.deleteAgentProfile,
    {
      environmentId,
      input: { commandId, id: draft.item?.id ?? "", expectedVersion: draft.item?.version ?? 0 },
    },
    { reportFailure: false },
  );
  const naming = draft.item
    ? [
        ...rules.filter(
          (rule) =>
            rule.action.assignment.mode === "profile" &&
            rule.action.assignment.profileId === draft.item?.id,
        ),
        ...sources.filter(
          (source) =>
            source.config.kind === "schedule" &&
            source.config.task.assignment.mode === "profile" &&
            source.config.task.assignment.profileId === draft.item?.id,
        ),
      ]
    : [];
  const usedByRules = naming.filter((item) => "match" in item).length;

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
    else setError(refusalText(refusal.reason, "profile"));
  }

  return (
    <AutomationSheet
      title={draft.item ? draft.item.name : "New profile"}
      description="Agent profile"
      onClose={close}
      footer={
        <>
          {draft.item ? (
            <DeleteAction
              label="Delete profile"
              title={`Delete ${draft.item.name}?`}
              consequence={
                naming.length === 0
                  ? `Tasks assigned to ${draft.item.name} will show as unassigned.`
                  : `Tasks assigned to ${draft.item.name} will show as unassigned, as will ${naming.map((item) => ("match" in item ? `the rule ${item.name}` : `the source ${item.label}`)).join(", ")}.`
              }
              disabled={!remove.permission || pending}
              onConfirm={() => void run(remove)}
            />
          ) : null}
          <SheetActions
            saveLabel="Save"
            canSave={
              save.permission &&
              !pending &&
              !draft.reloading &&
              values.name.trim().length > 0 &&
              instanceId !== "" &&
              model !== ""
            }
            onCancel={close}
            onSave={() => void run(save)}
          />
        </>
      }
    >
      <Field label="Name" htmlFor="profile-name">
        <Input
          id="profile-name"
          value={values.name}
          maxLength={64}
          placeholder="Implementer"
          onChange={(event) => draft.set("name", event.target.value)}
        />
      </Field>
      {harnesses.length === 0 && instanceId === "" ? (
        <p className="text-muted-foreground">Set up a harness in Settings to pick its model.</p>
      ) : (
        <>
          <SelectField
            label="Harness"
            value={instanceId}
            items={[
              ...harnesses.map((candidate) => ({
                value: candidate.instanceId as string,
                label: candidate.label,
              })),
              ...(harness ? [] : [{ value: instanceId, label: instanceId }]),
            ]}
            onChange={(value) => {
              draft.set("instanceId", value);
              draft.set("model", "");
              draft.set("options", []);
            }}
          />
          <SelectField
            label="Model"
            value={model}
            items={[
              ...(harness?.models ?? []).map((candidate) => ({
                value: candidate.slug,
                label: candidate.label,
              })),
              ...(harness?.models.some((candidate) => candidate.slug === model)
                ? []
                : [{ value: model, label: model }]),
            ]}
            onChange={(value) => {
              draft.set("model", value);
              draft.set("options", []);
            }}
          />
        </>
      )}
      {effort && effortValue !== null ? (
        <SelectField
          label="Effort"
          value={effortValue}
          items={effort.options.map((option) => ({ value: option.id, label: option.label }))}
          onChange={(value) =>
            draft.set("options", [
              ...values.options.filter((option) => option.id !== effort.id),
              { id: effort.id, value },
            ])
          }
        />
      ) : null}
      <SelectField
        label="Mode"
        value={values.runtimeMode}
        items={(modes.includes(values.runtimeMode) ? modes : [...modes, values.runtimeMode]).map(
          (mode) => ({ value: mode, label: runtimeModeConfig[mode].label }),
        )}
        hint={runtimeModeConfig[values.runtimeMode].description}
        onChange={(value) => draft.set("runtimeMode", value)}
      />
      <SelectField
        label="Workspace"
        value={values.workspace}
        items={WORKSPACES}
        onChange={(value) => draft.set("workspace", value)}
      />
      <Field label="Used for" hint="Auto hands tasks of these types to this profile.">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {TASK_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-2">
              <Checkbox
                checked={values.handles.includes(type)}
                onCheckedChange={(checked) =>
                  draft.set(
                    "handles",
                    checked
                      ? [...values.handles, type]
                      : values.handles.filter((handled) => handled !== type),
                  )
                }
              />
              {TASK_TYPE_LABELS[type]}
            </label>
          ))}
        </div>
      </Field>
      {draft.item ? (
        <p className="flex items-center gap-1 text-muted-foreground text-xs">
          {usedByRules > 0 ? <span>Used by {plural(usedByRules, "rule")} ·</span> : null}
          <ProfileTasksLink profileId={draft.item.id} count={tasksThisWeek} />
        </p>
      ) : null}
      <SheetNotice
        error={error}
        changed={
          draft.reloading
            ? "This profile changed on another device. Loading the latest version…"
            : draft.reloaded
              ? "This profile changed on another device. It now shows that version, with your edits kept where you changed a different field."
              : null
        }
      />
    </AutomationSheet>
  );
}
