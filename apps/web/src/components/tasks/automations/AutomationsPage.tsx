import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { presentFactoryTaskAssignee } from "@t3tools/client-runtime/state/factory-task-view";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryIntakeRule,
  type FactoryIntakeSource,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { CalendarClockIcon, GitBranchIcon, RssIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../../lib/utils";
import { useEnvironments } from "../../../state/environments";
import {
  factoryIntake,
  useFactoryAgentProfiles,
  useFactoryIntakeRules,
  useFactoryIntakeSources,
  useFactoryTaskCommand,
} from "../../../state/factoryTasks";
import { useEnvironmentsWithScope } from "../../../state/session";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Monogram, PageHeader, SectionHeader } from "../kit";
import { useTaskCatalog } from "../shared/taskCatalog";
import { TaskPageFrame } from "../TaskPageFrame";
import { RuleEditor } from "./RuleEditor";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function sourceDetail(source: FactoryIntakeSource) {
  if (source.config.kind !== "schedule") return source.detail;
  const { schedule } = source.config;
  const days =
    schedule.weekdays.length === 0
      ? "Every day"
      : schedule.weekdays.map((day) => `${weekdays[day]}s`).join(", ");
  return `${days} ${schedule.timeOfDay}`;
}
function firedText(rule: FactoryIntakeRule) {
  if (!rule.lastFiredAt)
    return rule.state === "trial" ? "Waiting for its first match" : "Never fired";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(rule.lastFiredAt)) / 60000));
  if (minutes < 60) return `Fired ${minutes}m ago`;
  if (minutes < 1440) return `Fired ${Math.floor(minutes / 60)}h ago`;
  return `Fired ${Math.floor(minutes / 1440)}d ago`;
}

