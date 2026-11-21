import {
  EnvironmentAuthorizationError,
  FactoryExecutionError,
  type EnvironmentId,
  type FactoryExecutionSelection,
  type FactoryPlanRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import type { EnvironmentPresentation } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isFactoryExecutionError = Schema.is(FactoryExecutionError);
export function FactoryLocalPlans(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly environment: EnvironmentPresentation | undefined;
  readonly canRead: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const available =
    props.canRead &&
    props.environment?.connection.phase === "connected" &&
    props.environment.serverConfig?.environment.capabilities.factoryPlans === true;
  return (
    <View className="items-start gap-2">
      <Button
        label={open ? gt("Hide local tasks") : gt("Local tasks")}
        onPress={() => setOpen(!open)}
      />
      {open && !available ? (
        <Text className="text-sm text-foreground-muted">
          <T>Connect to a server with local plans and read permission to inspect tasks.</T>
        </Text>
      ) : null}
      {open && available ? (
        <LocalPlans
          environmentId={props.environmentId}
          projectId={props.projectId}
          executionSupported={
            props.environment?.serverConfig?.environment.capabilities.factoryExecution === true
          }
        />
      ) : null}
    </View>
  );
}

function LocalPlans(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly executionSupported: boolean;
}) {
  const gt = useGT();
  const [afterRootId, setAfterRootId] = useState<string | undefined>();
  const [selection, setSelection] = useState<{
    readonly ref: FactoryPlanRef;
    readonly revision: number;
  } | null>(null);
  const query = useEnvironmentQuery(
    factoryEnvironment.listPlans({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, limit: 50, afterRootId },
    }),
  );
  return (
    <View className="self-stretch gap-2 rounded-2xl border border-border-subtle p-3">
      <Text className="text-base font-t3-medium text-foreground">
        <T>Local tasks</T>
      </Text>
      <Text className="text-sm text-foreground-muted">
        <T>Read-only on mobile. Authoring and execution grants are available on web or desktop.</T>
      </Text>
      {selection ? (
        <PlanReader
          key={`${selection.ref.rootId}:${selection.revision}`}
          selection={selection}
          executionSupported={props.executionSupported}
          onClose={() => setSelection(null)}
        />
      ) : query.error ? (
        <View className="items-start gap-2">
          <Text className="text-sm text-danger-foreground">{query.error}</Text>
          <Button label={gt("Try again")} onPress={query.refresh} />
        </View>
      ) : query.data ? (
        <>
          {query.data.items.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No local tasks on this page.</T>
            </Text>
          ) : null}
          {query.data.items.map((item) => (
            <Button
              key={item.ref.rootId}
              label={gt("{title} · revision {revision}", {
                title: item.title,
                revision: String(item.revision),
              })}
              onPress={() => setSelection({ ref: item.ref, revision: item.revision })}
            />
          ))}
          <View className="flex-row flex-wrap gap-2">
            {afterRootId ? (
              <Button label={gt("First page")} onPress={() => setAfterRootId(undefined)} />
            ) : null}
            {query.data.nextRootId ? (
              <Button
                label={gt("Next page")}
                onPress={() => setAfterRootId(query.data?.nextRootId ?? undefined)}
              />
            ) : null}
            <Button label={gt("Refresh tasks")} onPress={query.refresh} />
          </View>
        </>
      ) : (
        <Text className="text-sm text-foreground-muted">
          <T>Loading tasks…</T>
        </Text>
      )}
    </View>
  );
}

