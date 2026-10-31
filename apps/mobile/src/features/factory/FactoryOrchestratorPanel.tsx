import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectCoordinatorCandidates } from "@t3tools/client-runtime/state/factory";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type ProjectCoordinatorEnsureInput,
  type ProjectCoordinator,
  type ProjectCoordinatorAssignInput,
  ProjectCoordinatorError,
  type ProjectId,
  type ThreadId,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { uuidv4 } from "../../lib/uuid";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useFactoryInboxSelection } from "./factory-inbox-state";
import { useFactoryLaunchModel } from "./useFactoryLaunch";
import { useOpenFactoryThread } from "./useFactoryIssueActions";

export function FactoryOrchestratorPanel({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigation =
    useNavigation<NativeStackNavigationProp<{ SettingsFactoryModel: undefined }>>();
  const isFocused = useIsFocused();
  const selection = useFactoryInboxSelection();
  const launch = useFactoryLaunchModel({ ...selection, environmentId, projectId });
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canOperate = useAtomValue(
    factoryEnvironment.coordinatorsEnsure.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    canRead ? factoryEnvironment.coordinatorsGet({ environmentId, input: { projectId } }) : null,
  );
  const ensure = useAtomCommand(factoryEnvironment.coordinatorsEnsure, { reportFailure: false });
  const openThread = useOpenFactoryThread();
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const [review, setReview] = useState<ProjectCoordinatorEnsureInput | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lifetime = useRef<{ active: boolean; pending: boolean } | null>(null);
  // FactoryRouteScreen keys this panel by environment, project and section.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useLayoutEffect(() => {
    const current = { active: true, pending: false };
    lifetime.current = current;
    return () => {
      current.active = false;
    };
  }, []);
  const focused = useRef(isFocused);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Tracks native navigator focus for in-flight server commands.
  useLayoutEffect(() => {
    focused.current = isFocused;
  }, [isFocused]);

  const coordinator = query.data?.coordinator ?? null;
  const modeSupported =
    launch.option?.supportedRuntimeModes === undefined ||
    launch.option.supportedRuntimeModes.includes(selection.runtimeMode);
  const modelAvailable =
    launch.modelSelection !== null &&
    launch.option !== null &&
    !launch.option.isUnavailable &&
    !launch.option.providerUpdateRequired &&
    modeSupported;
  const canLaunch =
    canOperate && query.isSuccess && (coordinator?.status === "launching" || modelAvailable);

  const prepare = () => {
    if (!canLaunch || pending) return;
    const modelSelection =
      coordinator?.status === "launching" ? coordinator.modelSelection : launch.modelSelection;
    if (modelSelection === null) return;
    setFailure(null);
    setReview({
      commandId: CommandId.make(uuidv4()),
      projectId,
      expectedThreadId: coordinator?.threadId ?? null,
      expectedRevision: coordinator?.revision ?? 0,
      modelSelection,
      runtimeMode:
        coordinator?.status === "launching" ? coordinator.runtimeMode : selection.runtimeMode,
      interactionMode:
        coordinator?.status === "launching" ? coordinator.interactionMode : interactionMode,
      ...(coordinator?.status === "missing" ? { replaceRetired: true } : {}),
    });
  };
  const submit = async () => {
    const current = lifetime.current;
    if (
      !current?.active ||
      current.pending ||
      review === null ||
      !canOperate ||
      !focused.current ||
      !readEnvironmentScope(environmentId, AuthOrchestrationReadScope)
    )
      return;
    current.pending = true;
    setPending(true);
    setFailure(null);
    const result = await ensure({ environmentId, input: review });
    current.pending = false;
    if (!current.active || lifetime.current !== current) return;
    setPending(false);
    query.refresh();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setFailure(
          "Could not start the orchestrator. Check the connection, provider and launch permissions, then refresh. Retry keeps this exact request and reviewed binding.",
        );
      }
      return;
    }
    setReview(null);
    if (!result.value.coordinator.current) {
      setFailure(
        "This request refers to a superseded orchestrator. Refresh to inspect the current binding; no new orientation was sent.",
      );
      return;
    }
    if (focused.current) openThread(environmentId, result.value.coordinator.threadId);
  };

  return (
    <View className="gap-4">
      <Text className="text-sm text-foreground-muted">
        One ordinary project thread for orientation, delegation and scheduled prompts. Opening this
        panel does not send a message or start work.
      </Text>
      {!canRead ? (
        <Text className="text-danger-foreground">This connection cannot read orchestrators.</Text>
      ) : query.error && review === null ? (
        <Text className="text-danger-foreground">
          Could not load the orchestrator. Refresh to retry.
        </Text>
      ) : !query.isSuccess && review === null ? (
        <Text className="text-foreground-muted">Loading orchestrator…</Text>
      ) : (
        <SettingsSection title={launch.project?.title ?? "Project orchestrator"}>
          <View className="gap-3 p-4">
            <Text className="text-sm text-foreground-muted" selectable>
              {launch.project?.workspaceRoot}
            </Text>
            <Text className="text-base text-foreground">
              {coordinator ? `Orchestrator: ${coordinator.status}` : "No orchestrator created"}
            </Text>
            {review === null &&
            coordinator &&
            coordinator.status !== "missing" &&
            coordinator.status !== "launching" ? (
              <>
                <Text className="text-sm text-foreground-muted">
                  {coordinator.modelSelection.model} · {coordinator.runtimeMode} ·{" "}
                  {coordinator.interactionMode}
                </Text>
                <Button
                  label="Open orchestrator"
                  onPress={() => openThread(environmentId, coordinator.threadId)}
                />
                {coordinator.status === "archived" || coordinator.status === "failed" ? (
                  <Text className="text-sm text-foreground-muted">
                    Inspect and manage this existing thread using its normal controls. It is not
                    replaced automatically.
                  </Text>
                ) : null}
              </>
            ) : review === null ? (
              <>
                <Button
                  label={`Model and permissions: ${launch.label ?? "Choose model"}`}
                  disabled={pending || !canOperate}
                  onPress={() => navigation.navigate("SettingsFactoryModel")}
                />
                <Text className="text-sm text-foreground-muted">
                  Runtime: {selection.runtimeMode}. New Factory launches start supervised; the
                  picker shows the actual provider and permission settings.
                </Text>
                <SegmentedControl<ProviderInteractionMode>
                  selected={interactionMode}
                  onSelect={setInteractionMode}
                  options={[
                    { value: "default", label: "Default" },
                    { value: "plan", label: "Plan" },
                  ]}
                />
                {!modelAvailable ? (
                  <Text className="text-sm text-danger-foreground">
                    Choose an available provider/model and supported runtime before creating an
                    orchestrator.
                  </Text>
                ) : null}
                <Button
                  label={
                    coordinator?.status === "missing"
                      ? "Review replacement"
                      : coordinator?.status === "launching"
                        ? "Review resume"
                        : "Create and start"
                  }
                  disabled={!canLaunch}
                  onPress={prepare}
                />
              </>
            ) : (
              <>
                <Text className="text-base font-t3-medium text-foreground">
                  {review.replaceRetired
                    ? "Replace unavailable orchestrator?"
                    : "Start project orientation?"}
                </Text>
                <Text className="text-sm text-foreground-muted" selectable>
                  {environmentId} · {projectId}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {review.modelSelection.model} · {review.runtimeMode} · {review.interactionMode}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  This explicitly starts one read-only orientation run in this checkout, then waits.
                  It does not authorize edits, workers, enabling schedules, publishing, merging or
                  spending. Subsequent work requires your requests and the existing permission
                  controls.
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Deleting the orchestrator thread also removes its bound workflows. Replacement
                  does not move existing workflow bindings or restore deleted workflows.
                </Text>
                {failure ? (
                  <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                    {failure}
                  </Text>
                ) : null}
                <Button
                  label={review.replaceRetired ? "Replace and start" : "Confirm and start"}
                  loading={pending}
                  disabled={pending || !canOperate}
                  onPress={() => void submit()}
                />
                <Button
                  label="Cancel"
                  disabled={pending}
                  onPress={() => {
                    setReview(null);
                    setFailure(null);
                  }}
                />
              </>
            )}
            {!canOperate ? (
              <Text className="text-sm text-foreground-muted">
                Read only: this connection cannot start an orchestrator.
              </Text>
            ) : null}
          </View>
        </SettingsSection>
      )}
      {failure && review === null ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      {launch.config?.environment.capabilities.projectCoordinatorAssignments === true ? (
        <AssignCoordinator
          environmentId={environmentId}
          projectId={projectId}
          coordinator={coordinator}
          ready={query.isSuccess && !pending && review === null}
          onReview={query.refresh}
        />
      ) : null}
      <Button label="Refresh orchestrator" disabled={pending || !canRead} onPress={query.refresh} />
    </View>
  );
}

