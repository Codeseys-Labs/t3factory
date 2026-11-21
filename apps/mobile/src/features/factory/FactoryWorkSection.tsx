import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  aggregateFactoryWork,
  factoryWorkKey,
  planFactoryWorkOwners,
} from "@t3tools/client-runtime/state/factory-work";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryWorkKind,
  type ProjectId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useEffect, useRef } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { useFactoryWorkPages } from "../../state/factory";
import { useEnvironmentsWithScope } from "../../state/session";
import { FactoryLocalPlans } from "./FactoryLocalPlans";
import {
  factoryWorkPagesKey,
  loadedFactoryWorkCursors,
  loadMoreFactoryWork,
  resetFactoryWorkPages,
  selectFactoryWorkItem,
  selectFactoryWorkKind,
  useFactoryWorkView,
  type FactoryWorkDetailParams,
} from "./factory-inbox-state";
import {
  FACTORY_WORK_KIND_LABELS,
  FACTORY_WORK_KINDS,
  FACTORY_WORK_OWNER_MESSAGES,
  factoryWorkAccess,
  factoryWorkPageTargets,
  factoryWorkRows,
  resolveFactoryWorkOwners,
  type FactoryWorkOwnerView,
  type FactoryWorkRow,
} from "./factoryWorkList";

export type FactoryWorkRoutes = {
  SettingsFactoryWork: FactoryWorkDetailParams;
};

/** Above this text scale a five-way segmented control truncates; a menu row keeps full labels. */
export const FACTORY_LARGE_TEXT_SCALE = 1.3;

function OwnerHeader(props: { readonly owner: FactoryWorkOwnerView; readonly label: string }) {
  const { owner } = props;
  const gt = useGT();
  const messages = useMessages();
  return (
    <View className="mt-4 gap-1 border-b border-border-subtle px-1 pb-2" accessibilityRole="header">
      <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
      <Text
        className={
          owner.status === "current" || owner.status === "loading"
            ? "text-xs text-foreground-muted"
            : "text-sm text-danger-foreground"
        }
      >
        {messages(FACTORY_WORK_OWNER_MESSAGES[owner.status])}
        {owner.page
          ? ` ${gt("Observed {time}.", { time: new Date(owner.page.fetchedAt).toLocaleString() })}`
          : ""}
      </Text>
    </View>
  );
}

function OwnerFooter(props: {
  readonly owner: FactoryWorkOwnerView;
  readonly label: string;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
}) {
  const { owner } = props;
  const gt = useGT();
  if (owner.status === "failed")
    return (
      <View className="items-start px-1 py-2">
        <Button
          label={gt("Try again")}
          accessibilityLabel={gt("Try reading {label} again", { label: props.label })}
          onPress={props.onRetry}
        />
      </View>
    );
  if (owner.status !== "current") return null;
  const empty = owner.page?.items.length === 0;
  return (
    <View className="items-start gap-2 px-1 py-2">
      {empty ? (
        <Text className="text-sm text-foreground-muted">
          {owner.page?.nextCursor
            ? gt("No retained work on the loaded pages. Load more to keep looking.")
            : gt("No retained work in this scope.")}
        </Text>
      ) : null}
      {owner.more === "loading" ? (
        <AppActivityIndicator
          colorClassName="accent-icon"
          accessibilityLabel={gt("Loading more work from {label}", { label: props.label })}
        />
      ) : owner.more === "failed" ? (
        <>
          <Text className="text-sm text-danger-foreground">
            <T>Couldn't load the next page. Loaded work is still shown.</T>
          </Text>
          <Button
            label={gt("Try again")}
            accessibilityLabel={gt("Try loading more work from {label} again", {
              label: props.label,
            })}
            onPress={props.onRetry}
          />
        </>
      ) : owner.canLoadMore ? (
        <Button
          label={gt("Load more")}
          accessibilityLabel={gt("Load more work from {label}", { label: props.label })}
          onPress={props.onLoadMore}
        />
      ) : owner.page?.nextCursor ? (
        <Text className="text-xs text-foreground-muted">
          <T>Page limit reached. Pull to refresh, or narrow the scope or kind to see more.</T>
        </Text>
      ) : null}
    </View>
  );
}

