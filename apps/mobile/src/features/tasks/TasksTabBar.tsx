import { msg, useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

export type TasksTab = "tasks" | "inbox" | "threads";

const TABS: readonly {
  readonly id: TasksTab;
  readonly label: string;
  readonly icon: AppSymbolName;
}[] = [
  { id: "tasks", label: msg("Tasks"), icon: "square.grid.2x2" },
  { id: "inbox", label: msg("Inbox"), icon: { ios: "tray", android: "folder_open" } },
  { id: "threads", label: msg("Threads"), icon: "text.bubble" },
];

/** Tasks, Inbox and Threads. The Inbox count stays amber while tasks need you. */
export function TasksTabBar(props: {
  readonly selected: TasksTab;
  readonly needsCount: number;
  readonly needsIncomplete: boolean;
  readonly onSelect: (tab: TasksTab) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-border-subtle bg-screen"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      {TABS.map((tab) => {
        const selected = tab.id === props.selected;
        const count = tab.id === "inbox" ? props.needsCount : 0;
        const incomplete = tab.id === "inbox" && props.needsIncomplete;
        const countLabel = `${count}${incomplete ? "+" : ""}`;
        const label = m(tab.label);
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              count > 0 || incomplete
                ? incomplete
                  ? gt("{label}, at least {count} need you", { label, count: String(count) })
                  : gt("{label}, {count} need you", { label, count: String(count) })
                : label
            }
            onPress={() => props.onSelect(tab.id)}
            className="min-h-14 flex-1 items-center justify-center gap-1 py-2 active:opacity-70"
          >
            <View className="flex-row items-start">
              <SymbolView
                name={tab.icon}
                size={22}
                tintColorClassName={selected ? "accent-icon" : "accent-icon-muted"}
              />
              {count > 0 || incomplete ? (
                <View className="-mr-5 ml-0.5 min-w-4 items-center rounded-full bg-adaptive-amber-500-a25-400-a25 px-1">
                  <Text className="text-3xs font-t3-bold text-adaptive-amber-700-300">
                    {countLabel}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              textRole="caption"
              className={cn(selected ? "font-t3-medium" : "text-foreground-muted")}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