const isCoordinatorError = Schema.is(ProjectCoordinatorError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function assignmentFailure(error: unknown): { message: string; requiresReview: boolean } {
  if (isAuthorizationError(error))
    return {
      message: "This connection does not have permission to assign a coordinator.",
      requiresReview: true,
    };
  if (isCoordinatorError(error) && error.reason !== "persistence-failure")
    return { message: error.message, requiresReview: true };
  return {
    message:
      "Could not assign this thread. Check the connection, then retry; retry preserves this exact request.",
    requiresReview: false,
  };
}

function AssignCoordinator({
  environmentId,
  projectId,
  coordinator,
  ready,
  onReview,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly coordinator: ProjectCoordinator | null;
  readonly ready: boolean;
  readonly onReview: () => void;
}) {
  const focused = useIsFocused();
  const canAssign = useAtomValue(
    factoryEnvironment.coordinatorsAssign.permissionAtom(environmentId),
  );
  const assign = useAtomCommand(factoryEnvironment.coordinatorsAssign, { reportFailure: false });
  const candidates = projectCoordinatorCandidates(
    useAtomValue(
      environmentThreadShells.threadShellsForProjectRefsAtom([
        scopeProjectRef(environmentId, projectId),
      ]),
    ),
    { environmentId, projectId, currentThreadId: coordinator?.threadId ?? null },
  );
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [visibleCandidates, setVisibleCandidates] = useState(20);
  const [request, setRequest] = useState<ProjectCoordinatorAssignInput | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; requiresReview: boolean } | null>(null);
  const inFlight = useRef(false);
  const selected = candidates.find((thread) => thread.id === threadId) ?? null;
  const blocked = !canAssign || !ready || pending || failure?.requiresReview === true;
  const submit = async () => {
    const input =
      request ??
      (selected === null
        ? null
        : {
            commandId: CommandId.make(uuidv4()),
            projectId,
            threadId: selected.id,
            expectedRevision: coordinator?.revision ?? 0,
          });
    if (inFlight.current || blocked || !focused || input === null) return;
    inFlight.current = true;
    setRequest(input);
    setPending(true);
    setFailure(null);
    const result = await assign({ environmentId, input });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Success") {
      setRequest(null);
      if (!result.value.coordinator.current)
        setFailure({
          message:
            "This request refers to an earlier assignment. Review the refreshed coordinator.",
          requiresReview: true,
        });
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(assignmentFailure(squashAtomCommandFailure(result)));
    }
  };
  const review = () => {
    setRequest(null);
    setFailure(null);
    onReview();
  };
  return (
    <View className="gap-3">
      <Text className="text-sm text-foreground-muted">
        Set an existing ordinary thread as coordinator. This sends no message and starts no new
        work. It does not stop existing or pending work; schedules and active tasks stay on their
        threads.
      </Text>
      {coordinator?.status === "launching" ? (
        <Text className="text-sm text-foreground-muted">
          A start is pending for the current coordinator. Reassigning removes its resume option but
          does not cancel a launch that already began.
        </Text>
      ) : null}
      <Text className="text-sm text-foreground">
        {selected
          ? `Selected: ${selected.title} (${selected.id.slice(-8)})`
          : candidates.length === 0
            ? "No eligible threads in this project."
            : "Choose a thread:"}
      </Text>
      {candidates.slice(0, visibleCandidates).map((thread) => (
        <Button
          key={thread.id}
          label={`${thread.title} (${thread.id.slice(-8)})`}
          tone={thread.id === selected?.id ? "primary" : "secondary"}
          disabled={!canAssign || !ready || pending}
          onPress={() => {
            setThreadId(thread.id);
            setRequest(null);
            setFailure(null);
          }}
        />
      ))}
      {candidates.length > visibleCandidates ? (
        <Button
          label="Show more threads"
          onPress={() => setVisibleCandidates((count) => count + 20)}
        />
      ) : null}
      <Button
        label={request ? "Retry assignment" : "Set project coordinator"}
        loading={pending}
        disabled={blocked || (request === null && selected === null)}
        onPress={() => void submit()}
      />
      {request !== null || failure?.requiresReview === true ? (
        <Button label="Review refreshed binding" disabled={pending} onPress={review} />
      ) : null}
      {failure ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {failure.message}
        </Text>
      ) : null}
    </View>
  );
}
