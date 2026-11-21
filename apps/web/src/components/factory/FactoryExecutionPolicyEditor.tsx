import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  FactoryExecutionPolicy,
  type FactoryPlanSnapshot,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { msg, T, useGT, Var } from "gt-react";
import { useState } from "react";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

import { m } from "../../i18n/messages";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useFactoryLaunchModelSettings } from "./FactoryLaunchControls";

type TaskDraft = {
  taskId: string;
  model: ModelSelection | null;
  workspace: "root" | "worktree";
  base: string;
  slot: string;
  kind: "sealed-draft" | "verified-code";
  verificationCommand: string;
  verificationArgs: string;
};
type EdgeDraft = { edgeId: string; slot: string; rule: "sealed-draft" | "verified-code" };

const decodePolicy = Schema.decodeUnknownOption(FactoryExecutionPolicy);

const INVALID_POLICY_MESSAGE = msg(
  "Choose a model for each task, a future expiry, valid limits, and an exact commit for each isolated workspace. Verified code also needs an isolated workspace and a verification executable.",
);

export function FactoryExecutionPolicyEditor(props: {
  readonly plan: FactoryPlanSnapshot;
  readonly project: EnvironmentProject;
  readonly disabled: boolean;
  readonly onGrant: (policy: FactoryExecutionPolicy) => void;
}) {
  const { plan } = props;
  const gt = useGT();
  const settings = useFactoryLaunchModelSettings(plan.ref.environmentId, props.project);
  const threads = useThreadShellsForProjectRefs([
    scopeProjectRef(plan.ref.environmentId, plan.ref.projectId),
  ]).filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      thread.linkOrigin === null &&
      thread.delegatedFrom === null,
  );
  const [tasks, setTasks] = useState<readonly TaskDraft[]>(() =>
    plan.tasks
      .filter((task) => !task.retired)
      .map((task) => ({
        taskId: task.id,
        model: settings.defaultSelection,
        workspace: "root",
        base: "",
        slot: "draft",
        kind: "sealed-draft",
        verificationCommand: "",
        verificationArgs: "",
      })),
  );
  const [edges, setEdges] = useState<readonly EdgeDraft[]>(() =>
    plan.edges
      .filter((edge) => !edge.retired)
      .map((edge) => ({ edgeId: edge.id, slot: "draft", rule: "sealed-draft" })),
  );
  const [requesters, setRequesters] = useState<readonly ThreadId[]>([]);
  const [attempts, setAttempts] = useState(String(tasks.length));
  const [retries, setRetries] = useState("0");
  const [concurrency, setConcurrency] = useState("1");
  const [expiry, setExpiry] = useState("");
  const [ownedWriters, setOwnedWriters] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateTask = (id: string, patch: Partial<TaskDraft>) =>
    setTasks((old) => old.map((task) => (task.taskId === id ? { ...task, ...patch } : task)));
  const build = () => {
    const time = new Date(expiry);
    if (Number.isNaN(time.getTime())) {
      setError(m(INVALID_POLICY_MESSAGE));
      return;
    }
    const decoded = decodePolicy({
      version: 1,
      requesterThreadIds: requesters,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        modelSelection: task.model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy:
          task.workspace === "root" ? { type: "root" } : { type: "worktree", baseRef: task.base },
        setup: "deny",
        output: { slot: task.slot, kind: task.kind },
        ...(task.kind === "verified-code"
          ? {
              verification: {
                command: task.verificationCommand,
                args: task.verificationArgs === "" ? [] : task.verificationArgs.split("\n"),
              },
            }
          : {}),
      })),
      edges: edges.map((edge) => ({ edgeId: edge.edgeId, slot: edge.slot, rule: edge.rule })),
      maxAttempts: Number(attempts),
      maxRetriesPerTask: Number(retries),
      maxConcurrent: Number(concurrency),
      expiresAt: time.toISOString(),
      requiredCapabilities: ownedWriters ? ["owned-writers"] : [],
    });
    if (Option.isNone(decoded)) {
      setError(m(INVALID_POLICY_MESSAGE));
      return;
    }
    const policy = decoded.value;
    if (
      !expiry ||
      time.getTime() <= Date.now() ||
      !attempts ||
      !retries ||
      !concurrency ||
      policy.maxAttempts < 1 ||
      policy.maxConcurrent < 1 ||
      tasks.some((task) => task.kind === "verified-code" && task.workspace !== "worktree")
    ) {
      setError(m(INVALID_POLICY_MESSAGE));
      return;
    }
    setError(null);
    props.onGrant(policy);
  };
  return (
    <fieldset className="space-y-4" disabled={props.disabled}>
      <legend className="font-medium">
        <T>
          Grant revision <Var>{plan.revision}</Var>
        </T>
      </legend>
      <p className="text-sm">
        <T>
          This authorizes local preparation only. It does not authorize publication or guarantee a
          shell or network sandbox. Setup is denied; tasks use supervised approval-required mode.
          Unsupported requested capabilities are refused.
        </T>
      </p>
      {tasks.map((task) => {
        const source = plan.tasks.find((entry) => entry.id === task.taskId);
        const activeInstanceId =
          task.model?.instanceId ?? settings.instanceEntries[0]?.instanceId ?? null;
        return (
          <div key={task.taskId} className="space-y-2 rounded border p-2">
            <h5 className="font-medium">
              {source?.title} · {task.taskId}
            </h5>
            <span className="text-sm">
              <T>Provider and model</T>
            </span>
            {activeInstanceId ? (
              <ProviderModelPicker
                environmentId={plan.ref.environmentId}
                disabled={props.disabled}
                activeInstanceId={activeInstanceId}
                model={task.model?.model ?? ""}
                lockedProvider={null}
                instanceEntries={settings.instanceEntries}
                modelOptionsByInstance={settings.modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  updateTask(task.taskId, {
                    model: settings.normalizeModelSelection({ instanceId, model }),
                  })
                }
              />
            ) : (
              <p>
                <T>No provider configured.</T>
              </p>
            )}
            <div className="text-sm">
              <T>Workspace</T>
              <Select
                value={task.workspace}
                onValueChange={(value) =>
                  updateTask(task.taskId, { workspace: value === "worktree" ? "worktree" : "root" })
                }
              >
                <SelectTrigger aria-label={gt("Workspace for {title}", { title: source?.title })}>
                  <SelectValue>
                    {task.workspace === "root" ? gt("Project root") : gt("Isolated worktree")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="root">
                    <T>Project root</T>
                  </SelectItem>
                  <SelectItem value="worktree">
                    <T>Isolated worktree</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {task.workspace === "worktree" ? (
              <label className="block text-sm">
                <T>Exact base commit</T>
                <Input
                  value={task.base}
                  onChange={(event) => updateTask(task.taskId, { base: event.target.value })}
                />
              </label>
            ) : null}
            <label className="block text-sm">
              <T>Output slot</T>
              <Input
                value={task.slot}
                onChange={(event) => updateTask(task.taskId, { slot: event.target.value })}
              />
            </label>
            <div className="text-sm">
              <T>Output kind</T>
              <Select
                value={task.kind}
                onValueChange={(value) =>
                  updateTask(task.taskId, {
                    kind: value === "verified-code" ? "verified-code" : "sealed-draft",
                  })
                }
              >
                <SelectTrigger aria-label={gt("Output kind for {title}", { title: source?.title })}>
                  <SelectValue>
                    {task.kind === "verified-code" ? gt("Verified code") : gt("Sealed draft")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="sealed-draft">
                    <T>Sealed draft</T>
                  </SelectItem>
                  <SelectItem value="verified-code">
                    <T>Verified code</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {task.kind === "verified-code" ? (
              <>
                <p className="text-sm">
                  <T>
                    Verified code requires an isolated worktree with an exact base and one focused
                    verification command. Arguments are passed as separate tokens; no shell parsing
                    is applied.
                  </T>
                </p>
                <label className="block text-sm">
                  <T>Verification executable</T>
                  <Input
                    value={task.verificationCommand}
                    onChange={(event) =>
                      updateTask(task.taskId, { verificationCommand: event.target.value })
                    }
                  />
                </label>
                <label className="block text-sm">
                  <T>Arguments, one per line</T>
                  <Textarea
                    value={task.verificationArgs}
                    onChange={(event) =>
                      updateTask(task.taskId, { verificationArgs: event.target.value })
                    }
                  />
                </label>
              </>
            ) : null}
          </div>
        );
      })}
      {edges.map((edge) => {
        const source = plan.edges.find((item) => item.id === edge.edgeId);
        return (
          <div key={edge.edgeId} className="space-y-1 rounded border p-2">
            <p className="text-sm">
              <T>
                <Var>{plan.tasks.find((task) => task.id === source?.fromTaskId)?.title}</Var>{" "}
                requires <Var>{plan.tasks.find((task) => task.id === source?.toTaskId)?.title}</Var>
              </T>
            </p>
            <p className="whitespace-pre-wrap text-sm">{source?.requirement}</p>
            <label className="block text-sm">
              <T>Required output slot</T>
              <Input
                value={edge.slot}
                onChange={(event) =>
                  setEdges((old) =>
                    old.map((item) =>
                      item.edgeId === edge.edgeId ? { ...item, slot: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <div className="text-sm">
              <T>Evidence rule</T>
              <Select
                value={edge.rule}
                onValueChange={(value) =>
                  setEdges((old) =>
                    old.map((item) =>
                      item.edgeId === edge.edgeId
                        ? {
                            ...item,
                            rule: value === "verified-code" ? "verified-code" : "sealed-draft",
                          }
                        : item,
                    ),
                  )
                }
              >
                <SelectTrigger aria-label={gt("Evidence rule for {id}", { id: edge.edgeId })}>
                  <SelectValue>
                    {edge.rule === "verified-code" ? gt("Verified code") : gt("Sealed draft")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="sealed-draft">
                    <T>Sealed draft</T>
                  </SelectItem>
                  <SelectItem value="verified-code">
                    <T>Verified code</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </div>
        );
      })}
      <div>
        <p className="text-sm">
          <T>Threads allowed to request work under this grant</T>
        </p>
        {threads.length === 0 ? (
          <p className="text-xs">
            <T>No eligible project threads. Human start remains separate.</T>
          </p>
        ) : (
          threads.map((thread) => (
            <label className="block text-sm" key={thread.id}>
              <input
                type="checkbox"
                checked={requesters.includes(thread.id)}
                onChange={(event) =>
                  setRequesters((old) =>
                    event.target.checked
                      ? [...old, thread.id]
                      : old.filter((id) => id !== thread.id),
                  )
                }
              />{" "}
              {thread.title}
            </label>
          ))
        )}
      </div>
      <label className="block text-sm">
        <T>Maximum attempts</T>
        <Input
          type="number"
          min={1}
          max={256}
          value={attempts}
          onChange={(event) => setAttempts(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        <T>Retries per task</T>
        <Input
          type="number"
          min={0}
          max={256}
          value={retries}
          onChange={(event) => setRetries(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        <T>Maximum concurrent attempts</T>
        <Input
          type="number"
          min={1}
          max={256}
          value={concurrency}
          onChange={(event) => setConcurrency(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        <T>Grant expiry (local time)</T>
        <Input
          type="datetime-local"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        <input
          type="checkbox"
          checked={ownedWriters}
          onChange={(event) => setOwnedWriters(event.target.checked)}
        />{" "}
        <T>Require owned-writer observation</T>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <Button size="sm" onClick={build}>
        <T>
          Grant exact revision <Var>{plan.revision}</Var>
        </T>
      </Button>
    </fieldset>
  );
}
