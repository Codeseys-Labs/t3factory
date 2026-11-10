import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "~/lib/utils";

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("flex min-w-0 flex-col", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

/** Arrow keys move between tabs and select them; Home and End jump to the ends. */
function TabsList({ className, activateOnFocus = true, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      activateOnFocus={activateOnFocus}
      className={cn("flex min-w-0 items-end gap-1 border-b border-border", className)}
      data-slot="tabs-list"
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "-mb-px inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-sm border-b-2 border-transparent px-3 font-medium text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-active:border-foreground/70 data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("min-w-0 outline-none", className)}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab };
