import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentAuthorizationError,
  FactoryPlanError,
  sessionGrantsScope,
  type EnvironmentId,
  type FactoryPlanApplyInput,
  type FactoryPlanCreateInput,
  type FactoryPlanOperation,
  type FactoryPlanRef,
  type FactoryPlanSnapshot,
  type FactoryPlanTask,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useId, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useProjects, useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import {
  factoryEnvironment,
  factoryIssueKeysInput,
  useFactoryIssueKeysSupported,
} from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { m, type MessageResolver } from "~/i18n/messages";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { FactoryCheckoutChooser } from "./FactoryCheckoutChooser";
import { FactoryExecutionPanel } from "./FactoryExecutionPanel";
import { singleFactoryMember } from "./factoryScope";

const isPlanError = Schema.is(FactoryPlanError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export function FactoryPlanEditor() {
  const gt = useGT();
  const { scope, groups, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const member = singleFactoryMember(scope);
  const owner = environments.find((entry) => entry.environmentId === member?.environmentId);
  const project = projects.find(
    (entry) => entry.environmentId === member?.environmentId && entry.id === member?.id,
  );
  if (scope.kind === "unavailable") return <p role="status">{scope.message}</p>;
  if (member === null)
    return (
      <FactoryCheckoutChooser
        scope={scope}
        groups={groups}
        environments={environments}
        intro={gt("Choose one checkout to edit its local plans.")}
        emptyDescription={gt("Add a project to start planning.")}
        statusFor={(environment) =>
          environment?.connection.phase === "connected" ? gt("Connected") : gt("Offline")
        }
        onChoose={selectScope}
      />
    );
  return owner && project ? (
    <CheckoutPlanEditor
      key={`${member.environmentId}:${member.id}`}
      owner={owner}
      projectId={member.id}
      projectTitle={project.title}
    />
  ) : (
    <p role="status">
      <T>Checkout unavailable. Choose another checkout.</T>
    </p>
  );
}

function CheckoutPlanEditor(props: {
  readonly owner: EnvironmentPresentation;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}) {
  const { owner } = props;
  const gt = useGT();
  const canRead = useEnvironmentScope(owner.environmentId, AuthOrchestrationReadScope);
  const session = useEnvironmentSessionState(owner.environmentId);
  const connected = owner.connection.phase === "connected";
  const retainedReadGrant =
    session.data !== null && sessionGrantsScope(session.data, AuthOrchestrationReadScope);
  const supported = owner.serverConfig?.environment.capabilities.factoryPlans === true;
  const active = connected && supported && canRead;
  const unavailable = !connected
    ? gt("Reconnect this environment to read plans.")
    : owner.serverConfig === null
      ? gt("Waiting for server capabilities…")
      : owner.serverConfig.environment.capabilities.factoryPlans !== true
        ? gt("This server does not support local plans. Update it to continue.")
        : !canRead
          ? retainedReadGrant
            ? gt("Waiting for read access to be verified…")
            : gt("Read access is required to view plans.")
          : null;
  return (
    <>
      {unavailable !== null ? <p role="status">{unavailable}</p> : null}
      {(canRead || retainedReadGrant) &&
      (!connected || owner.serverConfig === null || supported) ? (
        <div hidden={!active}>
          <PlanWorkspace
            environmentId={owner.environmentId}
            projectId={props.projectId}
            projectTitle={props.projectTitle}
            workSupported={owner.serverConfig?.environment.capabilities.factoryWork === true}
            executionSupported={
              owner.serverConfig?.environment.capabilities.factoryExecution === true
            }
            active={active}
          />
        </div>
      ) : null}
    </>
  );
}

function PlanWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly workSupported: boolean;
  readonly executionSupported: boolean;
  readonly active: boolean;
}) {
  const { environmentId, projectId } = props;
  const gt = useGT();
  const [pages, setPages] = useState<readonly (string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<FactoryPlanRef | null>(null);
  const [creating, setCreating] = useState(false);
  const query = useEnvironmentQuery(
    props.active
      ? factoryEnvironment.listPlans({
          environmentId,
          input: { projectId, limit: 25, afterRootId: pages.at(-1) },
        })
      : null,
  );
  const canCreate = useAtomValue(factoryEnvironment.createPlan.permissionAtom(environmentId));
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label={gt("Local plans")}>
      <div className="space-y-1">
        <h3 className="font-medium">
          <T>
            Local plans · <Var>{props.projectTitle}</Var>
          </T>
        </h3>
        <p className="text-sm text-muted-foreground">
          <T>
            Organize tasks and requirements. Work references retain the context observed when
            attached.
          </T>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!canCreate || creating} onClick={() => setCreating(true)}>
          <T>New plan</T>
        </Button>
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          <T>Refresh plans</T>
        </Button>
      </div>
      {query.error !== null ? <p role="alert">{query.error}</p> : null}
      {!isReadDenied(query.failure) ? (
        <>
          {creating ? (
            <CreatePlan
              environmentId={environmentId}
              projectId={projectId}
              onCreated={(ref) => {
                setCreating(false);
                setSelected(ref);
                query.refresh();
              }}
              onClose={() => setCreating(false)}
            />
          ) : null}
          {query.isPending ? (
            <p role="status">
              <T>Loading plans…</T>
            </p>
          ) : null}
          {query.data?.items.length === 0 ? (
            <p>
              <T>No plans on this page.</T>
            </p>
          ) : null}
          <ul className="space-y-2" aria-label={gt("Plans")}>
            {query.data?.items.map((item) => (
              <li key={item.ref.rootId}>
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={selected?.rootId === item.ref.rootId}
                  onClick={() => setSelected(item.ref)}
                >
                  {gt("{title} · revision {revision}{retired}", {
                    title: item.title,
                    revision: String(item.revision),
                    retired: item.retired ? " · retired" : "",
                  })}
                </Button>
              </li>
            ))}
          </ul>
          <PageButtons
            previous={pages.length > 1}
            next={query.data?.nextRootId != null && pages.length < 20}
            disabled={query.isPending}
            onPrevious={() => setPages((old) => old.slice(0, -1))}
            onNext={() => {
              const next = query.data?.nextRootId;
              if (next) setPages((old) => [...old, next]);
            }}
          />
          {pages.length >= 20 ? (
            <p className="text-xs text-muted-foreground">
              <T>Page limit reached. Go back to inspect earlier plans.</T>
            </p>
          ) : null}
          {selected ? (
            <SelectedPlan
              key={selected.rootId}
              reference={selected}
              workSupported={props.workSupported}
              executionSupported={props.executionSupported}
              active={props.active}
              onChanged={query.refresh}
            />
          ) : null}
        </>
      ) : null}
      {!canCreate ? (
        <p className="text-xs text-muted-foreground">
          <T>Creating and editing plans requires operate permission.</T>
        </p>
      ) : null}
    </section>
  );
}

