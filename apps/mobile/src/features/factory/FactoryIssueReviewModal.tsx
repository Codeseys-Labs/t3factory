import type { RuntimeMode } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { FACTORY_SUPERVISION_NOTICE, factoryRepositoryLabel } from "./factoryIssues";
import type { FactoryIssueReview } from "./useFactoryIssueActions";

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": msg("Approval required"),
  "auto-accept-edits": msg("Auto-accept edits"),
  auto: msg("Auto"),
  "full-access": msg("Full access"),
};

export function FactoryIssueReviewModal(props: {
  readonly review: FactoryIssueReview;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const { snapshot, failure } = props.review;
  const { input } = snapshot.request;
  const restart = input.restartDeleted === true;
  const changed = failure?.kind === "changed";
  const startLabel = restart ? gt("Start new attempt") : gt("Start task");
  const issueNumber =
    snapshot.issue.number === null ? (snapshot.issue.key ?? "?") : String(snapshot.issue.number);

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-sheet-solid"
        accessibilityViewIsModal
        onAccessibilityEscape={props.onClose}
        style={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <SheetHeader
          presentation="inline"
          title={gt("Review issue")}
          accessibilityLabel={gt("Close issue review")}
          dismissDisabled={props.pending}
          onClose={props.onClose}
        />
        <ScrollView className="min-h-0 flex-1" contentContainerClassName="gap-5 px-5 py-4">
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
              {restart
                ? gt("Start a new attempt for issue #{number}", {
                    number: issueNumber,
                  })
                : gt("Start task for issue #{number}", {
                    number: issueNumber,
                  })}
            </Text>
            <Text selectable className="text-base text-foreground">
              {gt("Repository: {repository}", {
                repository: factoryRepositoryLabel(snapshot.repository),
              })}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {restart
                ? gt(
                    "The earlier thread was deleted. A new attempt creates a new isolated worktree.",
                  )
                : gt("This creates an isolated worktree for the issue.")}
            </Text>
          </View>
          <View className="gap-2">
            <Text selectable className="text-base text-foreground">
              {gt("Model: {model}", { model: snapshot.modelLabel })}
            </Text>
            <Text selectable className="text-base text-foreground">
              {gt("Base: {base}", { base: input.baseRef ?? gt("Current HEAD") })}
            </Text>
            <Text className="text-base text-foreground">
              {gt("Runtime: {mode}", { mode: m(RUNTIME_MODE_LABELS[input.runtimeMode]) })}
            </Text>
            <Text className="text-sm text-foreground-muted">{m(FACTORY_SUPERVISION_NOTICE)}</Text>
            <Text className="text-sm text-foreground-muted">
              <T>
                Confirm uses this issue snapshot and these settings. If a task was already reserved,
                its saved content and settings are used instead.
              </T>
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">
            <T>
              Backslashes are escaped; control and formatting characters are shown as \uXXXX. Tabs
              and newlines stay literal; no source text is omitted.
            </T>
          </Text>
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
              <T>Full issue title</T>
            </Text>
            <Text selectable className="text-base text-foreground">
              {snapshot.titleText}
            </Text>
          </View>
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
              <T>Full issue body</T>
            </Text>
            {snapshot.bodyText === null ? (
              <Text className="text-sm text-foreground-muted">
                <T>No body was provided.</T>
              </Text>
            ) : snapshot.bodyText === "" ? (
              <Text className="text-sm text-foreground-muted">
                <T>The issue body is empty.</T>
              </Text>
            ) : (
              <Text selectable className="text-base text-foreground">
                {snapshot.bodyText}
              </Text>
            )}
          </View>
        </ScrollView>
        <ScrollView
          className="border-t border-border-subtle"
          style={{ flexGrow: 0, maxHeight: "45%" }}
          contentContainerClassName="gap-3 px-5 py-4"
        >
          {failure ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
              <Text className="text-base font-t3-semibold text-danger-foreground">
                {failure.title}
              </Text>
              <Text selectable className="text-sm text-foreground">
                {failure.detail}
              </Text>
              {changed ? (
                <Text className="text-sm text-foreground">
                  <T>
                    Close this review and reopen the issue from the refreshed inbox before starting.
                  </T>
                </Text>
              ) : null}
            </View>
          ) : null}
          <Button
            fullWidth
            tone="primary"
            label={startLabel}
            accessibilityLabel={gt("{action} for reviewed issue {number}", {
              action: startLabel,
              number: issueNumber,
            })}
            loading={props.pending}
            disabled={changed}
            onPress={props.onConfirm}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}