export function AutomationsPage() {
  const { environments, isReady } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((item) => item.environmentId === selected) ?? environments[0];
  return (
    <TaskPageFrame
      header={
        <PageHeader
          title="Automations"
          view={
            environments.length > 1 && environment ? (
              <Select
                value={environment.environmentId}
                onValueChange={(value) => {
                  if (value) setSelected(value as EnvironmentId);
                }}
              >
                <SelectTrigger aria-label="Machine">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((item) => (
                    <SelectItem key={item.environmentId} value={item.environmentId}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              environment?.label
            )
          }
        />
      }
    >
      {!isReady ? (
        <p className="p-6" role="status">
          Loading machines…
        </p>
      ) : !environment ? (
        <p className="p-6">No machines connected.</p>
      ) : environment.connection.phase !== "connected" ? (
        <p className="p-6" role="status">
          {environment.label} is offline.
        </p>
      ) : !environment.serverConfig ? (
        <p className="p-6" role="status">
          Loading machine…
        </p>
      ) : !readable.has(environment.environmentId) ? (
        <p className="p-6" role="alert">
          You don't have access to Automations on this machine.
        </p>
      ) : (
        <AutomationLists
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      )}
    </TaskPageFrame>
  );
}

function AutomationLists({ environmentId }: { environmentId: EnvironmentId }) {
  const sourcesResult = useFactoryIntakeSources(environmentId);
  const rulesResult = useFactoryIntakeRules(environmentId);
  const profilesResult = useFactoryAgentProfiles(environmentId);
  const catalog = useTaskCatalog(environmentId);
  const search = useSearch({ from: "/_chat/automations" });
  const navigate = useNavigate();
  const openRule = (id?: string) => {
    void navigate({ to: "/automations", search: { sheet: "rule", ...(id ? { id } : {}) } });
  };
  const close = () => {
    void navigate({ to: "/automations", search: {} });
  };
  if (
    sourcesResult._tag === "Failure" ||
    rulesResult._tag === "Failure" ||
    profilesResult._tag === "Failure"
  )
    return (
      <p className="p-6" role="alert">
        Couldn't load automations. Check the machine connection and try again.
      </p>
    );
  const sources = AsyncResult.getOrElse(sourcesResult, () => null)?.sources;
  const rules = AsyncResult.getOrElse(rulesResult, () => null)?.rules;
  const profiles = AsyncResult.getOrElse(profilesResult, () => null)?.profiles;
  if (!sources || !rules || !profiles)
    return (
      <p className="p-6" role="status">
        Loading automations…
      </p>
    );
  return (
    <main className="min-h-0 flex-1 space-y-5 overflow-auto p-6">
      <section className="space-y-2">
        <SectionHeader title="Sources" meta={`${sources.length} connected`} />
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sources connected.</p>
        ) : (
          sources.map((source) => (
            <SourceRow key={source.id} source={source} environmentId={environmentId} />
          ))
        )}
      </section>
      <section className="space-y-2">
        <SectionHeader title="Rules" action={{ label: "New rule", onClick: () => openRule() }} />
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rules yet.</p>
        ) : (
          rules.map((rule) => (
            <RuleRow
              key={rule.id}
              open={() => openRule(rule.id)}
              rule={rule}
              environmentId={environmentId}
              assignee={
                rule.action.assignment.mode === "profile"
                  ? (profiles.find(
                      ({ profile }) =>
                        profile.id ===
                        (rule.action.assignment.mode === "profile"
                          ? rule.action.assignment.profileId
                          : ""),
                    )?.profile.name ?? "Unassigned")
                  : rule.action.assignment.mode === "auto"
                    ? "Auto"
                    : "Unassigned"
              }
            />
          ))
        )}
      </section>
      <section className="space-y-2">
        <SectionHeader title="Agent profiles" />
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent profiles yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {profiles.map(({ profile, tasksThisWeek }) => {
              const presentation = presentFactoryTaskAssignee(
                {
                  assignment: { mode: "pinned", setup: profile.setup },
                  key: profile.id,
                  resolved: null,
                },
                catalog,
              );
              return (
                <div key={profile.id} className="space-y-3 rounded-lg border bg-card p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Monogram text={presentation.monogram} size="md" />
                    <div>
                      <div className="font-medium">{profile.name}</div>
                      <div className="text-xs text-muted-foreground">{presentation.label}</div>
                    </div>
                  </div>
                  <p className="text-muted-foreground">
                    {profile.setup.runtimeMode === "approval-required"
                      ? "Supervised"
                      : "Full access"}{" "}
                    ·{" "}
                    {profile.handles.length
                      ? `used for ${profile.handles.join(", ")}`
                      : "no task types selected"}
                  </p>
                  <p className="text-xs">
                    {tasksThisWeek} {tasksThisWeek === 1 ? "task" : "tasks"} this week
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <nav
        aria-label="More automation pages"
        className="flex flex-wrap gap-3 border-t pt-4 text-sm text-muted-foreground"
      >
        <Link to="/factory/issues" search={{ state: "all", view: "list" }}>
          Issues
        </Link>
        <Link to="/factory/sources" search={{ state: "all", view: "list" }}>
          Feed sources
        </Link>
        <Link to="/factory/briefs" search={{ state: "all", view: "list" }}>
          Briefs
        </Link>
        <Link to="/factory/research" search={{ state: "all", view: "list" }}>
          Research
        </Link>
        <Link to="/factory/workflows" search={{ state: "all", view: "list" }}>
          Scheduled workflows
        </Link>
        <Link to="/factory/orchestrator" search={{ state: "all", view: "list" }}>
          Orchestrator
        </Link>
      </nav>
      {search.sheet === "rule" && (!search.id || rules.some((rule) => rule.id === search.id)) ? (
        <RuleEditor
          key={search.id ?? "new"}
          environmentId={environmentId}
          rule={rules.find((rule) => rule.id === search.id)}
          sources={sources}
          profiles={profiles.map(({ profile }) => profile)}
          close={close}
        />
      ) : null}
    </main>
  );
}
function SourceRow({
  environmentId,
  source,
}: {
  environmentId: EnvironmentId;
  source: FactoryIntakeSource;
}) {
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const [pending, setPending] = useState(false);
  const command = useFactoryTaskCommand(factoryIntake.saveIntakeSource, {
    environmentId,
    input: {
      commandId,
      id: source.id,
      expectedVersion: source.version,
      projectId: source.projectId,
      config: source.config,
      enabled: !source.enabled,
    },
  });
  const Icon =
    source.config.kind === "schedule"
      ? CalendarClockIcon
      : source.config.kind === "feed"
        ? RssIcon
        : GitBranchIcon;
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <Icon className="size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-sm">
        <div>{source.label}</div>
        <div className="text-xs text-muted-foreground">
          {sourceDetail(source)}
          {source.status !== "ok" ? ` · ${source.status}` : ""}
        </div>
      </div>
      <Switch
        size="sm"
        aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.label}`}
        checked={source.enabled}
        disabled={!command.permission || pending}
        onCheckedChange={() => {
          setPending(true);
          void command.run().then(() => {
            setCommandId(CommandId.make(randomUUID()));
            setPending(false);
          });
        }}
      />
    </div>
  );
}
function RuleRow({
  environmentId,
  rule,
  assignee,
  open,
}: {
  environmentId: EnvironmentId;
  rule: FactoryIntakeRule;
  assignee: string;
  open: () => void;
}) {
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const [pending, setPending] = useState(false);
  const command = useFactoryTaskCommand(factoryIntake.saveIntakeRule, {
    environmentId,
    input: {
      commandId,
      id: rule.id,
      expectedVersion: rule.version,
      name: rule.name,
      match: rule.match,
      action: rule.action,
      autonomy: rule.autonomy,
      state: rule.state === "off" ? ("on" as const) : ("off" as const),
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-3 py-3 text-sm">
      <span className="min-w-40 flex-1">
        <span className="text-muted-foreground">When</span>{" "}
        <Button variant="link" size="xs" onClick={open}>
          {rule.name}
        </Button>
      </span>
      <span className="min-w-32 flex-1">
        <span className="text-muted-foreground">Then</span> {assignee}
      </span>
      <span className="min-w-24 text-muted-foreground">
        {rule.autonomy === "auto-start"
          ? "Auto-start"
          : rule.autonomy === "suggest"
            ? "Suggest"
            : "Manual"}
      </span>
      <span className="min-w-40 flex-1 text-xs text-muted-foreground">
        {rule.state === "trial" ? "Try once · " : ""}
        {firedText(rule)}
      </span>
      <Switch
        size="sm"
        aria-label={`${rule.state === "off" ? "Enable" : "Disable"} ${rule.name}`}
        checked={rule.state !== "off"}
        disabled={!command.permission || pending || rule.autonomy === "auto-start"}
        onCheckedChange={() => {
          setPending(true);
          void command.run().then(() => {
            setCommandId(CommandId.make(randomUUID()));
            setPending(false);
          });
        }}
      />
      {rule.autonomy === "auto-start" ? (
        <span className="text-xs text-muted-foreground">Every start needs a person.</span>
      ) : null}
    </div>
  );
}
