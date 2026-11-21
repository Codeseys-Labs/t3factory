import type { FactoryIssue, FactoryIssueTask } from "@t3tools/contracts";

export type FactoryIssueViewMode = "list" | "table" | "board";
export type FactoryIssueStage = "none" | FactoryIssueTask["status"];

export function parseFactoryIssueViewMode(value: unknown): FactoryIssueViewMode {
  return value === "table" || value === "board" ? value : "list";
}

export type FactoryIssueLayout = "table" | "board";

/** The queue has no plain list: the shared `view` route value `list` lands on the table. */
export function factoryIssueLayout(view: FactoryIssueViewMode): FactoryIssueLayout {
  return view === "board" ? "board" : "table";
}

const FACTORY_ISSUE_STAGES: ReadonlyArray<FactoryIssueStage> = [
  "none",
  "launching",
  "preparing",
  "running",
  "idle",
  "failed",
  "archived",
  "missing",
];

export function groupFactoryIssuesByStage(issues: ReadonlyArray<FactoryIssue>): ReadonlyArray<{
  readonly stage: FactoryIssueStage;
  readonly issues: ReadonlyArray<FactoryIssue>;
}> {
  const byStage: Record<FactoryIssueStage, FactoryIssue[]> = {
    none: [],
    launching: [],
    preparing: [],
    running: [],
    idle: [],
    failed: [],
    archived: [],
    missing: [],
  };
  for (const issue of issues) {
    byStage[issue.task?.status ?? "none"].push(issue);
  }
  return FACTORY_ISSUE_STAGES.map((stage) => ({ stage, issues: byStage[stage] }));
}
