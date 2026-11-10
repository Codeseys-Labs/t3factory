import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type FactoryAgentProfile,
  type FactoryAgentSetup,
  type FactoryTaskAssignee,
  type FactoryTaskSummary,
  type FactoryTaskStatus,
} from "@t3tools/contracts";
import type { FactoryTaskCatalog, FactoryTaskThreadFacts } from "./factoryTaskView.ts";

const at = "2026-11-09T17:00:00.000Z";
const environmentId = EnvironmentId.make("desktop-cp4edjh");
const projectNames = ["t3code-factory", "website", "vigor", "system-one-trader"] as const;
const profileDefinitions = [
  ["implementer", "Implementer", "codex", "Codex", "gpt-6.1-sol", "Sol", ["bug", "feature"]],
  ["architect", "Architect", "claudeAgent", "Claude", "claude-opus", "Opus", ["task"]],
  ["reviewer", "Reviewer", "claudeAgent", "Claude", "claude-sonnet", "Sonnet", []],
  ["scout", "Scout", "codex", "Codex", "gpt-6-luna", "Luna", ["research"]],
  ["writer", "Writer", "antigravity", "Gemini", "gemini-flash", "Flash", ["docs"]],
  ["checker", "Checker", "openCode", "Kimi", "kimi-k3", "K3", []],
] as const;
const profiles: readonly FactoryAgentProfile[] = profileDefinitions.map(
  ([id, name, driver, , model, , handles]) => ({
    id,
    name,
    setup: {
      modelSelection: { instanceId: ProviderInstanceId.make(driver), model },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspace: "worktree",
    },
    handles,
    version: 0,
    createdAt: at,
    updatedAt: at,
  }),
);
const catalog: FactoryTaskCatalog = [...new Set(profileDefinitions.map((entry) => entry[2]))].map(
  (driver) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: profileDefinitions.find((entry) => entry[2] === driver)![3],
    models: profileDefinitions
      .filter((entry) => entry[2] === driver)
      .map((entry) => ({ slug: entry[4], name: entry[5], shortName: entry[5] })),
  }),
);
function assignee(profileId?: string, auto = false): FactoryTaskAssignee {
  const profile = profiles.find((entry) => entry.id === profileId);
  return profile
    ? {
        assignment: auto ? { mode: "auto" } : { mode: "profile", profileId: profile.id },
        key: profile.id,
        resolved: {
          profile: { id: profile.id, name: profile.name },
          setup: profile.setup,
          via: auto ? "profile-type" : "assignment",
        },
      }
    : { assignment: { mode: "unassigned" }, key: "unassigned", resolved: null };
}
const definitions: readonly [
  string,
  string,
  (typeof projectNames)[number],
  FactoryTaskStatus,
  string?,
][] = [
  ["45", "Light theme for the board", "website", "backlog"],
  ["44", "Dark-mode contrast pass", "website", "backlog"],
  ["43", "Server Git tests fail on Windows", "t3code-factory", "backlog"],
  ["42", "Filter the board by assignee", "t3code-factory", "ready", "architect"],
  ["40", "Weekly dependency review", "system-one-trader", "ready", "scout"],
  ["38", "Unified task model", "t3code-factory", "in-progress", "architect"],
  ["38.1", "Contract and migration", "t3code-factory", "done", "architect"],
  ["38.2", "Move the list API to tasks", "t3code-factory", "in-progress", "implementer"],
  ["38.3", "Update the mobile list", "t3code-factory", "ready", "scout"],
  ["38.4", "User guide for Tasks", "t3code-factory", "done", "writer"],
  [
    "41",
    "Thread still shows Working after reconnect",
    "t3code-factory",
    "in-progress",
    "implementer",
  ],
  ["39", "Backtest the momentum signal", "system-one-trader", "in-progress", "checker"],
  ["29", "Benchmark index paths", "vigor", "in-progress", "checker"],
  ["36", "Audio ring demo", "website", "in-review", "architect"],
  ["33", "Prerequisite view docs", "t3code-factory", "in-review", "writer"],
  ["35", "Gate tooling fixes", "t3code-factory", "done", "implementer"],
  ["34", "Rename repository identity", "t3code-factory", "done", "reviewer"],
  ["31", "Scholar page sync", "website", "done", "writer"],
];
const setup = (profile: string): FactoryAgentSetup =>
  profiles.find((entry) => entry.id === profile)!.setup;
