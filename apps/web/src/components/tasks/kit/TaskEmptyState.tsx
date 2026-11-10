import { InboxIcon, SquareKanbanIcon } from "lucide-react";

import { Button } from "../../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../ui/empty";
import { Kbd } from "../../ui/kbd";
import type { KitAction } from "./banners";

/** Centred block for an empty board, list or inbox: one primary action and one alternative. */
export function TaskEmptyState({
  icon,
  title,
  body,
  primary,
  shortcut,
  secondary,
}: {
  icon: "tasks" | "inbox";
  title: string;
  body: string;
  primary?: KitAction;
  /** A key hint shown inside the primary button, such as `C` for New task. */
  shortcut?: string;
  secondary?: KitAction;
}) {
  const Icon = icon === "tasks" ? SquareKanbanIcon : InboxIcon;
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {primary || secondary ? (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {primary ? (
              <Button size="sm" disabled={primary.disabled} onClick={primary.onClick}>
                {primary.label}
                {shortcut ? <Kbd>{shortcut}</Kbd> : null}
              </Button>
            ) : null}
            {secondary ? (
              <Button
                variant="outline"
                size="sm"
                disabled={secondary.disabled}
                onClick={secondary.onClick}
              >
                {secondary.label}
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
