import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryKnowledgeBrief,
  type FactoryKnowledgeTask,
  type ProjectId,
} from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { FileTextIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { FactoryArtifactDeliveryPanel } from "./FactoryArtifactDeliveryPanel";
import { FactoryCheckoutChooser } from "./FactoryCheckoutChooser";
import { FactoryEmptyState } from "./FactoryEmptyState";
import { factoryTaskPresentation } from "./factoryIssues.logic";
import {
  EMPTY_KNOWLEDGE_DRAFT,
  KNOWLEDGE_LIMITS,
  factoryKnowledgeArtifactIssueMessage,
  factoryKnowledgeArtifactState,
  factoryKnowledgeFailureMessage,
  validateFactoryKnowledgeDraft,
  type FactoryKnowledgeDraft,
} from "./factoryKnowledge.logic";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  useFactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import { FactoryReviewSnapshot } from "./FactoryReview";
import { singleFactoryMember, validateFactorySearch } from "./factoryScope";

export function FactoryBriefsPage() {
  const search = validateFactorySearch(useSearch({ strict: false }));
  const gt = useGT();
  const { scope, groups, selectScope } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const projects = useProjects();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const member = singleFactoryMember(scope);
  const environment = environments.find((entry) => entry.environmentId === member?.environmentId);
  const project = projects.find(
    (entry) => entry.environmentId === member?.environmentId && entry.id === member?.id,
  );
  const canRead = useEnvironmentScope(member?.environmentId ?? null, AuthOrchestrationReadScope);

  if (scope.kind === "unavailable") return null;
  if (!isReady)
    return (
      <p role="status">
        <T>Loading environments…</T>
      </p>
    );

  const unavailable =
    !environment || !project
      ? {
          title: gt("Checkout unavailable"),
          description: gt("Choose another checkout to manage briefs."),
        }
      : environment.connection.phase !== "connected"
        ? {
            title: gt("Environment offline"),
            description: gt("Reconnect {label} to read briefs.", {
              label: environment.label,
            }),
          }
        : environment.serverConfig === null
          ? {
              title: gt("Server capabilities unknown"),
              description: gt("Wait for this environment to finish connecting."),
            }
          : environment.serverConfig.environment.capabilities.factoryKnowledge !== true
            ? {
                title: gt("Knowledge briefs unsupported"),
                description: gt("Update the server on {label} to use briefs.", {
                  label: environment.label,
                }),
              }
            : !canRead
              ? {
                  title: gt("Read access unavailable"),
                  description: gt(
                    "This connection needs orchestration read access to list briefs.",
                  ),
                }
              : null;

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-briefs-title">
      <div className="space-y-1">
        <h2 id="factory-briefs-title" className="font-medium text-lg">
          <T>Briefs</T>
        </h2>
        <p className="text-muted-foreground text-sm">
          <T>
            Write a knowledge brief, review its frozen revision and start a task in its own folder.
            Accept the resulting artifact after reviewing it against your criteria.
          </T>
        </p>
      </div>
      {member === null ? (
        <FactoryCheckoutChooser
          scope={scope}
          groups={groups}
          environments={environments}
          intro={gt(
            "Choose an exact checkout to manage its briefs. Each task works in a separate folder.",
          )}
          emptyDescription={gt("Connect an environment and add a project to author briefs.")}
          statusFor={(owner) =>
            !owner
              ? gt("Environment unavailable")
              : owner.connection.phase !== "connected"
                ? gt("Offline. Reconnect to read briefs")
                : owner.serverConfig === null
                  ? gt("Server capabilities unknown")
                  : owner.serverConfig.environment.capabilities.factoryKnowledge !== true
                    ? gt("Knowledge briefs unsupported. Update this server")
                    : !readableIds.has(owner.environmentId)
                      ? gt("Read access unavailable")
                      : gt("Connected · briefs available")
          }
          onChoose={selectScope}
        />
      ) : unavailable !== null ? (
        <FactoryEmptyState icon={<FileTextIcon />} {...unavailable} />
      ) : environment && project && search.reviewId !== undefined ? (
        <FactorySelectedBrief
          key={`${environment.environmentId}:${search.reviewId}`}
          environmentId={environment.environmentId}
          project={project}
          briefId={search.reviewId}
          deliverySupported={
            environment.serverConfig?.environment.capabilities.factoryDelivery === true
          }
        />
      ) : environment && project ? (
        <FactoryBriefsWorkspace
          key={`${environment.environmentId}:${project.id}`}
          environmentId={environment.environmentId}
          project={project}
          deliverySupported={
            environment.serverConfig?.environment.capabilities.factoryDelivery === true
          }
        />
      ) : null}
    </section>
  );
}

