import type {
  EnvironmentId,
  FactoryArtifactDeliveryIntent,
  FactoryKnowledgeAcceptance,
  ProjectId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Linking, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FailureNotice } from "./FactoryDeliverySection";
import {
  factoryArtifactDeliveryStatusView,
  factoryArtifactDestinationText,
  factoryArtifactGrantBlocker,
  factoryRepositoryLabel,
  isFactoryArtifactReconcilable,
  liveFactoryArtifactIntent,
  parseFactoryIssueNumber,
  safeFactoryIssueUrl,
} from "./factoryIssues";
import { formatFactoryBytes, shortFactoryDigest } from "./factoryKnowledge";
import { useFactoryArtifactDelivery } from "./useFactoryArtifactDelivery";

function ArtifactDeliveryRow(props: {
  readonly intent: FactoryArtifactDeliveryIntent;
  readonly busy: boolean;
  readonly canReconcile: boolean;
  readonly onReconcile: (intent: FactoryArtifactDeliveryIntent) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const view = factoryArtifactDeliveryStatusView(props.intent, messages);
  const commentUrl = props.intent.remote ? safeFactoryIssueUrl(props.intent.remote.url) : null;
  const link = commentUrl === null ? null : { label: gt("Open comment"), url: commentUrl };
  const host = props.intent.repository.host;
  // Static text while the server posts: no spinner, so nothing repaints while it waits.
  return (
    <View className="gap-1">
      <Text
        selectable
        className={
          view.kind === "failed" || view.kind === "unknown"
            ? "text-sm text-danger-foreground"
            : "text-sm text-foreground"
        }
      >
        {view.text}
      </Text>
      {link !== null ? (
        <Button
          tone="text"
          icon="arrow.up.right"
          label={link.label}
          onPress={() => void Linking.openURL(link.url)}
        />
      ) : null}
      {isFactoryArtifactReconcilable(props.intent) ? (
        <>
          <Button
            tone="secondary"
            label={gt("Reconcile")}
            accessibilityLabel={gt("Reconcile with {host}", { host })}
            accessibilityHint={
              props.canReconcile
                ? undefined
                : gt("This connection isn't permitted to reconcile in this environment.")
            }
            loading={props.busy}
            disabled={props.busy || !props.canReconcile}
            onPress={() => props.onReconcile(props.intent)}
          />
          {props.canReconcile ? null : (
            <Text className="text-xs text-foreground-muted">
              <T>This connection isn't permitted to reconcile in this environment.</T>
            </Text>
          )}
        </>
      ) : null}
    </View>
  );
}

/**
 * Posting the accepted artifact as one comment on an issue of this project's repository. The
 * person types only the issue number; the server renders the comment from the accepted bytes, and
 * the review shows that exact text. Nothing here retries on its own: a lost response is settled
 * by an explicit Reconcile, which reads the issue's comments and never posts.
 */
export function FactoryArtifactDeliverySection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly acceptance: FactoryKnowledgeAcceptance;
}) {
  const { acceptance } = props;
  const gt = useGT();
  const messages = useMessages();
  const delivery = useFactoryArtifactDelivery({
    environmentId: props.environmentId,
    projectId: props.projectId,
    threadId: acceptance.threadId,
  });
  const [issueText, setIssueText] = useState("");
  if (!delivery.supported) return null;

  const issueNumber = parseFactoryIssueNumber(issueText);
  const { prepared } = delivery;
  const liveIntent = liveFactoryArtifactIntent(delivery.intents, issueNumber);
  const busy = delivery.pending || delivery.preparing;
  const blocker = factoryArtifactGrantBlocker({
    permitted: delivery.canGrant,
    acceptedSha256: acceptance.sha256,
    issueNumber,
    liveIntent,
    prepared,
    resolve: messages,
  });
  const prepareBlocker =
    issueNumber === null ? gt("Enter the issue number before preparing.") : null;

  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
        <T>Publish as issue comment</T>
      </Text>
      {delivery.deliveriesError ? (
        <Text className="text-sm text-foreground-muted">{delivery.deliveriesError}</Text>
      ) : null}
      {delivery.intents.map((intent) => (
        <ArtifactDeliveryRow
          key={intent.id}
          intent={intent}
          busy={delivery.pending}
          canReconcile={delivery.canReconcile}
          onReconcile={(target) => void delivery.reconcile(target)}
        />
      ))}
      <AppTextInput
        accessibilityLabel={gt("Issue number")}
        placeholder={gt("Issue number")}
        value={issueText}
        keyboardType="number-pad"
        maxLength={9}
        editable={!delivery.pending}
        onChangeText={setIssueText}
      />
      <Button
        fullWidth
        tone="secondary"
        label={gt("Prepare")}
        accessibilityLabel={gt("Prepare issue comment preview")}
        accessibilityHint={prepareBlocker ?? undefined}
        loading={delivery.preparing}
        disabled={busy || prepareBlocker !== null}
        onPress={() => {
          if (issueNumber !== null) delivery.prepare(issueNumber);
        }}
      />
      {prepared ? (
        <View className="gap-2">
          <Text selectable className="text-sm text-foreground">
            {gt("Comment on {repository} {destination}", {
              repository: factoryRepositoryLabel(prepared.repository),
              destination: factoryArtifactDestinationText(prepared.destination, messages),
            })}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {gt("sha256 {digest} · {bytes} · preview {preview}", {
              digest: shortFactoryDigest(prepared.artifactSha256),
              bytes: formatFactoryBytes(prepared.artifactBytes, messages),
              preview: prepared.payloadDigest.slice(0, 12),
            })}
          </Text>
          {/* The body is shown as plain text: it is exactly what the server will post. */}
          <ScrollView
            nestedScrollEnabled
            style={{ maxHeight: 280 }}
            accessibilityLabel={gt("Exact comment text")}
            className="rounded-xl border border-border-subtle bg-subtle"
            contentContainerClassName="p-3"
          >
            <Text selectable className="font-mono text-xs text-foreground">
              {prepared.body}
            </Text>
          </ScrollView>
        </View>
      ) : null}
      {delivery.previewFailure === null ? null : delivery.previewFailure.kind === "unsupported" ? (
        // A host without issue comments gets one line, not an error.
        <Text className="text-sm text-foreground-muted">{delivery.previewFailure.detail}</Text>
      ) : (
        <FailureNotice failure={delivery.previewFailure} />
      )}
      <Button
        fullWidth
        tone="primary"
        label={gt("Grant publish")}
        accessibilityLabel={
          prepared
            ? gt("Grant publish of comment on issue {number}", {
                number: String(prepared.destination.number),
              })
            : gt("Grant publish")
        }
        accessibilityHint={blocker ?? undefined}
        loading={delivery.pending}
        disabled={busy || blocker !== null}
        onPress={() => void delivery.grant()}
      />
      {blocker ? <Text className="text-xs text-foreground-muted">{blocker}</Text> : null}
      {delivery.failure ? <FailureNotice failure={delivery.failure} live /> : null}
      <Button
        tone="text"
        label={gt("Refresh")}
        accessibilityLabel={gt("Refresh comment status")}
        disabled={busy || delivery.deliveriesLoading}
        onPress={delivery.refresh}
      />
    </View>
  );
}