function WorkRow(props: {
  readonly row: Extract<FactoryWorkRow, { type: "item" }>;
  readonly projectLabel: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const { item, stale } = props.row.entry;
  const gt = useGT();
  const messages = useMessages();
  const conditions = [
    stale ? gt("Stale; refresh to inspect") : null,
    item.sourceState !== null
      ? gt("Source snapshot at admission: {state}", { state: item.sourceState })
      : null,
    item.supersededBy !== null ? gt("Superseded brief") : null,
    item.originConflict || props.row.conflict
      ? gt("Comparable source conflict; owners stay separate")
      : null,
  ].filter((entry): entry is string => entry !== null);
  const kind = messages(FACTORY_WORK_KIND_LABELS[item.ref.kind]);
  const projectRole =
    item.ref.kind === "brief" || item.ref.kind === "protocol"
      ? gt("Authoring project")
      : gt("Admission project");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{title}. {kind}. {role} {project}.", {
        title: item.title,
        kind,
        role: projectRole,
        project: props.projectLabel,
      })}
      accessibilityHint={
        stale ? gt("Refresh this environment to inspect") : gt("Opens work details")
      }
      accessibilityState={{ selected: props.selected, disabled: stale }}
      disabled={stale}
      onPress={props.onPress}
      className={
        props.selected
          ? "min-h-14 gap-1 rounded-2xl border border-border bg-subtle px-3 py-3 active:opacity-70"
          : "min-h-14 gap-1 rounded-2xl px-3 py-3 active:opacity-70 disabled:opacity-60"
      }
    >
      <Text className="text-base text-foreground">{item.title}</Text>
      <Text className="text-xs text-foreground-muted">
        {gt("{kind} · {role} {project} · {date}", {
          kind,
          role: projectRole,
          project: props.projectLabel,
          date: new Date(item.createdAt).toLocaleDateString(),
        })}
      </Text>
      {conditions.map((condition) => (
        <Text key={condition} className="text-xs text-foreground-muted">
          {condition}
        </Text>
      ))}
    </Pressable>
  );
}

