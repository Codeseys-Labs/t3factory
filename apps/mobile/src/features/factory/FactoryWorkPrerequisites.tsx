import {
  factoryWorkKey,
  presentFactoryWorkPrerequisites,
  type FactoryWorkOwnerStatus,
  type FactoryWorkPrerequisiteNode,
} from "@t3tools/client-runtime/state/factory-work";
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type FactoryWorkRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment, factoryIssueKeysInput } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { SettingsSection } from "../settings/components/SettingsSection";
import { safeFactoryIssueUrl } from "./factoryIssues";
import { factoryWorkAccess } from "./factoryWorkList";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

interface PrerequisitesProps {
  readonly reference: FactoryWorkRef;
  readonly status: FactoryWorkOwnerStatus;
  readonly withinFilter: (link: {
    readonly ref: FactoryWorkRef;
    readonly projectId: ProjectId;
  }) => boolean;
  readonly onOpen: (reference: FactoryWorkRef) => void;
}

function PrerequisiteDiagram(props: {
  readonly nodes: readonly FactoryWorkPrerequisiteNode[];
  readonly omitted: number;
}) {
  const gt = useGT();
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        {props.omitted > 0
          ? gt(
              "Diagram of {count} direct prerequisites. The list below has equivalent details and links. {omitted} more appear only in the list.",
              { count: String(props.nodes.length), omitted: String(props.omitted) },
            )
          : gt(
              "Diagram of {count} direct prerequisites. The list below has equivalent details and links.",
              { count: String(props.nodes.length) },
            )}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View className="items-center px-1 pb-2">
          <View className="flex-row border-b border-border">
            {props.nodes.map((node) => (
              <View key={node.key} className="w-48 items-center px-2">
                <View className="w-full flex-1 gap-1 rounded-xl border border-border bg-subtle p-3">
                  <Text className="text-sm text-foreground">{node.locator}</Text>
                  <Text className="text-xs text-foreground-muted">{node.tone}</Text>
                </View>
                <View className="h-5 border-l border-border" />
              </View>
            ))}
          </View>
          <View className="h-5 border-l border-border" />
          <View className="max-w-48 rounded-xl border border-border bg-subtle px-4 py-3">
            <Text className="text-sm text-foreground">
              <T>Selected item</T>
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function PrerequisitesBody(props: PrerequisitesProps) {
  const gt = useGT();
  const [page, setPage] = useState(0);
  const nowMs = useNowMinuteMs();
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === props.reference.environmentId,
  );
  const readable = useEnvironmentScope(props.reference.environmentId, AuthOrchestrationReadScope);
  const access =
    props.status === "current" ? factoryWorkAccess(environment, readable) : props.status;
  const supported =
    environment?.serverConfig?.environment.capabilities.factoryWorkPrerequisites === true;
  const query = useEnvironmentQuery(
    supported && access === "current"
      ? factoryEnvironment.readWorkPrerequisites({
          environmentId: props.reference.environmentId,
          input: {
            ref: props.reference,
            ...factoryIssueKeysInput(
              environment?.serverConfig?.environment.capabilities.factoryIssueKeys === true,
            ),
          },
        })
      : null,
  );
  const status = isAuthorizationError(query.failure) ? "forbidden" : access;
  const view = presentFactoryWorkPrerequisites({
    status,
    supported,
    failed: query.error !== null,
    result: query.isPending ? null : query.data,
    withinFilter: props.withinFilter,
    page,
    nowMs,
  });

  return (
    <View className="gap-3">
      <Button
        tone="text"
        label={query.error === null ? gt("Refresh prerequisites") : gt("Try prerequisites again")}
        disabled={status !== "current" || !supported || query.isPending}
        onPress={query.refresh}
      />
      {view.state !== "observed" ? (
        <Text className="text-sm text-foreground-muted" accessibilityLiveRegion="polite">
          {view.message}
        </Text>
      ) : (
        <>
          <Text className="text-base text-foreground">{view.verdict}</Text>
          <Text className="text-xs text-foreground-muted">{view.observation}</Text>
          {view.emptyMessage !== null ? (
            <Text className="text-sm text-foreground-muted">{view.emptyMessage}</Text>
          ) : (
            <>
              <PrerequisiteDiagram nodes={view.graph.nodes} omitted={view.graph.omitted} />
              <Text className="text-xs text-foreground-muted" accessibilityLiveRegion="polite">
                {gt("Listing {first}–{last} of {total} direct prerequisites.", {
                  first: String(view.list.first),
                  last: String(view.list.last),
                  total: String(view.list.total),
                })}
              </Text>
              <Text className="text-base font-t3-medium text-foreground" accessibilityRole="header">
                <T>Direct prerequisites</T>
              </Text>
              {view.list.entries.map((node) => {
                const sourceUrl = safeFactoryIssueUrl(node.sourceUrl ?? "");
                const link = node.link;
                return (
                  <View
                    key={node.key}
                    className="gap-2 rounded-2xl border border-border-subtle p-3"
                  >
                    <Text className="text-base text-foreground" selectable>
                      {node.locator} · {node.title ?? gt("Title unavailable")}
                    </Text>
                    <Text className="text-sm text-foreground-muted">
                      {node.tone} · {node.sourceLabel}
                    </Text>
                    {link.kind === "retained" ? (
                      <Button
                        label={node.linkLabel}
                        accessibilityLabel={gt("{label}: {locator}", {
                          label: node.linkLabel,
                          locator: node.locator,
                        })}
                        accessibilityHint={gt(
                          "Opens the retained Work detail. Back returns to this selection.",
                        )}
                        onPress={() => props.onOpen(link.ref)}
                      />
                    ) : (
                      <Text className="text-sm text-foreground-muted">{node.linkLabel}</Text>
                    )}
                    {sourceUrl ? (
                      <Button
                        tone="text"
                        label={gt("Open source separately")}
                        accessibilityLabel={gt("Open source separately: {locator}", {
                          locator: node.locator,
                        })}
                        onPress={() => void Linking.openURL(sourceUrl)}
                      />
                    ) : null}
                  </View>
                );
              })}
              {view.list.pageCount > 1 ? (
                <View className="gap-2">
                  <Button
                    label={gt("Previous prerequisites")}
                    disabled={view.list.page === 0}
                    onPress={() => setPage(view.list.page - 1)}
                  />
                  <Button
                    label={gt("Next prerequisites")}
                    disabled={view.list.page + 1 >= view.list.pageCount}
                    onPress={() => setPage(view.list.page + 1)}
                  />
                </View>
              ) : null}
            </>
          )}
          {view.notes.map((note) => (
            <Text key={note} className="text-xs text-foreground-muted">
              {note}
            </Text>
          ))}
        </>
      )}
      <Text className="text-xs text-foreground-muted">
        <T>
          Sub-issues and Factory execution lineage are separate relations and are not shown here.
          Inspecting prerequisites doesn't launch, edit edges, accept or publish.
        </T>
      </Text>
    </View>
  );
}

function PrerequisiteDisclosure(props: PrerequisitesProps) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  return (
    <SettingsSection title={gt("Prerequisites · direct source blockers")}>
      <View className="gap-3 px-4 py-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? gt("Hide prerequisites") : gt("Show prerequisites")}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((current) => !current)}
          className="min-h-12 justify-center rounded-2xl border border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text className="text-base text-foreground">
            {expanded ? gt("Hide prerequisites") : gt("Show prerequisites")}
          </Text>
        </Pressable>
        {expanded ? <PrerequisitesBody {...props} /> : null}
      </View>
    </SettingsSection>
  );
}

export function FactoryWorkPrerequisites(props: PrerequisitesProps) {
  return <PrerequisiteDisclosure key={factoryWorkKey(props.reference)} {...props} />;
}