function CreatePlan(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onCreated: (ref: FactoryPlanRef) => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [request, setRequest] = useState<FactoryPlanCreateInput | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canCreate = useAtomValue(factoryEnvironment.createPlan.permissionAtom(props.environmentId));
  const create = useAtomCommand(factoryEnvironment.createPlan, {
    label: "create local plan",
    reportFailure: false,
  });
  const submit = async () => {
    if (inFlight.current || !canCreate || !title.trim()) return;
    const input = request ?? {
      commandId: CommandId.make(randomUUID()),
      projectId: props.projectId,
      title: title.trim(),
      context,
    };
    setRequest(input);
    setPending(true);
    setFailure(null);
    inFlight.current = true;
    const result = await create({ environmentId: props.environmentId, input });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Success") props.onCreated(result.value.plan.ref);
    else {
      const error = squashAtomCommandFailure(result);
      setFailure(failureMessage(error));
      if (isPlanError(error) && error.reason !== "persistence-failure") setRequest(null);
    }
  };
  return (
    <form
      className="space-y-3 rounded border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="space-y-3" disabled={pending || request !== null || !canCreate}>
        <legend className="font-medium text-sm">
          <T>New root task</T>
        </legend>
        <Label htmlFor={`${id}-title`}>
          <T>Title</T>
        </Label>
        <Input
          id={`${id}-title`}
          value={title}
          maxLength={512}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
        <Label htmlFor={`${id}-context`}>
          <T>Context</T>
        </Label>
        <Textarea
          id={`${id}-context`}
          value={context}
          maxLength={8000}
          onChange={(event) => setContext(event.target.value)}
        />
      </fieldset>
      {failure ? (
        <p role="alert">
          {failure}{" "}
          {request ? (
            <T>Retry uses the same request.</T>
          ) : (
            <T>Review the draft before trying again.</T>
          )}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={pending || !canCreate || !title.trim()}>
          {pending ? <T>Creating…</T> : request ? <T>Retry creation</T> : <T>Create plan</T>}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={pending || request !== null}
          onClick={props.onClose}
        >
          <T>Cancel</T>
        </Button>
      </div>
    </form>
  );
}

function SelectedPlan(props: {
  readonly reference: FactoryPlanRef;
  readonly workSupported: boolean;
  readonly executionSupported: boolean;
  readonly onChanged: () => void;
  readonly active: boolean;
}) {
  const { reference } = props;
  const query = useEnvironmentQuery(
    props.active
      ? factoryEnvironment.readPlan({
          environmentId: reference.environmentId,
          input: { ref: reference },
        })
      : null,
  );
  const denied = isReadDenied(query.failure);
  const [retained, setRetained] = useState(query.data);
  if (denied && retained !== null) setRetained(null);
  else if (!denied && retained === null && query.data !== null) setRetained(query.data);
  const observed = denied ? null : (query.data ?? retained);
  return (
    <div className="space-y-3">
      {query.error !== null ? <p role="alert">{query.error}</p> : null}
      {observed ? (
        <PlanDraft
          initial={observed}
          observed={observed}
          refreshing={query.isPending}
          readUnavailable={!props.active || !query.isSuccess}
          refresh={query.refresh}
          workSupported={props.active && props.workSupported}
          onChanged={props.onChanged}
        />
      ) : !denied ? (
        <p role="status">
          <T>Loading plan…</T>
        </p>
      ) : null}
      {props.active && query.error === null ? <PlanHistory reference={reference} /> : null}
      {props.active && query.isSuccess && query.data && props.executionSupported ? (
        <FactoryExecutionPanel
          key={`${reference.rootId}:${query.data.revision}`}
          plan={query.data}
        />
      ) : null}
    </div>
  );
}

function PlanDraft(props: {
  readonly initial: FactoryPlanSnapshot;
  readonly observed: FactoryPlanSnapshot;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  readonly workSupported: boolean;
  readonly onChanged: () => void;
  readonly readUnavailable: boolean;
}) {
  const [base, setBase] = useState(props.initial);
  const [operations, setOperations] = useState<
    readonly { queueId: string; operation: FactoryPlanOperation }[]
  >([]);
  const [request, setRequest] = useState<FactoryPlanApplyInput | null>(null);
  const [pending, setPending] = useState(false);
  const [review, setReview] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const environmentId = base.ref.environmentId;
  const gt = useGT();
  const messages = useMessages();
  const canApply = useAtomValue(factoryEnvironment.applyPlan.permissionAtom(environmentId));
  const apply = useAtomCommand(factoryEnvironment.applyPlan, {
    label: "apply local plan edits",
    reportFailure: false,
  });
  const blocked =
    pending ||
    props.readUnavailable ||
    !canApply ||
    request !== null ||
    review ||
    operations.length >= 128;
  const queue = (operation: FactoryPlanOperation) => {
    if (!blocked) setOperations((old) => [...old, { queueId: randomUUID(), operation }]);
  };
  const submit = async () => {
    if (
      inFlight.current ||
      props.readUnavailable ||
      !canApply ||
      review ||
      (request === null && operations.length === 0)
    )
      return;
    const input = request ?? {
      commandId: CommandId.make(randomUUID()),
      ref: base.ref,
      expectedRevision: base.revision,
      operations: operations.map((entry) => entry.operation),
    };
    inFlight.current = true;
    setPending(true);
    setRequest(input);
    setFailure(null);
    const result = await apply({ environmentId, input });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Success") {
      setRequest(null);
      setOperations([]);
      setBase(result.value.plan);
      setReview(!result.value.current);
      if (!result.value.current)
        setFailure(
          m(
            msg(
              "This request was already saved at an older revision. Reload the current plan before editing.",
            ),
          ),
        );
      props.refresh();
      props.onChanged();
    } else {
      const error = squashAtomCommandFailure(result);
      setFailure(failureMessage(error));
      if (isPlanError(error) && error.reason !== "persistence-failure") {
        setRequest(null);
        setReview(true);
        props.refresh();
      }
    }
  };
  const reload = (keepDraft: boolean) => {
    if (
      pending ||
      props.readUnavailable ||
      request !== null ||
      props.refreshing ||
      props.observed.revision < base.revision
    )
      return;
    setBase(props.observed);
    if (!keepDraft) setOperations([]);
    setReview(false);
    setFailure(null);
  };
  return (
    <section
      className="space-y-4 rounded border p-3"
      aria-label={gt("Plan editor")}
      aria-busy={pending}
    >
      <p className="text-sm">
        <T>
          Editing revision <Var>{base.revision}</Var> · root{" "}
          <code>
            <Var>{base.ref.rootId}</Var>
          </code>
        </T>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || props.refreshing}
          onClick={props.refresh}
        >
          <T>Read current revision</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || props.readUnavailable || request !== null || props.refreshing}
          onClick={() => reload(false)}
        >
          <T>Reload and discard queued edits</T>
        </Button>
        {operations.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || props.readUnavailable || request !== null || props.refreshing}
            onClick={() => reload(true)}
          >
            <T>
              Rebase queued edits onto revision <Var>{props.observed.revision}</Var>
            </T>
          </Button>
        ) : null}
      </div>
      {props.observed.revision !== base.revision ? (
        <p role="status">
          <T>
            Current revision is <Var>{props.observed.revision}</Var>. Your draft still targets
            revision <Var>{base.revision}</Var>. Review it and explicitly reload or rebase.
          </T>
        </p>
      ) : null}
      {failure ? (
        <p role="alert">
          {failure}{" "}
          {request ? (
            <T>The outcome may be uncertain. Retry preserves the exact request.</T>
          ) : (
            <T>Your queued edits are retained. Review the current plan before rebasing.</T>
          )}
        </p>
      ) : null}
      {!canApply ? (
        <p role="status">
          <T>Editing requires operate permission on this environment.</T>
        </p>
      ) : null}
      <fieldset className="min-w-0 space-y-4" disabled={blocked}>
        <legend className="font-medium">
          <T>Tasks</T>
        </legend>
        <ul className="space-y-3">
          {base.tasks
            .toSorted((a, b) => a.order - b.order)
            .map((task) => (
              <li key={task.id}>
                <TaskEditor
                  key={`${base.revision}:${task.id}`}
                  task={task}
                  tasks={base.tasks}
                  queue={queue}
                />
              </li>
            ))}
        </ul>
        <TaskEditor key={`add:${base.revision}`} task={null} tasks={base.tasks} queue={queue} />
        <RequirementEditor plan={base} queue={queue} />
        <WorkContexts plan={base} queue={queue} workSupported={props.workSupported} />
        <EditorGrants plan={base} queue={queue} />
      </fieldset>
      {operations.length > 0 ? (
        <div className="space-y-2">
          <h4 className="font-medium text-sm">
            <T>
              Queued edits (<Var>{operations.length}</Var>/128)
            </T>
          </h4>
          <ol className="list-inside list-decimal space-y-1">
            {operations.map(({ queueId, operation }, index) => (
              <li key={queueId} className="text-sm">
                <span className="whitespace-pre-wrap break-words">
                  {operationDescription(operation, base.tasks, messages)}
                </span>{" "}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending || request !== null}
                  onClick={() =>
                    setOperations((old) => old.filter((_, position) => position !== index))
                  }
                >
                  <T>
                    Remove edit <Var>{index + 1}</Var>
                  </T>
                </Button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <Button
        size="sm"
        disabled={
          pending ||
          props.readUnavailable ||
          !canApply ||
          review ||
          (operations.length === 0 && request === null)
        }
        onClick={() => void submit()}
      >
        {pending ? <T>Saving…</T> : request ? <T>Retry same save</T> : <T>Apply queued edits</T>}
      </Button>
    </section>
  );
}

function TaskChoice(props: {
  readonly label: string;
  readonly tasks: readonly FactoryPlanTask[];
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const id = useId();
  const gt = useGT();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Select
        value={props.value}
        onValueChange={(value) => {
          if (typeof value === "string") props.onChange(value);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue>
            {props.tasks.find((task) => task.id === props.value)?.title ?? <T>Choose a task</T>}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {props.tasks.map((task) => (
            <SelectItem key={task.id} value={task.id}>
              {gt("{title} ({id}){retired}", {
                title: task.title,
                id: task.id.slice(-8),
                retired: task.retired ? " · retired" : "",
              })}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function TaskEditor(props: {
  readonly task: FactoryPlanTask | null;
  readonly tasks: readonly FactoryPlanTask[];
  readonly queue: (operation: FactoryPlanOperation) => void;
}) {
  const id = useId();
  const gt = useGT();
  const [title, setTitle] = useState(props.task?.title ?? "");
  const [context, setContext] = useState(props.task?.context ?? "");
  const [order, setOrder] = useState(String(props.task?.order ?? props.tasks.length));
  const [parentId, setParentId] = useState(
    props.task?.parentId ?? props.tasks.find((task) => task.parentId === null)?.id ?? null,
  );
  const task = props.task;
  const validOrder = Number.isSafeInteger(Number(order)) && order.trim().length > 0;
  return (
    <details className="space-y-3 rounded border p-3" open={task === null}>
      <summary className="cursor-pointer font-medium text-sm">
        {task ? (
          <T>
            <Var>{task.title}</Var>
            <Var>{task.retired ? " · retired" : ""}</Var>
          </T>
        ) : (
          <T>Add a task</T>
        )}
      </summary>
      {task ? (
        <p className="text-xs text-muted-foreground">
          {task.parentId === null
            ? gt("Root task")
            : gt("Parent: {title}", {
                title:
                  props.tasks.find((candidate) => candidate.id === task.parentId)?.title ??
                  task.parentId,
              })}{" "}
          · <code>{task.id}</code>
        </p>
      ) : null}
      <Label htmlFor={`${id}-title`}>
        <T>Title</T>
      </Label>
      <Input
        id={`${id}-title`}
        value={title}
        maxLength={512}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Label htmlFor={`${id}-context`}>
        <T>Context</T>
      </Label>
      <Textarea
        id={`${id}-context`}
        value={context}
        maxLength={8000}
        onChange={(event) => setContext(event.target.value)}
      />
      <Label htmlFor={`${id}-order`}>
        <T>Order</T>
      </Label>
      <Input
        id={`${id}-order`}
        type="number"
        step={1}
        value={order}
        onChange={(event) => setOrder(event.target.value)}
      />
      {task?.parentId !== null ? (
        <TaskChoice
          label={gt("Parent task")}
          tasks={props.tasks.filter((candidate) => !candidate.retired && candidate.id !== task?.id)}
          value={parentId}
          onChange={setParentId}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!title.trim() || !validOrder || (task === null && parentId === null)}
          onClick={() => {
            if (task)
              props.queue({
                type: "task.update",
                id: task.id,
                title: title.trim(),
                context,
                order: Number(order),
              });
            else if (parentId) {
              props.queue({
                type: "task.add",
                id: randomUUID(),
                parentId,
                title: title.trim(),
                context,
                order: Number(order),
              });
              setTitle("");
              setContext("");
            }
          }}
        >
          {task ? <T>Queue task edit</T> : <T>Queue new task</T>}
        </Button>
        {task?.parentId !== null && task && parentId ? (
          <Button
            size="sm"
            variant="outline"
            disabled={parentId === task.parentId || task.retired}
            onClick={() => props.queue({ type: "task.move", id: task.id, parentId })}
          >
            <T>Queue move</T>
          </Button>
        ) : null}
        {task ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              props.queue({ type: task.retired ? "task.restore" : "task.retire", id: task.id })
            }
          >
            {task.retired ? <T>Queue restore task</T> : <T>Queue retire task</T>}
          </Button>
        ) : null}
      </div>
    </details>
  );
}

function RequirementEditor(props: {
  readonly plan: FactoryPlanSnapshot;
  readonly queue: (operation: FactoryPlanOperation) => void;
}) {
  const id = useId();
  const gt = useGT();
  const [dependent, setDependent] = useState<string | null>(null);
  const [prerequisite, setPrerequisite] = useState<string | null>(null);
  const [requirement, setRequirement] = useState("");
  const tasks = props.plan.tasks.filter((task) => !task.retired);
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer font-medium text-sm">
        <T>
          Requirements (<Var>{props.plan.edges.length}</Var>)
        </T>
      </summary>
      <ul className="space-y-2">
        {props.plan.edges.map((edge) => (
          <li key={edge.id} className="rounded border p-3 text-sm">
            <p>
              {gt("{from} requires {to}{retired}", {
                from: props.plan.tasks.find((task) => task.id === edge.fromTaskId)?.title ?? "",
                to: props.plan.tasks.find((task) => task.id === edge.toTaskId)?.title ?? "",
                retired: edge.retired ? " · retired" : "",
              })}
            </p>
            <p className="whitespace-pre-wrap">{edge.requirement}</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.queue({ type: edge.retired ? "edge.restore" : "edge.retire", id: edge.id })
              }
            >
              {edge.retired ? <T>Queue restore requirement</T> : <T>Queue retire requirement</T>}
            </Button>
          </li>
        ))}
      </ul>
      <TaskChoice
        label={gt("Dependent task")}
        tasks={tasks}
        value={dependent}
        onChange={setDependent}
      />
      <TaskChoice
        label={gt("Prerequisite task")}
        tasks={tasks.filter((task) => task.id !== dependent)}
        value={prerequisite}
        onChange={setPrerequisite}
      />
      <Label htmlFor={id}>
        <T>Requirement</T>
      </Label>
      <Textarea
        id={id}
        value={requirement}
        maxLength={8000}
        onChange={(event) => setRequirement(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={dependent === null || prerequisite === null || dependent === prerequisite}
        onClick={() => {
          if (dependent && prerequisite)
            props.queue({
              type: "edge.add",
              id: randomUUID(),
              fromTaskId: dependent,
              toTaskId: prerequisite,
              requirement,
            });
        }}
      >
        <T>Queue requirement</T>
      </Button>
    </details>
  );
}

function WorkContexts(props: {
  readonly plan: FactoryPlanSnapshot;
  readonly workSupported: boolean;
  readonly queue: (operation: FactoryPlanOperation) => void;
}) {
  const gt = useGT();
  const [taskId, setTaskId] = useState<string | null>(props.plan.ref.rootId);
  const [pages, setPages] = useState<readonly (string | undefined)[]>([undefined]);
  const issueKeysSupported = useFactoryIssueKeysSupported(props.plan.ref.environmentId);
  const query = useEnvironmentQuery(
    props.workSupported
      ? factoryEnvironment.listWork({
          environmentId: props.plan.ref.environmentId,
          input: {
            projectIds: [props.plan.ref.projectId],
            limit: 25,
            cursor: pages.at(-1),
            ...factoryIssueKeysInput(issueKeysSupported),
          },
        })
      : null,
  );
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer font-medium text-sm">
        <T>
          Work context (<Var>{props.plan.workContexts.length}</Var>)
        </T>
      </summary>
      <p className="text-xs text-muted-foreground">
        <T>
          Captured from retained Work. Attached text is an immutable reference snapshot. Review
          source readiness in Work separately.
        </T>
      </p>
      <ul className="space-y-2">
        {props.plan.workContexts.map((context) => (
          <li key={context.id} className="space-y-2 rounded border p-3 text-sm">
            <ContextSnapshot context={context} tasks={props.plan.tasks} />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.queue({
                  type: context.retired ? "context.restore" : "context.retire",
                  id: context.id,
                })
              }
            >
              {context.retired ? <T>Queue restore context</T> : <T>Queue retire context</T>}
            </Button>
          </li>
        ))}
      </ul>
      {props.workSupported ? (
        <>
          <TaskChoice
            label={gt("Attach to task")}
            tasks={props.plan.tasks.filter((task) => !task.retired)}
            value={taskId}
            onChange={setTaskId}
          />
          {query.error ? (
            <p role="alert">{query.error}</p>
          ) : (
            <ul className="space-y-1" aria-label={gt("Available Work context")}>
              {query.data?.items.map((item) => (
                <li key={JSON.stringify(item.ref)}>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={taskId === null || query.isPending}
                    onClick={() => {
                      if (taskId)
                        props.queue({
                          type: "context.attachWork",
                          id: randomUUID(),
                          taskId,
                          ref: item.ref,
                        });
                    }}
                  >
                    {gt("Queue attachment: {title}", { title: item.title })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <PageButtons
            previous={pages.length > 1}
            next={query.data?.nextCursor != null && pages.length < 20}
            disabled={query.isPending}
            onPrevious={() => setPages((old) => old.slice(0, -1))}
            onNext={() => {
              const next = query.data?.nextCursor;
              if (next) setPages((old) => [...old, next]);
            }}
          />
        </>
      ) : (
        <p>
          <T>Work context browsing is unavailable on this server.</T>
        </p>
      )}
    </details>
  );
}

function EditorGrants(props: {
  readonly plan: FactoryPlanSnapshot;
  readonly queue: (operation: FactoryPlanOperation) => void;
}) {
  const threads = useThreadShellsForProjectRefs([
    scopeProjectRef(props.plan.ref.environmentId, props.plan.ref.projectId),
  ]);
  const candidates = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      thread.linkOrigin === null &&
      thread.delegatedFrom === null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  const gt = useGT();
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer font-medium text-sm">
        <T>
          Agent editors (<Var>{props.plan.editorThreadIds.length}</Var>)
        </T>
      </summary>
      <p className="text-xs text-muted-foreground">
        <T>
          Grant an ordinary thread in this project permission to edit this plan. Granting sends no
          message.
        </T>
      </p>
      <ul className="space-y-1">
        {props.plan.editorThreadIds.map((threadId) => (
          <li key={threadId} className="text-sm">
            {threads.find((thread) => thread.id === threadId)?.title ?? threadId}{" "}
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.queue({ type: "editor.revoke", threadId })}
            >
              <T>Queue revoke</T>
            </Button>
          </li>
        ))}
      </ul>
      <Label htmlFor={id}>
        <T>Project thread</T>
      </Label>
      <Select
        value={selected}
        onValueChange={(value) => {
          if (typeof value === "string") setSelected(value);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue>
            {candidates.find((thread) => thread.id === selected)?.title ?? (
              <T>Choose an existing thread</T>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {candidates
            .filter((thread) => !props.plan.editorThreadIds.includes(thread.id))
            .map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {gt("{title} ({id})", { title: thread.title, id: thread.id.slice(-8) })}
              </SelectItem>
            ))}
        </SelectPopup>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={
          !candidates.some(
            (thread) => thread.id === selected && !props.plan.editorThreadIds.includes(thread.id),
          )
        }
        onClick={() => {
          const thread = candidates.find((candidate) => candidate.id === selected);
          if (thread) props.queue({ type: "editor.grant", threadId: thread.id });
        }}
      >
        <T>Queue editor grant</T>
      </Button>
    </details>
  );
}

function PlanHistory(props: { readonly reference: FactoryPlanRef }) {
  const gt = useGT();
  const [pages, setPages] = useState<readonly (number | undefined)[]>([undefined]);
  const [revision, setRevision] = useState<number | null>(null);
  const history = useEnvironmentQuery(
    factoryEnvironment.readPlanHistory({
      environmentId: props.reference.environmentId,
      input: { ref: props.reference, limit: 10, beforeRevision: pages.at(-1) },
    }),
  );
  const snapshot = useEnvironmentQuery(
    revision === null
      ? null
      : factoryEnvironment.readPlan({
          environmentId: props.reference.environmentId,
          input: { ref: props.reference, revision },
        }),
  );
  return (
    <details className="space-y-3">
      <summary className="cursor-pointer font-medium text-sm">
        <T>Revision history · read only</T>
      </summary>
      <Button size="xs" variant="outline" disabled={history.isPending} onClick={history.refresh}>
        <T>Refresh history</T>
      </Button>
      {history.error ? (
        <p role="alert">{history.error}</p>
      ) : (
        <ul className="space-y-1">
          {history.data?.items.map((item) => (
            <li key={item.revision}>
              <Button
                size="xs"
                variant="outline"
                aria-pressed={revision === item.revision}
                onClick={() => setRevision(item.revision)}
              >
                {gt("{title} · revision {revision} · {updatedAt}", {
                  title: item.title,
                  revision: String(item.revision),
                  updatedAt: item.updatedAt,
                })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <PageButtons
        previous={pages.length > 1}
        next={history.data?.nextBeforeRevision != null && pages.length < 20}
        disabled={history.isPending}
        onPrevious={() => setPages((old) => old.slice(0, -1))}
        onNext={() => {
          const next = history.data?.nextBeforeRevision;
          if (next) setPages((old) => [...old, next]);
        }}
      />
      {revision !== null ? (
        snapshot.error ? (
          <p role="alert">{snapshot.error}</p>
        ) : snapshot.data ? (
          <HistoricalSnapshot plan={snapshot.data} />
        ) : (
          <p role="status">
            <T>Loading revision…</T>
          </p>
        )
      ) : null}
    </details>
  );
}

function PageButtons(props: {
  readonly previous: boolean;
  readonly next: boolean;
  readonly disabled: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={props.disabled || !props.previous}
        onClick={props.onPrevious}
      >
        <T>Previous page</T>
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={props.disabled || !props.next}
        onClick={props.onNext}
      >
        <T>Next page</T>
      </Button>
    </div>
  );
}

function failureMessage(error: unknown): string {
  return isPlanError(error) && error.reason === "revision-conflict"
    ? error.currentRevision
      ? m(msg("Plan changed to revision {revision}.", { revision: String(error.currentRevision) }))
      : m(msg("Plan changed."))
    : error instanceof Error
      ? error.message
      : m(msg("The plan request failed."));
}

function isReadDenied(error: unknown): boolean {
  return isAuthorizationError(error) || (isPlanError(error) && error.reason === "forbidden");
}

function ContextSnapshot(props: {
  readonly context: FactoryPlanSnapshot["workContexts"][number];
  readonly tasks: readonly FactoryPlanTask[];
}) {
  const { context } = props;
  const gt = useGT();
  return (
    <>
      <p>
        {gt("{title}{retired} · task {task}", {
          title: context.title,
          retired: context.retired ? " · retired" : "",
          task: props.tasks.find((task) => task.id === context.taskId)?.title ?? "",
        })}
      </p>
      <p className="break-all text-xs">
        {gt(
          "Captured from retained Work {observedAt} · {kind} · {environmentId} · project {projectId} · snapshot revision {revision} · SHA-256 {sha256}",
          {
            observedAt: context.observedAt,
            kind: context.ref.kind,
            environmentId: context.ref.environmentId,
            projectId: context.projectId,
            revision: context.revision == null ? gt("unavailable") : String(context.revision),
            sha256: context.sha256,
          },
        )}
      </p>
      <pre
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words"
        tabIndex={0}
        aria-label={gt("Attached snapshot: {title}", { title: context.title })}
      >
        {context.snapshot}
      </pre>
      {context.snapshotTruncated ? (
        <p>
          <T>Snapshot truncated.</T>
        </p>
      ) : null}
    </>
  );
}

function HistoricalSnapshot(props: { readonly plan: FactoryPlanSnapshot }) {
  const { plan } = props;
  const gt = useGT();
  const title = (id: string) => plan.tasks.find((task) => task.id === id)?.title ?? id;
  return (
    <section
      className="space-y-3 rounded border p-3"
      aria-label={gt("Read-only revision {revision}", { revision: String(plan.revision) })}
    >
      <h4 className="font-medium text-sm">
        {gt("Read-only revision {revision}", { revision: String(plan.revision) })}
      </h4>
      <ul className="space-y-2" aria-label={gt("Historical tasks")}>
        {plan.tasks
          .toSorted((a, b) => a.order - b.order)
          .map((task) => (
            <li key={task.id} className="text-sm">
              <p className="font-medium">
                {gt("{title}{retired}", {
                  title: task.title,
                  retired: task.retired ? " · retired" : "",
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {task.parentId === null
                  ? gt("Root task · order {order} · {id}", {
                      order: String(task.order),
                      id: task.id,
                    })
                  : gt("Parent: {title} · order {order} · {id}", {
                      title: title(task.parentId),
                      order: String(task.order),
                      id: task.id,
                    })}
              </p>
              <p className="whitespace-pre-wrap break-words">{task.context}</p>
            </li>
          ))}
      </ul>
      <ul className="space-y-2" aria-label={gt("Historical requirements")}>
        {plan.edges.map((edge) => (
          <li key={edge.id} className="text-sm">
            <p>
              {gt("{from} requires {to}{retired}", {
                from: title(edge.fromTaskId),
                to: title(edge.toTaskId),
                retired: edge.retired ? " · retired" : "",
              })}
            </p>
            <p className="whitespace-pre-wrap break-words">{edge.requirement}</p>
          </li>
        ))}
      </ul>
      <ul className="space-y-2" aria-label={gt("Historical Work context")}>
        {plan.workContexts.map((context) => (
          <li key={context.id} className="space-y-2 text-sm">
            <ContextSnapshot context={context} tasks={plan.tasks} />
          </li>
        ))}
      </ul>
      <p className="break-words text-xs text-muted-foreground">
        {plan.editorThreadIds.length === 0
          ? gt("Agent editor thread IDs: None")
          : gt("Agent editor thread IDs: {ids}", {
              ids: plan.editorThreadIds.join(", "),
            })}
      </p>
    </section>
  );
}

function operationDescription(
  operation: FactoryPlanOperation,
  tasks: readonly FactoryPlanTask[],
  resolve: MessageResolver = m,
): string {
  const title = (id: string) => tasks.find((task) => task.id === id)?.title ?? id;
  switch (operation.type) {
    case "task.add":
      return resolve(
        msg("Add {task} under {parent} (order {order}). {context}", {
          task: operation.title,
          parent: title(operation.parentId),
          order: String(operation.order ?? 0),
          context: operation.context ?? "",
        }),
      );
    case "task.update":
      return resolve(
        msg("Edit {task}: {title} (order {order}). {context}", {
          task: title(operation.id),
          title: operation.title ?? title(operation.id),
          order: operation.order == null ? resolve(msg("unchanged")) : String(operation.order),
          context: operation.context ?? "",
        }),
      );
    case "task.move":
      return resolve(
        msg("Move {task} under {parent}.", {
          task: title(operation.id),
          parent: title(operation.parentId),
        }),
      );
    case "task.retire":
      return resolve(msg("Retire task {task}.", { task: title(operation.id) }));
    case "task.restore":
      return resolve(msg("Restore task {task}.", { task: title(operation.id) }));
    case "edge.add":
      return resolve(
        msg("{from} requires {to}. {requirement}", {
          from: title(operation.fromTaskId),
          to: title(operation.toTaskId),
          requirement: operation.requirement,
        }),
      );
    case "edge.retire":
      return resolve(msg("Retire requirement {id}.", { id: operation.id }));
    case "edge.restore":
      return resolve(msg("Restore requirement {id}.", { id: operation.id }));
    case "editor.grant":
      return resolve(msg("Grant agent editor access to thread {id}.", { id: operation.threadId }));
    case "editor.revoke":
      return resolve(
        msg("Revoke agent editor access from thread {id}.", { id: operation.threadId }),
      );
    case "context.attachWork":
      return resolve(
        msg("Attach retained {kind} Work {id} to {task}.", {
          kind: operation.ref.kind,
          id: operation.ref.id,
          task: title(operation.taskId),
        }),
      );
    case "context.retire":
      return resolve(msg("Retire context {id}.", { id: operation.id }));
    case "context.restore":
      return resolve(msg("Restore context {id}.", { id: operation.id }));
  }
}
