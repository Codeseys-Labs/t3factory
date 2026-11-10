import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { TONE_CLASSES, type TaskPill } from "./taskPresentation";

const PILL_ICONS: Record<Exclude<TaskPill["icon"], "dot">, AppSymbolName> = {
  alert: "exclamationmark.triangle",
  eye: { ios: "eye", android: "visibility" },
  question: "questionmark.bubble",
};

export function TaskStatePill(props: { readonly pill: TaskPill }) {
  const { pill } = props;
  const tone = TONE_CLASSES[pill.tone];
  return (
    <View
      className={cn("flex-row items-center gap-1.5 rounded-full px-2.5 py-1", tone.container)}
      accessibilityLabel={pill.elapsed ? `${pill.label}, ${pill.elapsed}` : pill.label}
    >
      {pill.icon === "dot" ? (
        <View className={cn("size-1.5 rounded-full", tone.dot)} />
      ) : (
        <SymbolView
          name={PILL_ICONS[pill.icon]}
          size={12}
          tintColorClassName={tone.text.replace("text-", "accent-")}
        />
      )}
      <Text textRole="caption" className={cn("font-t3-medium", tone.text)} numberOfLines={1}>
        {pill.label}
      </Text>
      {pill.elapsed ? (
        <Text textRole="caption" className="text-foreground-muted">
          {pill.elapsed}
        </Text>
      ) : null}
    </View>
  );
}

export function TaskAssigneeChip(props: { readonly label: string; readonly monogram: string }) {
  return (
    <View className="shrink flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-subtle py-1 pl-1 pr-2.5">
      {props.monogram ? (
        <View className="size-5 items-center justify-center rounded-full bg-subtle-strong">
          <Text className="text-3xs font-t3-bold text-foreground-secondary">{props.monogram}</Text>
        </View>
      ) : null}
      <Text
        textRole="caption"
        className={cn("shrink", props.monogram ? "" : "pl-1.5")}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </View>
  );
}

export interface TaskRowProps {
  readonly displayId: string;
  readonly title: string | null;
  readonly projectLabel: string;
  readonly assigneeLabel: string;
  readonly assigneeMonogram: string;
  readonly pill: TaskPill;
  readonly onPress: () => void;
}

/** Two lines: the id and title, then the project, the assignee and the state. */
export function TaskRow(props: TaskRowProps) {
  const title = props.title ?? props.displayId;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.displayId} ${title}. ${props.pill.label}. ${props.projectLabel}. ${props.assigneeLabel}.`}
      accessibilityHint="Opens the task"
      onPress={props.onPress}
      className="mb-2 gap-2.5 rounded-xl bg-card px-4 py-3 active:opacity-70"
    >
      <View className="flex-row items-baseline gap-3">
        <Text textRole="caption" className="font-mono text-foreground-muted">
          {props.displayId}
        </Text>
        <Text className="min-w-0 flex-1 text-base font-t3-medium" numberOfLines={1}>
          {props.title ?? ""}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <View className="min-w-0 shrink flex-row items-center gap-1.5">
          <SymbolView name="folder.fill" size={14} tintColorClassName="accent-icon-muted" />
          <Text
            textRole="footnote"
            className="min-w-0 shrink text-foreground-muted"
            numberOfLines={1}
          >
            {props.projectLabel}
          </Text>
        </View>
        <View className="shrink flex-row items-center gap-2">
          {props.assigneeLabel ? (
            <TaskAssigneeChip label={props.assigneeLabel} monogram={props.assigneeMonogram} />
          ) : null}
          <TaskStatePill pill={props.pill} />
        </View>
      </View>
    </Pressable>
  );
}

export function TasksSectionHeader(props: { readonly title: string }) {
  return (
    <Text
      accessibilityRole="header"
      textRole="footnote"
      className="px-1 pb-2 pt-3 font-t3-medium text-foreground-muted"
    >
      {props.title}
    </Text>
  );
}
