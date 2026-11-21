import type { RuntimeMode } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { FACTORY_KNOWLEDGE_LIMITS, FACTORY_KNOWLEDGE_NOTICE } from "./factoryKnowledge";
import type { FactoryKnowledgeReview } from "./useFactoryKnowledge";

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": msg("Approval required"),
  "auto-accept-edits": msg("Auto-accept edits"),
  auto: msg("Auto"),
  "full-access": msg("Full access"),
};

function ReviewField(props: {
  readonly title: string;
  readonly text: string;
  readonly empty: string;
}) {
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
        {props.title}
      </Text>
      {props.text === "" ? (
        <Text className="text-sm text-foreground-muted">{props.empty}</Text>
      ) : (
        <Text selectable className="text-base text-foreground">
          {props.text}
        </Text>
      )}
    </View>
  );
}

/**
 * The complete frozen brief a task will receive. Nothing is previewed or shortened: confirming
 * admits exactly this revision, so every field is shown in full before the button.
 */
export function FactoryKnowledgeReviewModal(props: {
  readonly review: FactoryKnowledgeReview;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (instructions: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const [instructions, setInstructions] = useState("");
  const { snapshot, failure } = props.review;
  const restart = snapshot.restartDeleted;
  const changed = failure?.kind === "changed";
  const action = restart ? gt("Start new attempt") : gt("Start task");

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
          title={gt("Review brief")}
          accessibilityLabel={gt("Close brief review")}
          dismissDisabled={props.pending}
          onClose={props.onClose}
        />
        <ScrollView className="min-h-0 flex-1" contentContainerClassName="gap-5 px-5 py-4">
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
              {restart ? gt("Start a new attempt for this brief") : gt("Start task for this brief")}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {gt("Revision {revision}", { revision: snapshot.brief.revision })}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {restart
                ? gt("The earlier thread was deleted. A new attempt gets a new private folder.")
                : gt("The task gets a private folder outside this checkout.")}
            </Text>
          </View>
          <View className="gap-2">
            <Text selectable className="text-base text-foreground">
              {gt("Model: {model}", { model: snapshot.modelLabel })}
            </Text>
            <Text className="text-base text-foreground">
              {gt("Runtime: {mode}", { mode: m(RUNTIME_MODE_LABELS[snapshot.runtimeMode]) })}
            </Text>
            <Text className="text-sm text-foreground-muted">{m(FACTORY_KNOWLEDGE_NOTICE)}</Text>
            <Text className="text-sm text-foreground-muted">
              <T>
                Confirm uses this exact brief revision. If a task was already reserved, its saved
                brief and settings are used instead.
              </T>
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">
            <T>
              Backslashes are escaped; control and formatting characters are shown as \uXXXX. Tabs
              and newlines stay literal; no brief text is omitted.
            </T>
          </Text>
          <ReviewField title={gt("Title")} text={snapshot.titleText} empty={gt("No title.")} />
          <ReviewField
            title={gt("Question")}
            text={snapshot.questionText}
            empty={gt("No question.")}
          />
          <ReviewField
            title={gt("Deliverable path")}
            text={snapshot.deliverablePathText}
            empty={gt("No path.")}
          />
          <View className="gap-3">
            <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
              {gt("Inputs ({count})", { count: String(snapshot.inputs.length) })}
            </Text>
            {snapshot.inputs.length === 0 ? (
              <Text className="text-sm text-foreground-muted">
                <T>This brief has no inputs.</T>
              </Text>
            ) : (
              snapshot.inputs.map((entry, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- Frozen reviewed inputs never edit or reorder their rows.
                <View key={index} className="gap-1">
                  <Text selectable className="text-sm font-t3-semibold text-foreground">
                    {index + 1}. {entry.labelText}
                  </Text>
                  {entry.contentText === "" ? (
                    <Text className="text-sm text-foreground-muted">
                      <T>Empty input.</T>
                    </Text>
                  ) : (
                    <Text selectable className="text-sm text-foreground">
                      {entry.contentText}
                    </Text>
                  )}
                </View>
              ))
            )}
          </View>
          <ReviewField
            title={gt("Acceptance criteria")}
            text={snapshot.criteriaText}
            empty={gt("No acceptance criteria.")}
          />
        </ScrollView>
        <ScrollView
          className="border-t border-border-subtle"
          style={{ flexGrow: 0, maxHeight: "45%" }}
          contentContainerClassName="gap-3 px-5 py-4"
          keyboardShouldPersistTaps="handled"
        >
          <AppTextInput
            accessibilityLabel={gt("Optional instructions for the agent")}
            placeholder={gt("Optional instructions")}
            value={instructions}
            multiline
            maxLength={FACTORY_KNOWLEDGE_LIMITS.instructions}
            textAlignVertical="top"
            className="min-h-20"
            editable={!props.pending && !changed}
            onChangeText={setInstructions}
          />
          {failure ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
              <Text className="text-base font-t3-semibold text-danger-foreground">
                {failure.title}
              </Text>
              <Text selectable className="text-sm text-foreground">
                {failure.detail}
              </Text>
            </View>
          ) : null}
          <Button
            fullWidth
            tone="primary"
            label={action}
            accessibilityLabel={gt("{action} for the reviewed brief", { action })}
            loading={props.pending}
            disabled={changed}
            onPress={() => props.onConfirm(instructions)}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}
