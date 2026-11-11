import {
  factoryTaskConnectionStatus,
  factoryTaskQueryStatus,
} from "@t3tools/client-runtime/state/factory-task-list";
import { factoryTaskKey } from "@t3tools/client-runtime/state/factory-task-view";
import {
  AuthOrchestrationReadScope,
  FactoryTaskDisplayId,
  type EnvironmentId,
  FactoryTaskError,
  type FactoryTaskDetail,
  sessionGrantsScope,
} from "@t3tools/contracts";
import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { useFactoryTaskDetailByDisplayId } from "../../../state/factoryTasks";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { useEnvironmentSessionState } from "../../../state/session";
import { PageHeader } from "../kit";
import { TaskPageFrame } from "../TaskPageFrame";
import { TaskDetail, type TaskDetailTab } from "./TaskDetail";

const ROUTE = "/_chat/tasks/$environmentId/$displayId";
const isDisplayId = Schema.is(FactoryTaskDisplayId);
const isTaskError = Schema.is(FactoryTaskError);

export function TaskDetailPage() {
  const { environmentId, displayId } = useParams({ from: ROUTE });
  const search = useSearch({ from: ROUTE });
  const navigate = useNavigate();
  const tab: TaskDetailTab = search.tab ?? "activity";
  const setTab = (next: TaskDetailTab) =>
    void navigate({
      to: "/tasks/$environmentId/$displayId",
      params: { environmentId, displayId },
      search: next === "activity" ? {} : { tab: next },
      replace: true,
    });
  if (!isDisplayId(displayId))
    return <TaskDetailState displayId={displayId} state={{ kind: "missing" }} />;
  return (
    <TaskDetailLoader
      environmentId={environmentId as EnvironmentId}
      displayId={displayId}
      tab={tab}
      onTabChange={setTab}
    />
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "offline"; machine: string }
  | { kind: "missing" }
  | { kind: "forbidden" }
  | { kind: "unsupported"; detail?: string }
  | { kind: "failed" };

/** `link` is where the machine's connection stands: up, still being made the first time, or down. */
function loadState(
  result: AsyncResult.AsyncResult<FactoryTaskDetail, unknown>,
  link: "connected" | "starting" | "down",
  machine: string,
): LoadState {
  if (result._tag === "Failure") {
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    if (isTaskError(error) && error.reason === "missing-task") return { kind: "missing" };
    const status = factoryTaskQueryStatus(result);
    if (status === "forbidden" || status === "unsupported") return { kind: status };
    return link === "down" ? { kind: "offline", machine } : { kind: "failed" };
  }
  return link === "down" ? { kind: "offline", machine } : { kind: "loading" };
}

function TaskDetailLoader({
  environmentId,
  displayId,
  tab,
  onTabChange,
}: {
  environmentId: EnvironmentId;
  displayId: FactoryTaskDisplayId;
  tab: TaskDetailTab;
  onTabChange: (tab: TaskDetailTab) => void;
}) {
  const result = useFactoryTaskDetailByDisplayId(environmentId, displayId);
  const { isReady, presentation } = useEnvironmentPresentation(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  if (
    presentation?.connection.phase === "connected" &&
    session.data !== null &&
    !session.hasError &&
    !sessionGrantsScope(session.data, AuthOrchestrationReadScope)
  )
    return <TaskDetailState displayId={displayId} state={{ kind: "forbidden" }} />;
  if (result._tag === "Success")
    return (
      <TaskDetail
        key={factoryTaskKey(result.value.task.ref)}
        detail={result.value}
        tab={tab}
        onTabChange={onTabChange}
      />
    );
  const phase = presentation?.connection.phase;
  const connection = factoryTaskConnectionStatus(phase, isReady);
  if (connection === "unsupported") {
    const detail = presentation?.connection.error;
    return (
      <TaskDetailState
        displayId={displayId}
        state={detail ? { kind: "unsupported", detail } : { kind: "unsupported" }}
      />
    );
  }
  const link = connection === null ? "connected" : connection === "loading" ? "starting" : "down";
  const machine = presentation?.entry.target.label ?? "This machine";
  return <TaskDetailState displayId={displayId} state={loadState(result, link, machine)} />;
}

function TaskDetailState({ displayId, state }: { displayId: string; state: LoadState }) {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const back = () => (canGoBack ? router.history.back() : void router.navigate({ to: "/tasks" }));
  let message: ReactNode;
  switch (state.kind) {
    case "loading":
      message = <p role="status">Loading {displayId}…</p>;
      break;
    case "offline":
      message = (
        <p role="status">
          {state.machine} is offline. {displayId} shows when it reconnects.
        </p>
      );
      break;
    case "missing":
      message = <p role="alert">There is no task {displayId} on this machine.</p>;
      break;
    case "forbidden":
      message = <p role="alert">You don't have access to tasks on this machine.</p>;
      break;
    case "unsupported":
      message = (
        <p role="alert">{state.detail ?? "Update this machine's T3 Code server to use tasks."}</p>
      );
      break;
    case "failed":
      message = (
        <p role="alert" className="text-destructive-foreground">
          Couldn't load {displayId}. Check the machine's connection and reload.
        </p>
      );
      break;
  }
  return (
    <TaskPageFrame
      header={
        <PageHeader
          onBack={back}
          breadcrumb={[{ label: "Tasks", render: <Link to="/tasks" /> }, { label: displayId }]}
        />
      }
    >
      <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
        {message}
      </div>
    </TaskPageFrame>
  );
}
