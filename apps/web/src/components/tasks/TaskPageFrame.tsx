import type { ReactNode } from "react";

import { SidebarInset } from "../ui/sidebar";

/** The frame of a Tasks, Inbox or Automations page: a kit `PageHeader`, then a body that fills. */
export function TaskPageFrame({ header, children }: { header: ReactNode; children?: ReactNode }) {
  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {header}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </SidebarInset>
  );
}