export function FactoryWorkKindPicker(props: {
  readonly kind: FactoryWorkKind | null;
  readonly onSelect: (kind: FactoryWorkKind | null) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { fontScale } = useWindowDimensions();
  const selected = props.kind ?? "all";
  const choose = (value: string) => {
    const option = FACTORY_WORK_KINDS.find((entry) => entry.value === value);
    if (option) props.onSelect(option.value === "all" ? null : option.value);
  };
  if (fontScale < FACTORY_LARGE_TEXT_SCALE)
    return (
      <SegmentedControl<FactoryWorkKind | "all">
        options={FACTORY_WORK_KINDS.map((option) => ({
          ...option,
          label: messages(option.label),
          accessibilityLabel: messages(option.accessibilityLabel),
        }))}
        selected={selected}
        onSelect={choose}
      />
    );
  const actions: MenuAction[] = FACTORY_WORK_KINDS.map((option) => ({
    id: option.value,
    title: messages(option.accessibilityLabel),
    state: option.value === selected ? "on" : undefined,
  }));
  const label = messages(
    FACTORY_WORK_KINDS.find((option) => option.value === selected)?.accessibilityLabel ?? "",
  );
  return (
    <Menu actions={actions} onPressAction={({ nativeEvent }) => choose(nativeEvent.event)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Work kind, {kind}", { kind: label })}
        className="min-h-12 justify-center rounded-2xl border border-border-subtle px-4 py-3 active:opacity-70"
      >
        <Text className="text-base text-foreground">{gt("Kind: {kind} ▾", { kind: label })}</Text>
      </Pressable>
    </Menu>
  );
}

export function FactoryWorkSection(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly environments: readonly EnvironmentPresentation[];
}) {
  const { environmentId, projectId, environments } = props;
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<FactoryWorkRoutes>>();
  const view = useFactoryWorkView();
  const projects = useProjects();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const pagesKey = factoryWorkPagesKey({ environmentId, projectId, kind: view.kind });
  const plan = planFactoryWorkOwners({
    environmentIds: environments.map((environment) => environment.environmentId),
    projects:
      environmentId !== null && projectId !== null ? [{ environmentId, id: projectId }] : null,
  });
  const access = (id: EnvironmentId) =>
    factoryWorkAccess(
      environments.find((environment) => environment.environmentId === id),
      readable.has(id),
    );
  const targets = factoryWorkPageTargets({
    plan,
    access,
    kind: view.kind,
    cursors: (id) => loadedFactoryWorkCursors(view, pagesKey, id),
  });
  const { pages, refresh } = useFactoryWorkPages(targets);
  const owners = resolveFactoryWorkOwners({
    plan,
    access,
    pages: (id) => pages.filter((page) => page.environmentId === id).map((page) => page.result),
  });
  const aggregate = aggregateFactoryWork(owners);
  const rows = factoryWorkRows(owners, aggregate);
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const projectLabel = (id: EnvironmentId, project: ProjectId) =>
    projects.find((entry) => entry.environmentId === id && entry.id === project)?.title ??
    gt("{project} (project unavailable)", { project });
  const targetsOf = (id: EnvironmentId) => targets.filter((target) => target.environmentId === id);
  const refreshAll = () => {
    resetFactoryWorkPages(pagesKey);
    for (const owner of owners) {
      const first = targetsOf(owner.environmentId)[0];
      if (first) refresh(first);
    }
  };
  const retry = (owner: FactoryWorkOwnerView) => {
    const pending = targetsOf(owner.environmentId)[owner.status === "failed" ? 0 : owner.pageCount];
    if (pending) refresh(pending);
  };
  const selectedIndex =
    view.selected === null ? -1 : rows.findIndex((row) => row.key === view.selected);
  const listRef = useRef<LegendListRef>(null);
  const revealed = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scrolls the native list once to the work the user returns to, after its page has loaded.
  useEffect(() => {
    if (revealed.current || selectedIndex < 0) return;
    revealed.current = true;
    void listRef.current?.scrollToIndex({
      index: selectedIndex,
      animated: false,
      viewPosition: 0.3,
    });
  }, [selectedIndex, listRef, revealed]);
  const refreshing = owners.some((owner) => owner.status === "loading" && owner.page !== null);
  const loading = owners.length > 0 && owners.every((owner) => owner.status === "loading");

  return (
    <LegendList
      ref={listRef}
      renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
      className="flex-1"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        paddingHorizontal: 20,
        paddingTop: 4,
      }}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      estimatedItemSize={76}
      getItemType={(row) => row.type}
      keyExtractor={(row) => row.key}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} />}
      ListHeaderComponent={
        <View className="gap-3 pt-2">
          {environmentId !== null && projectId !== null ? (
            <FactoryLocalPlans
              key={`${environmentId}:${projectId}`}
              environmentId={environmentId}
              projectId={projectId}
              environment={environments.find((entry) => entry.environmentId === environmentId)}
              canRead={readable.has(environmentId)}
            />
          ) : null}
          <FactoryWorkKindPicker kind={view.kind} onSelect={selectFactoryWorkKind} />
          <Text className="text-xs text-foreground-muted">
            <T>
              Retained issue and feed admissions, authored briefs and sealed protocols. Each
              environment pages and observes on its own. Planning stage is unavailable; open an item
              for executions and outputs. Idle, a closed source and a retained output are not
              acceptance.
            </T>
          </Text>
          {owners.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              {aggregate.incomplete
                ? gt(
                    "Showing loaded pages only. More work may be on later pages or in unavailable environments.",
                  )
                : gt("All retained work in this scope is shown.")}
            </Text>
          ) : null}
          {loading ? (
            <View className="items-center py-6">
              <AppActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel={gt("Loading work")}
              />
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          variant="plain"
          title={gt("No environments in this scope")}
          detail={gt("Connect an environment or widen the scope to see its work.")}
        />
      }
      renderItem={({ item: row }) =>
        row.type === "owner" ? (
          <OwnerHeader owner={row.owner} label={labelOf(row.owner.environmentId)} />
        ) : row.type === "footer" ? (
          <OwnerFooter
            owner={row.owner}
            label={labelOf(row.owner.environmentId)}
            onRetry={() => retry(row.owner)}
            onLoadMore={() => {
              const cursor = row.owner.page?.nextCursor;
              if (cursor) loadMoreFactoryWork(pagesKey, row.owner.environmentId, cursor);
            }}
          />
        ) : (
          <WorkRow
            row={row}
            projectLabel={projectLabel(row.entry.item.ref.environmentId, row.entry.item.projectId)}
            selected={row.key === view.selected}
            onPress={() => {
              selectFactoryWorkItem(factoryWorkKey(row.entry.item.ref));
              navigation.navigate("SettingsFactoryWork", {
                work: JSON.stringify(row.entry.item.ref),
              });
            }}
          />
        )
      }
    />
  );
}
