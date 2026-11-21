import type { FactoryIssue } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { m, type MessageResolver } from "../../i18n/messages";
import {
  factoryIssueDisplayKey,
  factoryTaskStatusLabel,
  factoryTaskStatusTone,
  safeFactoryIssueText,
} from "./factoryIssues";

const TASK_TONES = {
  active: {
    pillClassName: "bg-update",
    textClassName: "text-update-foreground",
  },
  neutral: {
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-secondary",
  },
  danger: {
    pillClassName: "bg-danger",
    textClassName: "text-danger-foreground",
  },
} as const;

export function factoryTaskStatusPill(
  status: NonNullable<FactoryIssue["task"]>["status"],
  resolve: MessageResolver = m,
): StatusTone {
  return {
    label: factoryTaskStatusLabel(status, resolve),
    ...TASK_TONES[factoryTaskStatusTone(status)],
  };
}

/**
 * One queue row. Everything from the issue host is plain text: titles and labels are never
 * parsed as markup, so an issue cannot style the screen or smuggle a link into it. The row only
 * opens the issue; starting and reviewing a task happen on the issue screen itself.
 */
export function FactoryIssueRow(props: {
  readonly issue: FactoryIssue;
  readonly onOpen: (() => void) | null;
  readonly borderTop: boolean;
}) {
  const { issue } = props;
  const gt = useGT();
  const messages = useMessages();
  const displayKey = factoryIssueDisplayKey(issue);
  const title = safeFactoryIssueText(issue.title, 240) || gt("Issue {key}", { key: displayKey });

  return (
    <View className={props.borderTop ? "border-t border-border-subtle" : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          issue.task
            ? gt("Issue {number}, {title}, {state}, {status}", {
                number: displayKey,
                title,
                state: issue.state,
                status: factoryTaskStatusLabel(issue.task.status, messages),
              })
            : gt("Issue {number}, {title}, {state}", {
                number: displayKey,
                title,
                state: issue.state,
              })
        }
        accessibilityState={{ disabled: props.onOpen === null }}
        disabled={props.onOpen === null}
        onPress={props.onOpen ?? undefined}
        className="gap-2 px-4 py-3 active:opacity-70 disabled:opacity-50"
      >
        <View className="flex-row items-start gap-3">
          <Text
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
            numberOfLines={2}
          >
            {title}
          </Text>
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm text-foreground-muted">{displayKey}</Text>
          {issue.state === "closed" ? (
            <StatusPill
              size="compact"
              label={gt("Closed")}
              pillClassName="bg-subtle"
              textClassName="text-foreground-secondary"
            />
          ) : null}
          {issue.task ? (
            <StatusPill size="compact" {...factoryTaskStatusPill(issue.task.status, messages)} />
          ) : null}
          {issue.labels.slice(0, 3).map((label) => (
            <Text key={label} className="text-xs text-foreground-muted" numberOfLines={1}>
              {safeFactoryIssueText(label, 40)}
            </Text>
          ))}
        </View>
      </Pressable>
    </View>
  );
}
