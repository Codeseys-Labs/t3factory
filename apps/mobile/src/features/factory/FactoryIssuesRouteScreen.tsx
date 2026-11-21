import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { isStandaloneIssueLink, resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryIssue,
  type ProjectId,
} from "@t3tools/contracts";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { msg, T, useGT, useMessages } from "gt-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { issueTrackerEnvironment } from "../../state/issueTrackers";
import { useEnvironmentScope } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { updateFactoryInboxSelection, useFactoryInboxSelection } from "./factory-inbox-state";
import { FactoryIssueRow } from "./FactoryIssueRow";
import {
  describeFactoryFailure,
  FACTORY_ISSUE_FILTERS,
  FACTORY_SUPERVISION_NOTICE,
  factoryRepositoryLabel,
  safeFactoryIssueUrl,
  type FactoryIssueFilter,
} from "./factoryIssues";
import { useFactoryIssueList } from "./useFactoryIssueList";
import { useFactoryLaunchModel } from "./useFactoryLaunch";

type FactoryRoutes = {
  SettingsFactoryModel: undefined;
  SettingsFactoryBranch: undefined;
};

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{label}, {value}", { label: props.label, value: props.value })}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

function StateMessage(props: {
  readonly title: string;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  return (
    <View className="py-6">
      <EmptyState variant="plain" title={props.title} detail={props.detail} action={props.action} />
    </View>
  );
}

export function FactoryIssuesRouteScreen({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<FactoryRoutes>>();
  const selectDetail = useSelectWorkspaceDetail();
  const selection = useFactoryInboxSelection();
  const allProjects = useProjects();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const listActive = canRead;
  const list = useFactoryIssueList({
    environmentId: listActive ? environmentId : null,
    projectId: listActive ? projectId : null,
    filter: selection.filter,
  });
  const launch = useFactoryLaunchModel({ ...selection, environmentId, projectId });
  // Rows open the issue itself; the Factory section there starts and reviews tasks. Without the
  // issues capability the row has nowhere to go and stays inert.
  const issuesReadable =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.issues === true;

  const project =
    allProjects.find((entry) => entry.environmentId === environmentId && entry.id === projectId) ??
    null;
  const failure = list.error
    ? describeFactoryFailure(list.error, messages(msg("Couldn't load issues")), undefined, messages)
    : null;
  const repositoryUrl = list.repository ? safeFactoryIssueUrl(list.repository.url) : null;

  const readTrackerConnections = useAtomQueryRunner(issueTrackerEnvironment.connections, {
    reportFailure: false,
    reportDefect: false,
  });
  const openIssue = (issue: FactoryIssue): (() => void) | null => {
    if (!issuesReadable) return null;
    return () => {
      void (async () => {
        // Only a standalone tracker's link (Linear) needs the bindings, whose read probes it.
        const connections = isStandaloneIssueLink(issue.url)
          ? await readTrackerConnections({ environmentId, input: {} })
          : null;
        const target = resolveIssueLinkTarget({
          url: issue.url,
          projects: allProjects.filter((candidate) => candidate.environmentId === environmentId),
          preferredProjectId: projectId,
          trackers: connections?._tag === "Success" ? connections.value : undefined,
        });
        if (target === null) {
          // A row the issue screen cannot address still opens on its tracker.
          const url = safeFactoryIssueUrl(issue.url);
          if (url !== null) void tryOpenExternalUrl(url);
          return;
        }
        selectDetail({
          name: "Issue",
          params: {
            environmentId: String(environmentId),
            projectId: String(target.ref.projectId),
            tracker: target.ref.tracker,
            ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
            scope: target.ref.scope,
            issueKey: target.ref.key,
          },
        });
      })();
    };
  };

  const renderIssues = (issues: ReadonlyArray<FactoryIssue>) => (
    <SettingsSection>
      {issues.map((issue, index) => (
        <FactoryIssueRow
          key={issue.key ?? issue.url}
          issue={issue}
          borderTop={index > 0}
          onOpen={openIssue(issue)}
        />
      ))}
    </SettingsSection>
  );

  let body: ReactNode;
  if (!canRead) {
    body = (
      <StateMessage
        title={gt("Not permitted")}
        detail={gt("This connection can't read orchestration data in this environment.")}
      />
    );
  } else if (list.loading) {
    body = (
      <View className="items-center py-12">
        <AppActivityIndicator
          colorClassName="accent-icon"
          accessibilityLabel={gt("Loading issues")}
        />
      </View>
    );
  } else if (failure) {
    body = (
      <StateMessage
        title={failure.title}
        detail={failure.detail}
        action={
          <Button tone="primary" label={gt("Try again")} onPress={() => void list.refresh()} />
        }
      />
    );
  } else {
    body = (
      <>
        {list.issues.length === 0 ? (
          <StateMessage
            title={
              selection.filter === "all"
                ? gt("No issues")
                : selection.filter === "open"
                  ? gt("No open issues")
                  : gt("No closed issues")
            }
            detail={
              list.hasMore
                ? gt("This page had no issues. Load the next page to keep looking.")
                : gt("This repository has nothing here yet.")
            }
          />
        ) : (
          renderIssues(list.issues)
        )}
        {list.loadingMore ? (
          <View className="items-center py-4">
            <AppActivityIndicator
              colorClassName="accent-icon"
              accessibilityLabel={gt("Loading more issues")}
            />
          </View>
        ) : list.loadMoreError ? (
          <View className="items-center gap-2 px-4">
            <Text className="text-center text-sm text-foreground-muted">
              {
                describeFactoryFailure(
                  list.loadMoreError,
                  messages(msg("Couldn't load more")),
                  undefined,
                  messages,
                ).detail
              }
            </Text>
            <Button label={gt("Try again")} onPress={() => void list.loadMore()} />
          </View>
        ) : list.hasMore ? (
          <View className="items-center">
            <Button
              label={gt("Load more")}
              accessibilityLabel={gt("Load more issues")}
              onPress={() => void list.loadMore()}
            />
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          listActive ? (
            <RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refresh()} />
          ) : undefined
        }
      >
        <SettingsSection title={gt("Source")}>
          <View className="gap-1 px-4 py-3">
            <Text className="text-lg text-foreground">
              {project?.title ?? gt("Project unavailable")}
            </Text>
            <Text className="text-sm text-foreground-muted" selectable>
              {project?.workspaceRoot}
            </Text>
          </View>
          <View className="min-h-14 justify-center gap-0.5 border-t border-border-subtle px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              <T>Issues from</T>
            </Text>
            <Text className="text-base text-foreground" selectable>
              {list.repository && list.capabilities
                ? `${list.capabilities.displayName} · ${factoryRepositoryLabel(list.repository)}`
                : list.loading
                  ? gt("Resolving repository…")
                  : gt("Repository not resolved")}
            </Text>
            {repositoryUrl ? (
              <Text className="text-xs text-foreground-muted" selectable numberOfLines={1}>
                {repositoryUrl}
              </Text>
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection title={gt("New tasks")}>
          <PickerRow
            label={gt("Model")}
            value={
              launch.label ?? (launch.modelOptions.length ? gt("Choose model") : gt("No models"))
            }
            disabled={projectId === null}
            onPress={() => navigation.navigate("SettingsFactoryModel")}
          />
          <PickerRow
            borderTop
            label={gt("Base branch")}
            value={selection.baseRef ?? gt("Current HEAD")}
            disabled={projectId === null}
            onPress={() => navigation.navigate("SettingsFactoryBranch")}
          />
          {selection.baseRef !== null ? (
            <View className="items-start border-t border-border-subtle px-4 py-2">
              <Button
                label={gt("Use current HEAD")}
                tone="text"
                onPress={() => updateFactoryInboxSelection({ baseRef: null })}
              />
            </View>
          ) : null}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          {messages(FACTORY_SUPERVISION_NOTICE)}
        </Text>

        <SegmentedControl<FactoryIssueFilter>
          options={FACTORY_ISSUE_FILTERS.map((filter) => ({
            ...filter,
            label: messages(filter.label),
          }))}
          selected={selection.filter}
          onSelect={(filter) => updateFactoryInboxSelection({ filter })}
        />
        <View className="flex-row items-center justify-between gap-3 px-1">
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {list.fetchedAt
              ? gt("Updated {time}", { time: new Date(list.fetchedAt).toLocaleTimeString() })
              : " "}
          </Text>
          <Button
            tone="text"
            label={gt("Refresh")}
            icon="arrow.clockwise"
            disabled={!listActive || list.loading || list.refreshing}
            onPress={() => void list.refresh()}
          />
        </View>

        {body}
      </ScrollView>
    </View>
  );
}
