import type {
  EnvironmentId,
  FactoryKnowledgeArtifact,
  FactoryKnowledgeBrief,
  FactoryKnowledgeTask,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { m, type MessageResolver } from "../../i18n/messages";
import { FactoryArtifactDeliverySection } from "./FactoryArtifactDeliverySection";
import {
  factoryTaskStatusLabel,
  factoryTaskStatusTone,
  safeFactoryIssueText,
} from "./factoryIssues";
import {
  factoryKnowledgeAction,
  factoryKnowledgePreview,
  formatFactoryBytes,
  shortFactoryDigest,
  type FactoryKnowledgeAction,
} from "./factoryKnowledge";
import { useFactoryKnowledgeTask } from "./useFactoryKnowledge";

const TASK_TONES = {
  active: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  neutral: { pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" },
  danger: { pillClassName: "bg-danger", textClassName: "text-danger-foreground" },
} as const;

function taskTone(
  status: FactoryKnowledgeTask["status"],
  resolve: MessageResolver = m,
): StatusTone {
  return {
    label: factoryTaskStatusLabel(status, resolve),
    ...TASK_TONES[factoryTaskStatusTone(status)],
  };
}

function ArtifactDetails(props: { readonly artifact: FactoryKnowledgeArtifact }) {
  const { artifact } = props;
  const gt = useGT();
  const messages = useMessages();
  const preview = factoryKnowledgePreview(artifact.preview);
  return (
    <View className="gap-2">
      <Text selectable className="text-sm text-foreground">
        {artifact.path}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        {gt("sha256 {digest} · {bytes} · read {time}", {
          digest: shortFactoryDigest(artifact.sha256),
          bytes: formatFactoryBytes(artifact.bytes, messages),
          time: new Date(artifact.observedAt).toLocaleString(),
        })}
      </Text>
      {preview === null ? (
        <Text className="text-xs text-foreground-muted">
          <T>No text preview. The file is not UTF-8 text.</T>
        </Text>
      ) : (
        <>
          <ScrollView
            nestedScrollEnabled
            style={{ maxHeight: 280 }}
            className="rounded-xl border border-border-subtle bg-subtle"
            contentContainerClassName="p-3"
          >
            <Text selectable className="font-mono text-xs text-foreground">
              {preview.text.length === 0 ? gt("The file is empty.") : preview.text}
            </Text>
          </ScrollView>
          {preview.truncated ? (
            <Text className="text-xs text-foreground-muted">
              <T>Preview shortened. Open the thread to read the whole file.</T>
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * Acceptance is a human decision about exact bytes. The section shows only what the last read
 * observed and accepts exactly that digest, so a rewritten artifact is refused, never pinned.
 * Mounted only while its row is expanded: each mount hashes the artifact on the server.
 */
function FactoryKnowledgeTaskSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly briefId: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const task = useFactoryKnowledgeTask(props);
  if (!task.supported) return null;
  const { view, failure } = task;
  const permissionReason = task.canAccept
    ? null
    : gt("This connection isn't permitted to accept artifacts in this environment.");

  let content: ReactNode;
  if (view === null) {
    content = (
      <Text className="text-sm text-foreground-muted">
        {task.readError ?? gt("Reading the artifact…")}
      </Text>
    );
  } else if (view.kind === "none") {
    content =
      view.artifact === null ? (
        <Text className="text-sm text-foreground-muted">{view.unavailable}</Text>
      ) : (
        <>
          <Text className="text-sm text-foreground">
            <T>No artifact accepted</T>
          </Text>
          <ArtifactDetails artifact={view.artifact} />
          <Button
            fullWidth
            tone="primary"
            label={gt("Accept this artifact")}
            accessibilityLabel={gt("Accept artifact {digest}", {
              digest: shortFactoryDigest(view.artifact.sha256),
            })}
            accessibilityHint={permissionReason ?? undefined}
            loading={task.pending}
            disabled={permissionReason !== null}
            onPress={() => void task.accept(false)}
          />
          {permissionReason ? (
            <Text className="text-xs text-foreground-muted">{permissionReason}</Text>
          ) : null}
        </>
      );
  } else {
    const accepted = view.acceptance;
    content = (
      <>
        <View className="gap-1">
          <Text selectable className="text-sm text-foreground">
            {gt("Accepted sha256 {digest} · {bytes}", {
              digest: shortFactoryDigest(accepted.sha256),
              bytes: formatFactoryBytes(accepted.bytes, messages),
            })}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {new Date(accepted.acceptedAt).toLocaleString()}
          </Text>
        </View>
        {view.kind === "unverifiable" ? (
          <Text className="text-xs text-foreground-muted">
            {gt("{reason} Whether it changed since acceptance is unknown.", {
              reason: view.unavailable,
            })}
          </Text>
        ) : null}
        {view.kind === "current" ? <ArtifactDetails artifact={view.artifact} /> : null}
        {view.kind === "changed" ? (
          <>
            <View accessibilityRole="alert" className="gap-1">
              <Text className="text-sm font-t3-semibold text-danger-foreground">
                <T>Artifact changed since acceptance</T>
              </Text>
            </View>
            <ArtifactDetails artifact={view.artifact} />
            <Button
              fullWidth
              tone="primary"
              label={gt("Re-accept")}
              accessibilityLabel={gt("Re-accept artifact {digest}", {
                digest: shortFactoryDigest(view.artifact.sha256),
              })}
              accessibilityHint={permissionReason ?? undefined}
              loading={task.pending}
              disabled={permissionReason !== null}
              onPress={() => void task.accept(true)}
            />
            {permissionReason ? (
              <Text className="text-xs text-foreground-muted">{permissionReason}</Text>
            ) : null}
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      <View className="gap-2">
        <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
          <T>Artifact</T>
        </Text>
        {content}
        {failure ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
            <Text className="text-sm font-t3-semibold text-danger-foreground">{failure.title}</Text>
            <Text selectable className="text-sm text-foreground">
              {failure.detail}
            </Text>
          </View>
        ) : null}
        <Button
          tone="text"
          label={gt("Refresh")}
          accessibilityLabel={gt("Refresh artifact")}
          disabled={task.pending || task.loading}
          onPress={task.refresh}
        />
      </View>
      {view !== null && view.kind === "current" ? (
        // Only the exact bytes a person accepted may be posted; any other state offers nothing.
        <FactoryArtifactDeliverySection
          environmentId={props.environmentId}
          projectId={props.projectId}
          acceptance={view.acceptance}
        />
      ) : null}
    </>
  );
}

/** One brief. Brief text is plain text from a person, never parsed as markup or links. */
export function FactoryBriefRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly brief: FactoryKnowledgeBrief;
  readonly task: FactoryKnowledgeTask | null;
  readonly busy: boolean;
  /** Another brief is being launched; starting is held until it settles. */
  readonly locked: boolean;
  readonly canStart: boolean;
  readonly borderTop: boolean;
  readonly onPerform: (brief: FactoryKnowledgeBrief, action: FactoryKnowledgeAction) => void;
}) {
  const { brief, task } = props;
  const gt = useGT();
  const messages = useMessages();
  const [expanded, setExpanded] = useState(false);
  const action = factoryKnowledgeAction(brief, task, messages);
  const title = safeFactoryIssueText(brief.title, 240) || gt("Untitled brief");
  const needsStart =
    action.kind === "start" || action.kind === "resume" || action.kind === "restart";
  const disabled = props.busy || (needsStart && (!props.canStart || props.locked));
  const superseded = brief.supersededBy !== null;
  const revision = shortFactoryDigest(brief.revision);
  const accessibilityLabel = task
    ? superseded
      ? gt("Brief {title}, revision {revision}, superseded, {status}", {
          title,
          revision,
          status: factoryTaskStatusLabel(task.status, messages),
        })
      : gt("Brief {title}, revision {revision}, {status}", {
          title,
          revision,
          status: factoryTaskStatusLabel(task.status, messages),
        })
    : superseded
      ? gt("Brief {title}, revision {revision}, superseded, not started", { title, revision })
      : gt("Brief {title}, revision {revision}, not started", { title, revision });

  return (
    <View className={props.borderTop ? "border-t border-border-subtle" : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="gap-2 px-4 py-3 active:opacity-70"
      >
        <View className="flex-row items-start gap-3">
          <Text
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
            numberOfLines={expanded ? undefined : 2}
          >
            {title}
          </Text>
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm text-foreground-muted">
            {gt("rev {revision}", { revision })}
          </Text>
          {superseded ? (
            <StatusPill
              size="compact"
              label={gt("Superseded")}
              pillClassName="bg-subtle"
              textClassName="text-foreground-secondary"
            />
          ) : null}
          {task ? (
            <StatusPill size="compact" {...taskTone(task.status, messages)} />
          ) : (
            <Text className="text-sm text-foreground-muted">
              <T>Not started</T>
            </Text>
          )}
        </View>
      </Pressable>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          <Text selectable className="text-sm leading-normal text-foreground-secondary">
            {safeFactoryIssueText(brief.question) || gt("No question.")}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {gt(
              "Deliverable {path} · {count, plural, one {{count} input} other {{count} inputs}} · created {time}",
              {
                path: brief.deliverablePath,
                count: brief.inputs.length,
                time: new Date(brief.createdAt).toLocaleString(),
              },
            )}
          </Text>
          {task ? (
            <Text className="text-xs text-foreground-muted">
              {gt("Task started {time}", { time: new Date(task.createdAt).toLocaleString() })}
            </Text>
          ) : null}
          {action.kind === "unavailable" ? (
            <Text className="text-sm text-foreground-muted">{action.detail}</Text>
          ) : (
            <Button
              label={action.label}
              tone={action.kind === "open" ? "secondary" : "primary"}
              accessibilityLabel={gt("{action} for brief {title}", {
                action: action.label,
                title,
              })}
              loading={props.busy}
              disabled={disabled}
              onPress={() => props.onPerform(brief, action)}
            />
          )}
          {task !== null ? (
            // Kept for a deleted thread too, so an earlier acceptance stays visible.
            <FactoryKnowledgeTaskSection
              environmentId={props.environmentId}
              projectId={props.projectId}
              briefId={brief.id}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