function KnowledgeFailure(props: { readonly message: string | null }) {
  return props.message === null ? null : (
    <Alert variant="error">
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}

function FactoryBriefsWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  /** Older servers cannot prepare or read an artifact delivery; asking would fail. */
  readonly deliverySupported: boolean;
}) {
  const { environmentId, project } = props;
  const gt = useGT();
  const query = useEnvironmentQuery(
    factoryEnvironment.listKnowledgeBriefs({ environmentId, input: { projectId: project.id } }),
  );
  const canCreate = useAtomValue(
    factoryEnvironment.createKnowledgeBrief.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(
    factoryEnvironment.startKnowledgeTask.permissionAtom(environmentId),
  );
  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState<{ brief: FactoryKnowledgeBrief; restart: boolean } | null>(
    null,
  );
  const tasks = new Map(query.data?.tasks.map((task) => [task.briefId, task]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!canCreate || creating} onClick={() => setCreating(true)}>
          <T>New brief</T>
        </Button>
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          <T>Refresh briefs</T>
        </Button>
      </div>
      {!canCreate || !canStart ? (
        <p className="text-muted-foreground text-xs">
          <T>Creating briefs and starting tasks need operate permission on this environment.</T>
        </p>
      ) : null}
      {creating ? (
        <KnowledgeBriefForm
          environmentId={environmentId}
          projectId={project.id}
          canCreate={canCreate}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            query.refresh();
          }}
        />
      ) : null}
      <KnowledgeFailure
        message={
          query.error === null ? null : factoryKnowledgeFailureMessage(query.failure, query.error)
        }
      />
      {query.isPending ? (
        <p role="status">
          <T>Loading briefs…</T>
        </p>
      ) : null}
      {query.error === null && query.data?.briefs.length === 0 ? (
        <p>
          <T>No briefs yet. Create a brief to begin.</T>
        </p>
      ) : null}
      <ul className="space-y-3" aria-label={gt("Knowledge briefs")}>
        {query.data?.briefs.map((brief) => (
          <KnowledgeBriefRow
            key={brief.id}
            environmentId={environmentId}
            projectId={project.id}
            brief={brief}
            deliverySupported={props.deliverySupported}
            task={tasks.get(brief.id) ?? null}
            canStart={canStart && query.error === null && !query.isPending}
            onReview={(restart) => setReview({ brief, restart })}
          />
        ))}
      </ul>
      {review !== null ? (
        <KnowledgeStartDialog
          environmentId={environmentId}
          project={project}
          brief={review.brief}
          restart={review.restart}
          canStart={canStart}
          onClose={() => setReview(null)}
          onStarted={() => {
            setReview(null);
            query.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function FactorySelectedBrief(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly briefId: string;
  readonly deliverySupported: boolean;
}) {
  const query = useEnvironmentQuery(
    factoryEnvironment.readKnowledgeTask({
      environmentId: props.environmentId,
      input: { projectId: props.project.id, briefId: props.briefId },
    }),
  );
  const canStart = useAtomValue(
    factoryEnvironment.startKnowledgeTask.permissionAtom(props.environmentId),
  );
  const [review, setReview] = useState<boolean | null>(null);
  const data = query.error === null && !query.isPending ? query.data : null;
  return (
    <div className="space-y-3">
      {query.error ? (
        <p role="alert">{query.error}</p>
      ) : data === null ? (
        <p role="status">
          <T>Loading exact brief…</T>
        </p>
      ) : (
        <>
          <ul>
            <KnowledgeBriefRow
              environmentId={props.environmentId}
              projectId={props.project.id}
              brief={data.brief}
              task={data.task}
              deliverySupported={props.deliverySupported}
              canStart={canStart}
              onReview={setReview}
            />
          </ul>
          {review !== null ? (
            <KnowledgeStartDialog
              environmentId={props.environmentId}
              project={props.project}
              brief={data.brief}
              restart={review}
              canStart={canStart}
              onClose={() => setReview(null)}
              onStarted={() => {
                setReview(null);
                query.refresh();
              }}
            />
          ) : null}
        </>
      )}
      <Button size="sm" variant="outline" onClick={query.refresh}>
        <T>Refresh exact brief</T>
      </Button>
    </div>
  );
}

function KnowledgeBriefForm(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly canCreate: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const id = useId();
  const gt = useGT();
  const [draft, setDraft] = useState<FactoryKnowledgeDraft>(EMPTY_KNOWLEDGE_DRAFT);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const runCreate = useAtomCommand(factoryEnvironment.createKnowledgeBrief, {
    label: "factory create knowledge brief",
    reportFailure: false,
  });
  const update = (
    field: "title" | "question" | "deliverablePath" | "acceptanceCriteria",
    value: string,
  ) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };
  const updateInput = (index: number, field: "label" | "content", value: string) => {
    setDraft((previous) => ({
      ...previous,
      inputs: previous.inputs.map((input, position) =>
        position === index ? { ...input, [field]: value } : input,
      ),
    }));
  };
  const submit = async () => {
    if (!props.canCreate || inFlight.current) return;
    const invalid = validateFactoryKnowledgeDraft(draft);
    if (invalid !== null) {
      setFailure(invalid);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    const result = await runCreate({
      environmentId: props.environmentId,
      input: {
        ...draft,
        title: draft.title.trim(),
        deliverablePath: draft.deliverablePath.trim(),
        inputs: draft.inputs.map((input) => ({
          content: input.content,
          label: input.label.trim(),
        })),
        commandId: CommandId.make(randomUUID()),
        projectId: props.projectId,
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
    if (result._tag === "Success") props.onCreated();
    else if (!isAtomCommandInterrupted(result))
      setFailure(factoryKnowledgeFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="font-medium">
        <T>New brief</T>
      </h3>
      <p className="text-muted-foreground text-sm">
        <T>Creating saves an immutable revision. Review it before starting a task.</T>
      </p>
      <fieldset className="min-w-0 space-y-4" disabled={pending || !props.canCreate}>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-title`}>
            <T>Title</T>
          </Label>
          <Input
            id={`${id}-title`}
            value={draft.title}
            maxLength={KNOWLEDGE_LIMITS.title}
            required
            onChange={(event) => update("title", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-question`}>
            <T>Question</T>
          </Label>
          <Textarea
            id={`${id}-question`}
            value={draft.question}
            maxLength={KNOWLEDGE_LIMITS.question}
            onChange={(event) => update("question", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-path`}>
            <T>Deliverable path</T>
          </Label>
          <Input
            id={`${id}-path`}
            value={draft.deliverablePath}
            required
            font="mono"
            aria-describedby={`${id}-path-help`}
            onChange={(event) => update("deliverablePath", event.target.value)}
          />
          <p id={`${id}-path-help`} className="text-muted-foreground text-xs">
            <T>
              A relative file path inside the task folder, without parent traversal or a .git
              directory.
            </T>
          </p>
        </div>
        <div className="space-y-3">
          <h4 className="font-medium text-sm">
            <T>
              Inputs (<Var>{draft.inputs.length}</Var>/<Var>{KNOWLEDGE_LIMITS.inputs}</Var>)
            </T>
          </h4>
          {draft.inputs.map((input, index) => (
            <fieldset key={input.key} className="min-w-0 space-y-2 rounded-lg border p-3">
              <legend className="text-sm">
                <T>
                  Input <Var>{index + 1}</Var>
                </T>
              </legend>
              <Label htmlFor={`${id}-input-${index}-label`}>
                <T>Label</T>
              </Label>
              <Input
                id={`${id}-input-${index}-label`}
                value={input.label}
                required
                maxLength={KNOWLEDGE_LIMITS.inputLabel}
                onChange={(event) => updateInput(index, "label", event.target.value)}
              />
              <Label htmlFor={`${id}-input-${index}-content`}>
                <T>Pasted content</T>
              </Label>
              <Textarea
                id={`${id}-input-${index}-content`}
                value={input.content}
                maxLength={KNOWLEDGE_LIMITS.inputContent}
                onChange={(event) => updateInput(index, "content", event.target.value)}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-label={gt("Remove input {index}", { index: String(index + 1) })}
                onClick={() =>
                  setDraft((previous) => ({
                    ...previous,
                    inputs: previous.inputs.filter((_, position) => position !== index),
                  }))
                }
              >
                <T>Remove input</T>
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.inputs.length >= KNOWLEDGE_LIMITS.inputs}
            onClick={() =>
              setDraft((previous) => ({
                ...previous,
                inputs: [...previous.inputs, { key: randomUUID(), label: "", content: "" }],
              }))
            }
          >
            <T>Add input</T>
          </Button>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-criteria`}>
            <T>Acceptance criteria</T>
          </Label>
          <Textarea
            id={`${id}-criteria`}
            value={draft.acceptanceCriteria}
            maxLength={KNOWLEDGE_LIMITS.acceptanceCriteria}
            onChange={(event) => update("acceptanceCriteria", event.target.value)}
          />
        </div>
      </fieldset>
      <KnowledgeFailure message={failure} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || !props.canCreate} aria-busy={pending}>
          {pending ? <T>Creating…</T> : <T>Create brief</T>}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={props.onClose}
        >
          <T>Cancel</T>
        </Button>
      </div>
    </form>
  );
}

function KnowledgeStartDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly brief: FactoryKnowledgeBrief;
  readonly restart: boolean;
  readonly canStart: boolean;
  readonly onClose: () => void;
  readonly onStarted: () => void;
}) {
  const settings = useFactoryLaunchModelSettings(props.environmentId, props.project);
  const draft = useFactoryLaunchDraft(settings);
  const id = useId();
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const runStart = useAtomCommand(factoryEnvironment.startKnowledgeTask, {
    label: "factory start knowledge task",
    reportFailure: false,
  });
  const gt = useGT();
  const { brief } = props;
  const enabled =
    props.canStart &&
    !pending &&
    failure === null &&
    draft.selection !== null &&
    instructions.length <= KNOWLEDGE_LIMITS.instructions;
  const submit = async () => {
    if (!enabled || draft.selection === null || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const result = await runStart({
      environmentId: props.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        projectId: props.project.id,
        briefId: brief.id,
        expectedRevision: brief.revision,
        modelSelection: draft.selection,
        instructions,
        ...(props.restart ? { restartDeleted: true } : {}),
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
    if (result._tag === "Success") props.onStarted();
    else if (!isAtomCommandInterrupted(result))
      setFailure(factoryKnowledgeFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {props.restart ? <T>Review new attempt</T> : <T>Review brief</T>}
          </DialogTitle>
          <DialogDescription>
            {props.restart
              ? gt(
                  "The previous thread was deleted. Confirm this frozen revision to start a task in a separate folder outside the checkout.",
                )
              : gt(
                  "Confirm this frozen revision to start a task in a separate folder outside the checkout.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || failure !== null} className="min-w-0 space-y-4">
            <p className="text-muted-foreground text-xs">
              <T>
                Project <Var>{props.project.title}</Var> · revision{" "}
                <code>
                  <Var>{brief.revision.slice(0, 7)}</Var>
                </code>
              </T>{" "}
            </p>
            <FactoryReviewSnapshot
              heading={gt("Frozen brief")}
              intro={gt("Review the complete brief before admitting it.")}
              fields={[
                { label: gt("Title"), text: brief.title, emptyNote: gt("No title.") },
                {
                  label: gt("Question"),
                  text: brief.question,
                  emptyNote: gt("No question supplied."),
                },
                {
                  label: gt("Deliverable path"),
                  text: brief.deliverablePath,
                  emptyNote: gt("No path supplied."),
                },
                ...brief.inputs.flatMap((input, index) => [
                  {
                    label: gt("Input {index} label", { index: String(index + 1) }),
                    text: input.label,
                    emptyNote: gt("No label."),
                  },
                  {
                    label: gt("Input {index} content", { index: String(index + 1) }),
                    text: input.content,
                    emptyNote: gt("Empty input."),
                  },
                ]),
                {
                  label: gt("Acceptance criteria"),
                  text: brief.acceptanceCriteria,
                  emptyNote: gt("No acceptance criteria supplied."),
                },
              ]}
            />
            <FactoryLaunchFields
              environmentId={props.environmentId}
              disabled={pending || failure !== null}
              draft={draft}
              untrustedText={gt("Brief text")}
              showBaseRef={false}
            />
            <div className="space-y-1.5">
              <Label htmlFor={id}>
                <T>Instructions (optional)</T>
              </Label>
              <Textarea
                id={id}
                value={instructions}
                maxLength={KNOWLEDGE_LIMITS.instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </div>
          </fieldset>
          <KnowledgeFailure message={failure} />
          {failure !== null ? (
            <p className="text-muted-foreground text-xs">
              <T>Close this dialog, refresh and review before trying again.</T>
            </p>
          ) : null}
          {!props.canStart ? (
            <p role="status">
              <T>Starting a task needs operate permission.</T>
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" disabled={pending} />}>
            <T>Cancel</T>
          </DialogClose>
          <Button size="sm" disabled={!enabled} aria-busy={pending} onClick={() => void submit()}>
            {pending ? <T>Starting…</T> : <T>Admit and start</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function KnowledgeBriefRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly brief: FactoryKnowledgeBrief;
  readonly task: FactoryKnowledgeTask | null;
  readonly deliverySupported: boolean;
  readonly canStart: boolean;
  readonly onReview: (restart: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { brief, task } = props;
  const status = task === null ? null : factoryTaskPresentation(task.status);
  return (
    <li className="min-w-0 space-y-3 rounded-lg border p-4">
      <h3 className="font-medium [overflow-wrap:anywhere]">{brief.title}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">
          <T>
            Revision{" "}
            <code>
              <Var>{brief.revision.slice(0, 7)}</Var>
            </code>
          </T>
        </span>
        {status !== null ? (
          <Badge variant={status.variant}>{status.label}</Badge>
        ) : (
          <Badge variant="secondary">
            <T>Not started</T>
          </Badge>
        )}
        {brief.supersededBy !== null ? (
          <Badge variant="outline">
            <T>Superseded</T>
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {(task === null || task.status === "missing") && brief.supersededBy === null ? (
          <Button
            size="sm"
            disabled={!props.canStart}
            onClick={() => props.onReview(task !== null)}
          >
            {task === null ? <T>Start task</T> : <T>Start new attempt</T>}
          </Button>
        ) : null}
        {task !== null && task.status !== "missing" ? (
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(scopeThreadRef(props.environmentId, task.threadId))}
              />
            }
          >
            <T>Open thread</T>
          </Button>
        ) : null}
        {task !== null ? (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <T>Hide artifact</T> : <T>Review artifact</T>}
          </Button>
        ) : null}
      </div>
      {expanded && task !== null ? (
        <KnowledgeArtifact
          environmentId={props.environmentId}
          projectId={props.projectId}
          briefId={brief.id}
          deliverySupported={props.deliverySupported}
        />
      ) : null}
    </li>
  );
}

function KnowledgeArtifact(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly briefId: string;
  readonly deliverySupported: boolean;
}) {
  const { environmentId, projectId, briefId } = props;
  const query = useEnvironmentQuery(
    factoryEnvironment.readKnowledgeTask({ environmentId, input: { projectId, briefId } }),
  );
  const canAccept = useAtomValue(
    factoryEnvironment.acceptKnowledgeArtifact.permissionAtom(environmentId),
  );
  const runAccept = useAtomCommand(factoryEnvironment.acceptKnowledgeArtifact, {
    label: "factory accept knowledge artifact",
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const id = useId();
  const gt = useGT();
  const data = query.data;
  const artifact = data?.artifact ?? null;
  const acceptance = data?.acceptance ?? null;
  const artifactIssueMessage =
    data === null
      ? null
      : factoryKnowledgeArtifactIssueMessage(data.artifactIssue, data.brief.deliverablePath);
  const state = factoryKnowledgeArtifactState(
    query.error === null && !query.isPending ? data : null,
  );
  const readFailure =
    query.error === null ? null : factoryKnowledgeFailureMessage(query.failure, query.error);
  const disabledReason = !canAccept
    ? gt("Accepting an artifact needs operate permission on this environment.")
    : readFailure !== null
      ? readFailure
      : query.isPending || data === null
        ? gt("Reading the artifact…")
        : data.task?.folderPath == null
          ? gt("The task folder is unavailable. Restore it and refresh before accepting.")
          : artifactIssueMessage !== null
            ? artifactIssueMessage
            : artifact === null
              ? gt("No artifact yet")
              : failure !== null
                ? gt("Refresh and review the artifact before accepting again.")
                : null;
  const accept = async () => {
    if (inFlight.current || disabledReason !== null || artifact === null || state === "current")
      return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    const result = await runAccept({
      environmentId,
      input: {
        projectId,
        briefId,
        // Only the observed digest is submitted; the server rejects concurrent file changes.
        expectedSha256: artifact.sha256,
        ...(state === "changed" ? { supersede: true } : {}),
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
    if (result._tag === "Success") query.refresh();
    else if (!isAtomCommandInterrupted(result))
      setFailure(factoryKnowledgeFailureMessage(squashAtomCommandFailure(result)));
  };

  return (
    <section
      className="space-y-3"
      aria-label={gt("Task artifact")}
      aria-busy={pending || query.isPending}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium text-sm">
          <T>Artifact</T>
        </h4>
        <Button
          size="xs"
          variant="outline"
          disabled={pending || query.isPending}
          onClick={() => {
            setFailure(null);
            query.refresh();
          }}
        >
          <T>Refresh</T>
        </Button>
      </div>
      {data !== null ? (
        <FactoryReviewSnapshot
          heading={gt("Acceptance criteria for this brief")}
          intro={gt("Compare the artifact with the frozen question and criteria.")}
          fields={[
            {
              label: gt("Question"),
              text: data.brief.question,
              emptyNote: gt("No question supplied."),
            },
            {
              label: gt("Acceptance criteria"),
              text: data.brief.acceptanceCriteria,
              emptyNote: gt("No acceptance criteria supplied."),
            },
          ]}
        />
      ) : null}
      {artifact !== null ? (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">
            <T>
              <code>
                <Var>{artifact.path}</Var>
              </code>{" "}
              · SHA-256{" "}
              <code>
                <Var>{artifact.sha256.slice(0, 7)}</Var>
              </code>{" "}
              · <Var>{artifact.bytes.toLocaleString()}</Var> bytes
            </T>
          </p>
          {artifact.preview === null ? (
            <p className="text-muted-foreground text-xs">
              <T>Text preview unavailable. Review the file in the task folder before accepting.</T>
            </p>
          ) : (
            <pre
              tabIndex={0}
              aria-label={gt("Artifact preview")}
              className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border p-3 text-sm [overflow-wrap:anywhere]"
            >
              {artifact.preview}
            </pre>
          )}
          <p className="text-muted-foreground text-xs">
            <T>
              The preview contains at most 256 KiB. Acceptance records the digest of the whole file;
              it does not establish that the contents are true.
            </T>
          </p>
        </>
      ) : null}
      {artifactIssueMessage !== null &&
      artifactIssueMessage !== disabledReason &&
      readFailure === null &&
      !query.isPending ? (
        <p>{artifactIssueMessage}</p>
      ) : null}
      {acceptance !== null ? (
        <p className="text-muted-foreground text-xs">
          <T>
            Accepted artifact{" "}
            <code>
              <Var>{acceptance.sha256.slice(0, 7)}</Var>
            </code>{" "}
            ·{" "}
            <time dateTime={acceptance.acceptedAt}>
              <Var>{new Date(acceptance.acceptedAt).toLocaleString()}</Var>
            </time>
          </T>
        </p>
      ) : null}
      {state === "current" ? (
        <p className="text-sm">
          <T>Acceptance matches the observed artifact.</T>
        </p>
      ) : null}
      {state === "changed" ? (
        <Alert variant="warning">
          <AlertDescription>
            <T>Artifact changed since acceptance</T>
          </AlertDescription>
        </Alert>
      ) : null}
      {state === "unverifiable" && acceptance !== null ? (
        <Alert variant="warning">
          <AlertDescription>
            <T>
              The accepted artifact cannot currently be compared with the file. Restore access and
              refresh.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}
      <KnowledgeFailure message={failure ?? readFailure} />
      {state !== "current" && data !== null ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending || disabledReason !== null}
          aria-busy={pending}
          aria-describedby={disabledReason === null ? undefined : id}
          onClick={() => void accept()}
        >
          {pending ? (
            <T>Accepting…</T>
          ) : acceptance !== null ? (
            <T>Re-accept</T>
          ) : (
            <T>Accept this artifact</T>
          )}
        </Button>
      ) : null}
      {disabledReason !== null ? (
        <p id={id} role="status" className="text-muted-foreground text-xs">
          {disabledReason}
        </p>
      ) : null}
      {props.deliverySupported && acceptance !== null && data !== null && data.task !== null ? (
        <FactoryArtifactDeliveryPanel
          key={acceptance.id}
          environmentId={environmentId}
          projectId={projectId}
          threadId={data.task.threadId}
          acceptanceCurrent={state === "current"}
        />
      ) : null}
    </section>
  );
}
