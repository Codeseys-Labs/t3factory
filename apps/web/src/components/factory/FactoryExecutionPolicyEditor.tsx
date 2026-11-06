import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  FactoryExecutionPolicy,
  type FactoryPlanSnapshot,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

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

const decodePolicy = Schema.decodeUnknownSync(FactoryExecutionPolicy);

export function FactoryExecutionPolicyEditor(props: {
  readonly plan: FactoryPlanSnapshot;
  readonly project: EnvironmentProject;
  readonly disabled: boolean;
  readonly onGrant: (policy: FactoryExecutionPolicy) => void;
}) {
  const { plan } = props;
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
    try {
      const time = new Date(expiry);
      const policy = decodePolicy({
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
      if (
        !expiry ||
        time.getTime() <= Date.now() ||
        !attempts ||
        !retries ||
        !concurrency ||
        policy.maxAttempts < 1 ||
        policy.maxConcurrent < 1 ||
        tasks.some((task) => task.kind === "verified-code" && task.workspace !== "worktree")
      )
        throw new Error();
      setError(null);
      props.onGrant(policy);
    } catch {
      setError(
        "Choose a model for each task, a future expiry, valid limits, and an exact commit for each isolated workspace. Verified code also needs an isolated workspace and a verification executable.",
      );
    }
  };
  return (
    <fieldset className="space-y-4" disabled={props.disabled}>
      <legend className="font-medium">Grant revision {plan.revision}</legend>
      <p className="text-sm">
        This authorizes local preparation only. It does not authorize publication or guarantee a
        shell or network sandbox. Setup is denied; tasks use supervised approval-required mode.
        Unsupported requested capabilities are refused.
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
            <span className="text-sm">Provider and model</span>
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
              <p>No provider configured.</p>
            )}
            <div className="text-sm">
              Workspace
              <Select
                value={task.workspace}
                onValueChange={(value) =>
                  updateTask(task.taskId, { workspace: value === "worktree" ? "worktree" : "root" })
                }
              >
                <SelectTrigger aria-label={`Workspace for ${source?.title}`}>
                  <SelectValue>
                    {task.workspace === "root" ? "Project root" : "Isolated worktree"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="root">Project root</SelectItem>
                  <SelectItem value="worktree">Isolated worktree</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {task.workspace === "worktree" ? (
              <label className="block text-sm">
                Exact base commit
                <Input
                  value={task.base}
                  onChange={(event) => updateTask(task.taskId, { base: event.target.value })}
                />
              </label>
            ) : null}
            <label className="block text-sm">
              Output slot
              <Input
                value={task.slot}
                onChange={(event) => updateTask(task.taskId, { slot: event.target.value })}
              />
            </label>
            <div className="text-sm">
              Output kind
              <Select
                value={task.kind}
                onValueChange={(value) =>
                  updateTask(task.taskId, {
                    kind: value === "verified-code" ? "verified-code" : "sealed-draft",
                  })
                }
              >
                <SelectTrigger aria-label={`Output kind for ${source?.title}`}>
                  <SelectValue>
                    {task.kind === "verified-code" ? "Verified code" : "Sealed draft"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="sealed-draft">Sealed draft</SelectItem>
                  <SelectItem value="verified-code">Verified code</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {task.kind === "verified-code" ? (
              <>
                <p className="text-sm">
                  Verified code requires an isolated worktree with an exact base and one focused
                  verification command. Arguments are passed as separate tokens; no shell parsing is
                  applied.
                </p>
                <label className="block text-sm">
                  Verification executable
                  <Input
                    value={task.verificationCommand}
                    onChange={(event) =>
                      updateTask(task.taskId, { verificationCommand: event.target.value })
                    }
                  />
                </label>
                <label className="block text-sm">
                  Arguments, one per line
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
              {plan.tasks.find((task) => task.id === source?.fromTaskId)?.title} requires{" "}
              {plan.tasks.find((task) => task.id === source?.toTaskId)?.title}
            </p>
            <p className="whitespace-pre-wrap text-sm">{source?.requirement}</p>
            <label className="block text-sm">
              Required output slot
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
              Evidence rule
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
                <SelectTrigger aria-label={`Evidence rule for ${edge.edgeId}`}>
                  <SelectValue>
                    {edge.rule === "verified-code" ? "Verified code" : "Sealed draft"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="sealed-draft">Sealed draft</SelectItem>
                  <SelectItem value="verified-code">Verified code</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </div>
        );
      })}
      <div>
        <p className="text-sm">Threads allowed to request work under this grant</p>
        {threads.length === 0 ? (
          <p className="text-xs">No eligible project threads. Human start remains separate.</p>
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
        Maximum attempts
        <Input
          type="number"
          min={1}
          max={256}
          value={attempts}
          onChange={(event) => setAttempts(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Retries per task
        <Input
          type="number"
          min={0}
          max={256}
          value={retries}
          onChange={(event) => setRetries(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Maximum concurrent attempts
        <Input
          type="number"
          min={1}
          max={256}
          value={concurrency}
          onChange={(event) => setConcurrency(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Grant expiry (local time)
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
        Require owned-writer observation
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <Button size="sm" onClick={build}>
        Grant exact revision {plan.revision}
      </Button>
    </fieldset>
  );
}
