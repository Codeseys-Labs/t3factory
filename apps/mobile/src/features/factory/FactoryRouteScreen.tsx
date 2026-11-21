import type { MenuAction } from "@react-native-menu/menu";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import { StackActions, useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { Pressable, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { FactoryScheduledTasksScreen } from "../settings/SettingsScheduledTasksRouteScreen";
import { FactoryBriefsRouteScreen } from "./FactoryBriefsRouteScreen";
import { FactoryIssuesRouteScreen } from "./FactoryIssuesRouteScreen";
import { FactoryOrchestratorPanel } from "./FactoryOrchestratorPanel";
import {
  FACTORY_LARGE_TEXT_SCALE,
  FactoryWorkSection,
  type FactoryWorkRoutes,
} from "./FactoryWorkSection";
import {
  consumeFactoryWorkflowTarget,
  returnToFactoryWork,
  selectFactoryScope,
  selectFactorySection,
  updateFactoryInboxSelection,
  useFactoryInboxSelection,
  type FactorySection,
} from "./factory-inbox-state";

const SECTIONS: ReadonlyArray<{ readonly value: FactorySection; readonly label: string }> = [
  { value: "work", label: msg("Work") },
  { value: "overview", label: msg("Overview") },
  { value: "issues", label: msg("Issues") },
  { value: "briefs", label: msg("Briefs") },
  { value: "workflows", label: msg("Workflows") },
  { value: "orchestrator", label: msg("Orchestrator") },
];

function ScopePicker({
  label,
  value,
  actions,
  onSelect,
}: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  const gt = useGT();
  return (
    <Menu actions={actions} onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("{label}, {value}", { label, value })}
        className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      >
        <Text className="text-base text-foreground">{label}</Text>
        <Text className="min-w-0 flex-1 text-right text-sm text-foreground-muted" numberOfLines={1}>
          {value} ▾
        </Text>
      </Pressable>
    </Menu>
  );
}

function EnvironmentOverview({
  environment,
  projectId,
  section,
  onChoose,
  onWorkflow,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectId: ProjectId | null;
  readonly section: FactorySection;
  readonly onChoose: (environmentId: EnvironmentId, projectId: ProjectId) => void;
  readonly onWorkflow: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ScheduledTaskId,
  ) => void;
}) {
  const environmentId = environment.environmentId;
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const connected = environment.connection.phase === "connected";
  const config = environment.serverConfig;
  const readable = connected && config !== null && canRead;
  const coordinatorSupported = config?.environment.capabilities.projectCoordinators === true;
  const issuesSupported = config?.environment.capabilities.factoryIssues === true;
  const knowledgeSupported = config?.environment.capabilities.factoryKnowledge === true;
  const tasks = useEnvironmentQuery(
    readable && section === "overview"
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const coordinators = useEnvironmentQuery(
    readable && coordinatorSupported && section !== "issues" && section !== "briefs"
      ? factoryEnvironment.coordinatorsList({ environmentId, input: {} })
      : null,
  );
  const projects = useProjects().filter(
    (project) =>
      !project.isScratch &&
      project.environmentId === environmentId &&
      (projectId === null || project.id === projectId),
  );
  const threads = useThreadShells();
  const unavailable = !connected
    ? gt("Offline. Reconnect to read current Factory data.")
    : config === null
      ? gt("Server metadata is loading.")
      : !canRead
        ? gt("This connection cannot read orchestration data.")
        : null;
  return (
    <SettingsSection title={environment.label}>
      {unavailable ? (
        <Text className="p-4 text-sm text-danger-foreground">{unavailable}</Text>
      ) : null}
      {projects.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          {unavailable
            ? gt("Project metadata is unavailable.")
            : gt("No project checkouts in this environment.")}
        </Text>
      ) : (
        projects.map((project) => {
          const projectThreads = threads.filter(
            (thread) => thread.environmentId === environmentId && thread.projectId === project.id,
          );
          const running = projectThreads.filter(
            (thread) => thread.runtime?.status === "running",
          ).length;
          const workflows = tasks.error
            ? undefined
            : tasks.data?.tasks.filter((task) => task.projectId === project.id);
          const coordinator = coordinators.data?.coordinators.find(
            (entry) => entry.projectId === project.id,
          );
          const featureUnavailable =
            section === "issues" && !issuesSupported
              ? gt("Issue inbox unsupported by this server.")
              : section === "briefs" && !knowledgeSupported
                ? gt("Briefs unsupported by this server.")
                : section === "orchestrator" && !coordinatorSupported
                  ? gt("Orchestrators unsupported by this server.")
                  : null;
          return (
            <View key={project.id} className="gap-2 border-t border-border-subtle p-4">
              <Text className="text-lg font-t3-medium text-foreground">{project.title}</Text>
              <Text className="text-sm text-foreground-muted" selectable>
                {project.workspaceRoot}
              </Text>
              {readable && section === "overview" ? (
                <>
                  <Text className="text-sm text-foreground-muted">
                    {gt("{sessions} sessions · {running} running", {
                      sessions: String(projectThreads.length),
                      running: String(running),
                    })}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {tasks.error
                      ? gt("Workflows unavailable: could not load definitions.")
                      : workflows === undefined
                        ? gt("Loading workflows…")
                        : gt("{count} workflows · {enabled} enabled", {
                            count: String(workflows.length),
                            enabled: String(workflows.filter((task) => task.enabled).length),
                          })}
                  </Text>
                  {workflows?.map((task) => (
                    <Button
                      key={task.id}
                      tone="text"
                      label={
                        task.lastRunAt
                          ? gt("{title} · {status} · {time}", {
                              title: task.title,
                              status: task.lastRunStatus ?? gt("Not dispatched"),
                              time: new Date(task.lastRunAt).toLocaleString(),
                            })
                          : gt("{title} · {status}", {
                              title: task.title,
                              status: task.lastRunStatus ?? gt("Not dispatched"),
                            })
                      }
                      onPress={() => onWorkflow(environmentId, project.id, task.id)}
                    />
                  ))}
                </>
              ) : null}
              {readable && section !== "issues" && section !== "briefs" ? (
                <Text className="text-sm text-foreground-muted">
                  {!coordinatorSupported
                    ? gt("Orchestrators unsupported by this server.")
                    : coordinators.error
                      ? gt("Orchestrator unavailable: could not load binding.")
                      : coordinators.data === null
                        ? gt("Loading orchestrator…")
                        : coordinator
                          ? gt("Orchestrator: {status}", { status: coordinator.status })
                          : gt("No orchestrator created")}
                </Text>
              ) : null}
              {featureUnavailable ? (
                <Text className="text-sm text-danger-foreground">{featureUnavailable}</Text>
              ) : null}
              <Button
                label={
                  section === "issues"
                    ? gt("Choose this checkout for issues")
                    : section === "briefs"
                      ? gt("Choose this checkout for briefs")
                      : section === "orchestrator"
                        ? gt("Choose orchestrator checkout")
                        : gt("Show this checkout")
                }
                disabled={unavailable !== null || featureUnavailable !== null}
                onPress={() => onChoose(environmentId, project.id)}
              />
            </View>
          );
        })
      )}
      {readable && section !== "issues" && section !== "briefs" ? (
        <View className="items-start p-3">
          <Button
            tone="text"
            label={gt("Refresh overview")}
            onPress={() => {
              if (section === "overview") tasks.refresh();
              if (coordinatorSupported) coordinators.refresh();
            }}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}

export function FactoryRouteScreen() {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<FactoryWorkRoutes>>();
  const { fontScale } = useWindowDimensions();
  const selection = useFactoryInboxSelection();
  const reviewingWork =
    selection.workReturn !== null &&
    (selection.section === "issues" || selection.section === "briefs");
  const backToWork = () => {
    const detail = returnToFactoryWork();
    if (detail !== null) navigation.dispatch(StackActions.popTo("SettingsFactoryWork", detail));
  };
  usePreventRemove(reviewingWork, ({ data }) => {
    if (data.action.type === "GO_BACK" || data.action.type === "POP") backToWork();
    else navigation.dispatch(data.action);
  });
  const { environments, isReady } = useEnvironments();
  const projects = useProjects().filter((project) => !project.isScratch);
  const selectedEnvironment =
    selection.environmentId === null
      ? null
      : (environments.find(
          (environment) => environment.environmentId === selection.environmentId,
        ) ?? null);
  const selectedProject =
    selection.projectId === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === selection.environmentId && project.id === selection.projectId,
        ) ?? null);
  const invalid =
    selection.projectId !== null && (selection.environmentId === null || selectedProject === null)
      ? gt(
          "This checkout was removed or is unavailable. Select a known checkout or reset to all projects.",
        )
      : selection.environmentId !== null && selectedEnvironment === null
        ? gt(
            "This environment was removed or is unavailable. Select another environment or reset the scope.",
          )
        : null;
  const scopedEnvironments =
    selection.environmentId === null
      ? environments
      : selectedEnvironment
        ? [selectedEnvironment]
        : [];
  const connected = selectedEnvironment?.connection.phase === "connected";
  const canRead = useEnvironmentScope(selection.environmentId, AuthOrchestrationReadScope);
  const exact = invalid === null && selectedEnvironment !== null && selectedProject !== null;
  const exactReadable = exact && connected && canRead && selectedEnvironment.serverConfig !== null;
  const issuesSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.factoryIssues === true;
  const coordinatorSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.projectCoordinators === true;
  const knowledgeSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.factoryKnowledge === true;
  const environmentActions: MenuAction[] = [
    {
      id: "all",
      title: gt("All environments"),
      state: selection.environmentId === null ? "on" : undefined,
    },
    ...environments.map<MenuAction>((environment) => ({
      id: environment.environmentId,
      title:
        environment.connection.phase === "connected"
          ? environment.label
          : gt("{label} (offline)", { label: environment.label }),
      state: environment.environmentId === selection.environmentId ? "on" : undefined,
    })),
  ];
  const scopeProjects = projects.filter(
    (project) =>
      selection.environmentId === null || project.environmentId === selection.environmentId,
  );
  const projectActions: MenuAction[] = [
    {
      id: "all",
      title: gt("All project checkouts"),
      state: selection.projectId === null ? "on" : undefined,
    },
    ...scopeProjects.map<MenuAction>((project) => ({
      id: JSON.stringify([project.environmentId, project.id]),
      title: `${project.title} · ${environments.find((entry) => entry.environmentId === project.environmentId)?.label ?? gt("Unavailable environment")} · ${project.workspaceRoot}`,
      state:
        project.id === selection.projectId && project.environmentId === selection.environmentId
          ? "on"
          : undefined,
    })),
  ];
  const workflow = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    taskId: ScheduledTaskId,
  ) => {
    selectFactoryScope(environmentId, projectId);
    updateFactoryInboxSelection({ section: "workflows", taskId });
  };
  const sectionKey = JSON.stringify([
    selection.environmentId,
    selection.projectId,
    selection.section,
  ]);

  return (
    <SettingsScreen title={gt("Factory")}>
      <View className="gap-3 px-5 pt-3 pb-2">
        <Text className="text-sm text-foreground-muted">
          <T>Showing work for</T>
        </Text>
        <SettingsSection>
          <ScopePicker
            label={gt("Environment")}
            value={
              selection.environmentId === null
                ? gt("All environments")
                : (selectedEnvironment?.label ?? gt("Unavailable environment"))
            }
            actions={environmentActions}
            onSelect={(id) => {
              if (id === "all") selectFactoryScope(null, null);
              else {
                const environment = environments.find((entry) => entry.environmentId === id);
                if (environment) selectFactoryScope(environment.environmentId, null);
              }
            }}
          />
          <ScopePicker
            label={gt("Checkout")}
            value={
              selection.projectId === null
                ? gt("All project checkouts")
                : (selectedProject?.workspaceRoot ?? gt("Unavailable checkout"))
            }
            actions={projectActions}
            onSelect={(id) => {
              if (id === "all") selectFactoryScope(selection.environmentId, null);
              else {
                const project = scopeProjects.find(
                  (entry) => JSON.stringify([entry.environmentId, entry.id]) === id,
                );
                if (project) selectFactoryScope(project.environmentId, project.id);
              }
            }}
          />
        </SettingsSection>
        {fontScale < FACTORY_LARGE_TEXT_SCALE ? (
          <SegmentedControl<FactorySection>
            options={SECTIONS.map((entry) => ({ ...entry, label: messages(entry.label) }))}
            selected={selection.section}
            onSelect={selectFactorySection}
          />
        ) : (
          <SettingsSection>
            <ScopePicker
              label={gt("Section")}
              value={messages(
                SECTIONS.find((entry) => entry.value === selection.section)?.label ?? "",
              )}
              actions={SECTIONS.map<MenuAction>((entry) => ({
                id: entry.value,
                title: messages(entry.label),
                state: entry.value === selection.section ? "on" : undefined,
              }))}
              onSelect={(id) => {
                const section = SECTIONS.find((entry) => entry.value === id);
                if (section) selectFactorySection(section.value);
              }}
            />
          </SettingsSection>
        )}
        {reviewingWork ? (
          <Button
            icon="chevron.left"
            label={gt("Back to Work")}
            accessibilityHint={gt(
              "Restores the Work scope and reopens the item you were reviewing",
            )}
            onPress={backToWork}
          />
        ) : null}
      </View>
      {!isReady ? (
        <Text className="p-5 text-foreground-muted">
          <T>Loading environments…</T>
        </Text>
      ) : invalid ? (
        <View className="gap-3 p-5">
          <EmptyState variant="plain" title={gt("Scope unavailable")} detail={invalid} />
          <Button label={gt("Show all projects")} onPress={() => selectFactoryScope(null, null)} />
        </View>
      ) : selection.section === "work" ? (
        <FactoryWorkSection
          environmentId={selection.environmentId}
          projectId={selection.projectId}
          environments={scopedEnvironments}
        />
      ) : selection.section === "workflows" ? (
        <FactoryScheduledTasksScreen
          key={sectionKey}
          environmentId={selection.environmentId}
          projectId={selection.projectId}
          {...(selection.taskId === null ? {} : { taskId: selection.taskId })}
          onWorkflowOpened={(taskId) => consumeFactoryWorkflowTarget(selection, taskId)}
        />
      ) : selection.section === "issues" &&
        exactReadable &&
        issuesSupported &&
        selectedProject !== null ? (
        <FactoryIssuesRouteScreen
          key={sectionKey}
          environmentId={selectedProject.environmentId}
          projectId={selectedProject.id}
        />
      ) : selection.section === "briefs" &&
        exactReadable &&
        knowledgeSupported &&
        selectedProject !== null ? (
        <FactoryBriefsRouteScreen
          key={sectionKey}
          environmentId={selectedProject.environmentId}
          projectId={selectedProject.id}
        />
      ) : (
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 px-5 pt-3"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {environments.length === 0 ? (
            <EmptyState
              variant="plain"
              title={gt("Connect an environment")}
              detail={gt("Connect to a server to see its projects, sessions and workflows.")}
            />
          ) : null}
          {selection.section === "issues" ? (
            <Text className="text-sm text-foreground-muted">
              <T>
                Choose one connected, supported checkout to review its issue source and start issue
                work. This is not an aggregate issue queue.
              </T>
            </Text>
          ) : null}
          {selection.section === "briefs" ? (
            <Text className="text-sm text-foreground-muted">
              <T>
                Choose one connected, supported checkout to write briefs and review their artifacts.
                Briefs belong to one project.
              </T>
            </Text>
          ) : null}
          {selection.section === "orchestrator" &&
          exactReadable &&
          coordinatorSupported &&
          selectedProject !== null ? (
            <FactoryOrchestratorPanel
              key={sectionKey}
              environmentId={selectedProject.environmentId}
              projectId={selectedProject.id}
            />
          ) : (
            scopedEnvironments.map((environment) => (
              <EnvironmentOverview
                key={environment.environmentId}
                environment={environment}
                projectId={selection.projectId}
                section={selection.section}
                onChoose={selectFactoryScope}
                onWorkflow={workflow}
              />
            ))
          )}
        </ScrollView>
      )}
    </SettingsScreen>
  );
}