function PlanReader(props: {
  readonly selection: { readonly ref: FactoryPlanRef; readonly revision: number };
  readonly executionSupported: boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [taskId, setTaskId] = useState(props.selection.ref.rootId);
  const query = useEnvironmentQuery(
    factoryEnvironment.readPlan({
      environmentId: props.selection.ref.environmentId,
      input: props.selection,
    }),
  );
  const plan = query.error === null ? query.data : null;
  const task = plan?.tasks.find((entry) => entry.id === taskId);
  return (
    <View className="items-start gap-2 self-stretch">
      <Button label={gt("Back to local tasks")} onPress={props.onClose} />
      {query.error ? <Text className="text-sm text-danger-foreground">{query.error}</Text> : null}
      {plan && task ? (
        <>
          <Text className="text-base font-t3-medium text-foreground" selectable>
            {task.title}
          </Text>
          <Text className="text-xs text-foreground-muted" selectable>
            {gt("Revision {revision} · task {id}", {
              revision: String(plan.revision),
              id: task.id,
            })}
          </Text>
          <Text className="text-sm text-foreground" selectable>
            {task.context}
          </Text>
          {task.parentId ? (
            <Button
              label={gt("Return to parent task")}
              onPress={() => setTaskId(task.parentId ?? plan.ref.rootId)}
            />
          ) : null}
          {plan.tasks
            .filter((entry) => entry.parentId === task.id && !entry.retired)
            .map((child) => (
              <Button
                key={child.id}
                label={gt("Read {title}", { title: child.title })}
                onPress={() => setTaskId(child.id)}
              />
            ))}
          {props.executionSupported ? (
            <TaskResults key={task.id} selection={{ ...props.selection, taskId: task.id }} />
          ) : (
            <Text className="text-sm text-foreground-muted">
              <T>This server does not support local execution results.</T>
            </Text>
          )}
        </>
      ) : query.error === null ? (
        <Text className="text-sm text-foreground-muted">
          <T>Loading task…</T>
        </Text>
      ) : null}
    </View>
  );
}

function TaskResults({ selection }: { readonly selection: FactoryExecutionSelection }) {
  const gt = useGT();
  const [resultId, setResultId] = useState<string | null>(null);
  const [beforeResultId, setBeforeResultId] = useState<string | undefined>();
  const execution = useEnvironmentQuery(
    factoryEnvironment.readExecution({
      environmentId: selection.ref.environmentId,
      input: { ref: selection.ref, revision: selection.revision },
    }),
  );
  const outputs = useEnvironmentQuery(
    factoryEnvironment.readExecutionOutputs({
      environmentId: selection.ref.environmentId,
      input: {
        ref: selection.ref,
        revision: selection.revision,
        taskId: selection.taskId,
        beforeResultId,
        limit: 50,
      },
    }),
  );
  const output = useEnvironmentQuery(
    resultId
      ? factoryEnvironment.readExecutionOutput({
          environmentId: selection.ref.environmentId,
          input: { selection, resultId },
        })
      : null,
  );
  const denied = [execution.failure, outputs.failure, output.failure].some(
    (failure) =>
      isEnvironmentAuthorizationError(failure) ||
      (isFactoryExecutionError(failure) && failure.reason === "forbidden"),
  );
  if (denied)
    return (
      <Text className="text-sm text-danger-foreground">
        <T>Read access to execution results is unavailable.</T>
      </Text>
    );
  const state =
    execution.error === null
      ? execution.data?.tasks.find((entry) => entry.taskId === selection.taskId)
      : null;
  return (
    <View className="items-start gap-2 self-stretch border-t border-border-subtle pt-3">
      <Text className="text-base font-t3-medium text-foreground">
        <T>Execution and results</T>
      </Text>
      {execution.error ? (
        <Text className="text-sm text-danger-foreground">{execution.error}</Text>
      ) : state ? (
        <Text className="text-sm text-foreground" selectable>
          {state.status}
          {state.hold ? ` · ${state.hold}` : ""}
          {state.binding?.stopRequested ? gt(" · stop requested") : ""}
          {state.binding && !state.binding.quiescent ? gt(" · quiescence not established") : ""}
        </Text>
      ) : (
        <Text className="text-sm text-foreground-muted">
          <T>Loading execution…</T>
        </Text>
      )}
      {execution.error === null &&
      execution.data?.currentRevision !== undefined &&
      execution.data.currentRevision !== selection.revision ? (
        <Text className="text-sm text-foreground-muted">
          {gt("Historical revision; current revision is {revision}.", {
            revision: String(execution.data.currentRevision),
          })}
        </Text>
      ) : null}
      {resultId ? (
        <View className="items-start gap-2 self-stretch">
          <Button label={gt("Back to results")} onPress={() => setResultId(null)} />
          {output.error ? (
            <Text className="text-sm text-danger-foreground">{output.error}</Text>
          ) : output.data ? (
            <>
              <Text className="text-sm text-foreground-muted" selectable>
                {gt("{kind} · {status} · digest {digest}", {
                  kind: output.data.output.kind,
                  status: output.data.output.status,
                  digest: output.data.output.digest,
                })}
              </Text>
              <Text className="text-sm text-foreground-muted" selectable>
                {gt(
                  "Model {model} · harness {driver} · provider instance {instance} · environment {environment} · thread {thread} · run {run} · attempt {attempt}",
                  {
                    model: output.data.binding.spec.modelSelection.model,
                    driver: output.data.binding.driver,
                    instance: output.data.binding.spec.modelSelection.instanceId,
                    environment: output.data.binding.selection.ref.environmentId,
                    thread: output.data.binding.threadId,
                    run: output.data.binding.runId,
                    attempt: output.data.binding.runAttemptId,
                  },
                )}
              </Text>
              <Text className="text-base text-foreground" selectable>
                {output.data.text}
              </Text>
            </>
          ) : (
            <Text className="text-sm text-foreground-muted">
              <T>Loading retained result…</T>
            </Text>
          )}
        </View>
      ) : outputs.error ? (
        <Text className="text-sm text-danger-foreground">{outputs.error}</Text>
      ) : outputs.data ? (
        <>
          {outputs.data.items.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No retained results on this page.</T>
            </Text>
          ) : null}
          {outputs.data.items.map((output) => (
            <Button
              key={output.resultId}
              label={gt("Read {slot} · {status}", {
                slot: output.slot,
                status: output.status,
              })}
              onPress={() => setResultId(output.resultId)}
            />
          ))}
          <View className="flex-row flex-wrap gap-2">
            {beforeResultId ? (
              <Button label={gt("First results")} onPress={() => setBeforeResultId(undefined)} />
            ) : null}
            {outputs.data.nextBeforeResultId ? (
              <Button
                label={gt("More results")}
                onPress={() => setBeforeResultId(outputs.data?.nextBeforeResultId ?? undefined)}
              />
            ) : null}
            <Button
              label={gt("Refresh results")}
              onPress={() => {
                execution.refresh();
                outputs.refresh();
              }}
            />
          </View>
        </>
      ) : (
        <Text className="text-sm text-foreground-muted">
          <T>Loading results…</T>
        </Text>
      )}
    </View>
  );
}
