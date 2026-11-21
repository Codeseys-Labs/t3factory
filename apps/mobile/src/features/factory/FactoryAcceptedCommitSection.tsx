import type {
  EnvironmentId,
  FactoryAcceptance,
  FactoryIssueCapabilities,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FactoryDeliverySection } from "./FactoryDeliverySection";
import { shortFactorySha } from "./factoryIssues";
import { useFactoryAcceptCommit } from "./useFactoryIssueActions";

function AcceptedDetails(props: { readonly acceptance: FactoryAcceptance }) {
  const { acceptance } = props;
  const gt = useGT();
  const evidence = acceptance.evidenceRefs.length;
  return (
    <View className="gap-1">
      <Text selectable className="text-sm text-foreground">
        {gt("Accepted {sha}", { sha: shortFactorySha(acceptance.headSha) })}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {gt("{time} · {count, plural, one {{count} evidence ref} other {{count} evidence refs}}", {
          time: new Date(acceptance.acceptedAt).toLocaleString(),
          count: evidence,
        })}
      </Text>
    </View>
  );
}

/**
 * Acceptance is a human decision about one exact commit. The section shows only what the last
 * read observed and accepts exactly that head, so a moved worktree is refused, never pinned.
 */
export function FactoryAcceptedCommitSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly issue: { readonly number: number; readonly title: string; readonly url: string };
  readonly capabilities: FactoryIssueCapabilities;
}) {
  const gt = useGT();
  const acceptance = useFactoryAcceptCommit(props);
  if (!acceptance.supported) return null;
  const { view, failure } = acceptance;
  const permissionReason = acceptance.canAccept
    ? null
    : gt("This connection isn't permitted to accept commits in this environment.");

  let content: ReactNode;
  if (view === null) {
    content = (
      <Text className="text-sm text-foreground-muted">
        {acceptance.readError ?? gt("Reading the worktree head…")}
      </Text>
    );
  } else if (view.kind === "none") {
    const unavailable =
      view.liveHeadSha === null
        ? gt("The task's worktree can't be read, so there is no commit to accept.")
        : null;
    content = (
      <>
        <Text selectable className="text-sm text-foreground">
          {view.liveHeadSha === null
            ? gt("No commit accepted")
            : gt("No commit accepted · head {sha}", {
                sha: shortFactorySha(view.liveHeadSha),
              })}
        </Text>
        <Button
          fullWidth
          tone="primary"
          label={gt("Accept this commit")}
          accessibilityLabel={
            view.liveHeadSha === null
              ? gt("Accept this commit")
              : gt("Accept commit {sha}", { sha: shortFactorySha(view.liveHeadSha) })
          }
          accessibilityHint={unavailable ?? permissionReason ?? undefined}
          loading={acceptance.pending}
          disabled={unavailable !== null || permissionReason !== null}
          onPress={() => void acceptance.accept(false)}
        />
        {(unavailable ?? permissionReason) ? (
          <Text className="text-xs text-foreground-muted">{unavailable ?? permissionReason}</Text>
        ) : null}
      </>
    );
  } else {
    content = (
      <>
        <AcceptedDetails acceptance={view.acceptance} />
        {view.kind === "unverifiable" ? (
          <Text className="text-xs text-foreground-muted">
            <T>The worktree can't be read, so whether the head moved is unknown.</T>
          </Text>
        ) : null}
        {view.kind === "moved" ? (
          <>
            <View accessibilityRole="alert" className="gap-1">
              <Text className="text-sm font-t3-semibold text-danger-foreground">
                <T>Head moved since acceptance</T>
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {gt("Current head {sha}", { sha: shortFactorySha(view.liveHeadSha) })}
              </Text>
            </View>
            <Button
              fullWidth
              tone="primary"
              label={gt("Re-accept at current head")}
              accessibilityLabel={gt("Re-accept at current head {sha}", {
                sha: shortFactorySha(view.liveHeadSha),
              })}
              accessibilityHint={permissionReason ?? undefined}
              loading={acceptance.pending}
              disabled={permissionReason !== null}
              onPress={() => void acceptance.accept(true)}
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
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
        <T>Accepted commit</T>
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
        accessibilityLabel={gt("Refresh accepted commit")}
        disabled={acceptance.pending || acceptance.loading}
        onPress={acceptance.refresh}
      />
      {view !== null && view.kind !== "none" ? (
        // Stays mounted when the head moves so a published or pending pull request stays visible;
        // only granting needs the acceptance to be current.
        <FactoryDeliverySection
          environmentId={props.environmentId}
          projectId={props.projectId}
          threadId={props.threadId}
          issue={props.issue}
          acceptedHeadSha={view.acceptance.headSha}
          acceptanceCurrent={view.kind === "current"}
          capabilities={props.capabilities}
        />
      ) : null}
    </View>
  );
}