const threadId = (id: string) => ThreadId.make(`task-${id}-run`);
const tasks: readonly FactoryTaskSummary[] = definitions.map(
  ([id, title, project, status, profile]) => {
    const hasRun = status === "in-progress" || status === "in-review" || status === "done";
    const live = ["38.2", "41", "39"].includes(id);
    const result = status === "in-review" || status === "done";
    const summary =
      id === "36"
        ? "PR #112 · +184 −20 · 6 files · checks pass"
        : id === "33"
          ? "Document · rev 2"
          : id === "38.1"
            ? "PR #108 is open · +212 −48 · checks pass"
            : id === "35"
              ? "PR #99 merged"
              : id === "34"
                ? "PR #91 merged"
                : "Document · rev 1";
    return {
      ref: {
        environmentId,
        projectId: ProjectId.make(project),
        rootId: `task-${id.split(".")[0]}`,
        taskId: `task-${id}`,
      },
      displayId: `T-${id}`,
      parent: id.includes(".") ? { taskId: "task-38", displayId: "T-38" } : null,
      title,
      type: ["43", "41"].includes(id) ? "bug" : ["38.4", "33"].includes(id) ? "docs" : "task",
      status,
      lane: status === "backlog" ? "backlog" : "ready",
      assignee: assignee(profile, id === "42"),
      source: {
        kind: ["43", "38"].includes(id) ? "issue" : id === "40" ? "schedule" : "local",
        label:
          id === "43"
            ? "GitHub #96"
            : id === "38"
              ? "GitHub #62"
              : id === "40"
                ? "Schedule · Mondays 09:00"
                : "Local",
        url: null,
        key:
          id === "43"
            ? "github:Codeseys-Labs/t3factory:96"
            : id === "38"
              ? "github:Codeseys-Labs/t3factory:62"
              : null,
        workRef: null,
      },
      blockedBy:
        id === "38.3"
          ? [
              {
                taskId: "task-38.2",
                displayId: "T-38.2",
                title: "Move the list API to tasks",
                status: "in-progress",
              },
            ]
          : [],
      progress: id === "38" ? { done: 2, total: 4 } : null,
      run: hasRun
        ? {
            ordinal: id === "29" ? 2 : 1,
            threadId: threadId(id),
            runId: RunId.make(`run-${id}`),
            state: id === "29" ? "failed" : live ? "running" : "completed",
            purpose: id === "38" ? "planning" : "work",
            setup: setup(profile!),
            startedAt: at,
            endedAt: live ? null : at,
            note: id === "29" ? "Tests failed on attempt 2" : null,
          }
        : null,
      liveRuns:
        live || id === "38"
          ? [
              {
                taskId: `task-${id === "38" ? "38.2" : id}`,
                displayId: `T-${id === "38" ? "38.2" : id}`,
                threadId: threadId(id === "38" ? "38.2" : id),
                state: "running",
                startedAt: at,
              },
            ]
          : [],
      attention:
        id === "29"
          ? [
              {
                taskId: "task-29",
                displayId: "T-29",
                reason: "failed",
                detail: "Tests failed on attempt 2",
              },
            ]
          : status === "in-review"
            ? [{ taskId: `task-${id}`, displayId: `T-${id}`, reason: "review", detail: summary }]
            : [],
      result: result
        ? {
            kind: ["36", "38.1", "35", "34"].includes(id) ? "code" : "document",
            revision: id === "33" ? 2 : 1,
            summary,
            state: status === "done" ? "accepted" : "ready",
            acceptedRevision: status === "done" ? 1 : null,
            runOrdinal: 1,
            threadId: threadId(id),
            observedAt: at,
          }
        : null,
      version: 0,
      createdAt: at,
      updatedAt: at,
    };
  },
);
const threadFacts: readonly FactoryTaskThreadFacts[] = [
  {
    threadId: threadId("38.2"),
    waiting: true,
    pill: {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    },
    requests: {
      approvals: [],
      userInputs: [
        {
          requestId: RuntimeRequestId.make("question-paging"),
          createdAt: at,
          responseCapability: "live",
          dismissible: false,
          questions: [
            {
              id: "paging",
              header: "Paging",
              question: "Keep cursor paging or switch to offsets?",
              multiSelect: false,
              options: [
                { label: "Keep cursor paging", description: "Preserve the existing cursor." },
                { label: "Switch to offsets", description: "Use numbered offsets." },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    threadId: threadId("39"),
    waiting: true,
    pill: {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    },
    requests: {
      userInputs: [],
      approvals: [
        {
          requestId: RuntimeRequestId.make("approval-backtest"),
          requestKind: "command",
          createdAt: at,
          responseCapability: "live",
          detail: "python backtest.py --full",
          reason: "Runs about 40 minutes and writes results/ in the project.",
        },
      ],
    },
  },
  {
    threadId: threadId("41"),
    waiting: false,
    pill: {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    },
  },
];

export const FACTORY_TASK_FIXTURES = {
  environmentId,
  environmentName: "DESKTOP-CP4EDJH",
  at,
  projects: projectNames.map((name) => ({ environmentId, id: ProjectId.make(name), name })),
  profiles,
  catalog,
  tasks,
  threadFacts,
};
