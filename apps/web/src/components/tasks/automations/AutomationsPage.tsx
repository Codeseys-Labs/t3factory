import type { FactoryTaskCatalog } from "@t3tools/client-runtime/state/factory-task-view";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  type FactoryAgentProfile,
  type FactoryIntakeRule,
  type FactoryIntakeSource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { ArrowRightIcon, CalendarClockIcon, CircleDotIcon, PlusIcon, RssIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { m } from "../../../i18n/messages";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { randomUUID } from "../../../lib/utils";
import { useProjects } from "../../../state/entities";
import { usePrimaryEnvironmentId, useEnvironments } from "../../../state/environments";
import {
  useFactoryFeedsSupported,
  useFactoryKnowledgeSupported,
  useFactoryResearchSupported,
} from "../../../state/factory";
import {
  factoryIntake,
  useFactoryAgentProfiles,
  useFactoryIntakeRules,
  useFactoryIntakeSources,
  useFactoryTaskCommand,
} from "../../../state/factoryTasks";
import { useEnvironmentsWithScope } from "../../../state/session";
import { runtimeModeConfig } from "../../chat/runtimeModeConfig";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { Monogram, PageHeader, SectionHeader } from "../kit";
import { useTaskCatalog } from "../shared/taskCatalog";
import { TaskPageFrame } from "../TaskPageFrame";
import type { AutomationsSearch } from "../taskRoutes";
import { assignmentName, setupLabel } from "./assignee";
import {
  AUTONOMY,
  EVERY_START_NEEDS_A_PERSON,
  handlesText,
  readRefusal,
  refusalText,
  sourceDetail,
  sourceStatusText,
} from "./automationText";
import { ProfileSheet, ProfileTasksLink } from "./ProfileSheet";
import { RuleEditor } from "./RuleEditor";
import { MissingSheet } from "./sheetParts";
import { SourceSheet } from "./SourceSheet";

// The machine choice outlives a reload, like the app's other view choices.
const MACHINE_STORAGE_KEY = "t3code:automations:machine";
const StoredMachine = Schema.NullOr(EnvironmentId);

/** E1. Sources, rules and agent profiles of one machine, with their sheets opened from the URL. */
export function AutomationsPage() {
  const { environments, isReady } = useEnvironments();
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const [chosen, setChosen] = useLocalStorage(MACHINE_STORAGE_KEY, null, StoredMachine);
  const navigate = useNavigate();
  const environment =
    environments.find((candidate) => candidate.environmentId === chosen) ??
    environments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    environments[0];
  const available =
    environment !== undefined &&
    environment.connection.phase === "connected" &&
    environment.serverConfig !== null &&
    readable.has(environment.environmentId);
  const open = (search: AutomationsSearch) => void navigate({ to: "/automations", search });

  return (
    <TaskPageFrame
      header={
        <PageHeader
          title={gt("Automations", { $context: "page title" })}
          view={
            environments.length > 1 && environment ? (
              <Select
                value={environment.environmentId}
                onValueChange={(value) => {
                  if (value !== null) setChosen(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={gt("Machine", { $context: "the machine picker" })}
                >
                  <SelectValue>{environment.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((candidate) => (
                    <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : environment ? (
              <span className="text-muted-foreground text-sm">{environment.label}</span>
            ) : null
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={!available}
              onClick={() => open({ sheet: "rule" })}
            >
              <PlusIcon aria-hidden />
              <T>New rule</T>
            </Button>
          }
        />
      }
    >
      {!isReady ? (
        <PageState role="status">
          <T>Loading machines…</T>
        </PageState>
      ) : !environment ? (
        <PageState>
          <T>Connect a machine to set up automations.</T>
        </PageState>
      ) : environment.connection.phase === "unsupported" ? (
        <PageState>
          {gt("Update {product} on {machine} to use Automations.", {
            product: "T3 Code",
            machine: environment.label,
          })}
        </PageState>
      ) : environment.connection.phase !== "connected" ? (
        <PageState role="status">
          {gt("{machine} is offline. Its automations show when it reconnects.", {
            machine: environment.label,
          })}
        </PageState>
      ) : !environment.serverConfig ? (
        <PageState role="status">
          {gt("Loading {machine}…", { machine: environment.label })}
        </PageState>
      ) : !readable.has(environment.environmentId) ? (
        <PageState role="alert">
          {gt("You don't have access to Automations on {machine}.", {
            machine: environment.label,
          })}
        </PageState>
      ) : (
        <AutomationLists
          key={environment.environmentId}
          environmentId={environment.environmentId}
          open={open}
        />
      )}
    </TaskPageFrame>
  );
}

function PageState({ role, children }: { role?: "status" | "alert"; children: ReactNode }) {
  return (
    <p role={role} className="p-6 text-muted-foreground text-sm">
      {children}
    </p>
  );
}

type ListState<T> =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "failed" }
  | { kind: "ready"; value: T };

function listState<A, T>(
  result: AsyncResult.AsyncResult<A, unknown>,
  pick: (value: A) => T,
): ListState<T> {
  if (result._tag === "Failure")
    return readRefusal(result).reason === "forbidden" ? { kind: "forbidden" } : { kind: "failed" };
  if (result._tag === "Success") return { kind: "ready", value: pick(result.value) };
  return { kind: "loading" };
}

function AutomationLists({
  environmentId,
  open,
}: {
  environmentId: EnvironmentId;
  open: (search: AutomationsSearch) => void;
}) {
  const sources = listState(useFactoryIntakeSources(environmentId), (value) => value.sources);
  const rules = listState(useFactoryIntakeRules(environmentId), (value) => value.rules);
  const profiles = listState(useFactoryAgentProfiles(environmentId), (value) => value.profiles);
  const catalog = useTaskCatalog(environmentId);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const search = useSearch({ from: "/_chat/automations" });
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const feedsSupported = useFactoryFeedsSupported();
  const researchSupported = useFactoryResearchSupported();
  const knowledgeSupported = useFactoryKnowledgeSupported();
  const close = () => void navigate({ to: "/automations", search: {}, replace: true });
  const profileList =
    profiles.kind === "ready" ? profiles.value.map(({ profile }) => profile) : null;
  const factorySearch = { state: "open", view: "list", machine: environmentId } as const;

  return (
    <main className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
      <section
        aria-label={gt("Sources", { $context: "the machine's sources" })}
        className="space-y-2"
      >
        <SectionHeader
          title={gt("Sources", { $context: "the machine's sources" })}
          {...(sources.kind === "ready"
            ? { meta: gt("{count} connected", { count: sources.value.length }) }
            : {})}
          action={{ label: gt("Add source"), onClick: () => open({ sheet: "source" }) }}
        />
        <ListBody
          state={sources}
          thing="sources"
          empty={gt("Add a source to bring in issues, feed entries or a task on a schedule.")}
        >
          {(list) =>
            list.map((source) => (
              <SourceRow
                key={source.id}
                environmentId={environmentId}
                source={source}
                onOpen={() => open({ sheet: "source", id: source.id })}
              />
            ))
          }
        </ListBody>
      </section>
      <section aria-label={gt("Rules", { $context: "the machine's rules" })} className="space-y-2">
        <SectionHeader title={gt("Rules", { $context: "the machine's rules" })} />
        <ListBody
          state={rules}
          thing="rules"
          empty={gt("Add a rule to decide which items become tasks and who gets them.")}
        >
          {(list) =>
            list.map((rule) => (
              <RuleRow
                key={rule.id}
                environmentId={environmentId}
                rule={rule}
                then={assignmentName(rule.action.assignment, profileList ?? [], catalog, messages)}
                onOpen={() => open({ sheet: "rule", id: rule.id })}
              />
            ))
          }
        </ListBody>
      </section>
      <section
        aria-label={gt("Agent profiles", { $context: "the machine's agent profiles" })}
        className="space-y-2"
      >
        <SectionHeader
          title={gt("Agent profiles", { $context: "the machine's agent profiles" })}
          action={{ label: gt("New profile"), onClick: () => open({ sheet: "profile" }) }}
        />
        <ListBody
          state={profiles}
          thing="agent profiles"
          empty={gt("Name a harness and model so tasks and rules can pick them by name.")}
        >
          {(list) => (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map(({ profile, tasksThisWeek }) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  tasksThisWeek={tasksThisWeek}
                  catalog={catalog}
                  onOpen={() => open({ sheet: "profile", id: profile.id })}
                />
              ))}
            </div>
          )}
        </ListBody>
      </section>
      <nav
        aria-label={gt("More automation pages")}
        className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-4 text-muted-foreground text-xs"
      >
        <Link to="/factory/issues" search={factorySearch} className="hover:text-foreground">
          <T>Issues</T>
        </Link>
        {feedsSupported ? (
          <Link to="/factory/sources" search={factorySearch} className="hover:text-foreground">
            <T>Feed sources</T>
          </Link>
        ) : null}
        {knowledgeSupported ? (
          <Link to="/factory/briefs" search={factorySearch} className="hover:text-foreground">
            <T>Briefs</T>
          </Link>
        ) : null}
        {researchSupported ? (
          <Link to="/factory/research" search={factorySearch} className="hover:text-foreground">
            <T>Research</T>
          </Link>
        ) : null}
        <Link to="/factory/workflows" search={factorySearch} className="hover:text-foreground">
          <T>Scheduled workflows</T>
        </Link>
        <Link to="/factory/orchestrator" search={factorySearch} className="hover:text-foreground">
          <T>Orchestrator</T>
        </Link>
      </nav>
      {search.sheet !== undefined &&
      sources.kind === "ready" &&
      rules.kind === "ready" &&
      profiles.kind === "ready" &&
      profileList ? (
        <OpenSheet
          search={search}
          environmentId={environmentId}
          sources={sources.value}
          rules={rules.value}
          profiles={profiles.value}
          profileList={profileList}
          projects={projects}
          catalog={catalog}
          close={close}
        />
      ) : null}
    </main>
  );
}

function OpenSheet({
  search,
  environmentId,
  sources,
  rules,
  profiles,
  profileList,
  projects,
  catalog,
  close,
}: {
  search: AutomationsSearch;
  environmentId: EnvironmentId;
  sources: readonly FactoryIntakeSource[];
  rules: readonly FactoryIntakeRule[];
  profiles: readonly { profile: FactoryAgentProfile; tasksThisWeek: number }[];
  profileList: readonly FactoryAgentProfile[];
  projects: Parameters<typeof SourceSheet>[0]["projects"];
  catalog: FactoryTaskCatalog;
  close: () => void;
}) {
  const key = search.id ?? "new";
  const gt = useGT();
  if (search.sheet === "rule") {
    const rule = rules.find((candidate) => candidate.id === search.id);
    return search.id && !rule ? (
      <MissingSheet
        title={gt("Rule", { $context: "noun, a rule that is missing" })}
        onClose={close}
      />
    ) : (
      <RuleEditor
        key={key}
        environmentId={environmentId}
        rule={rule}
        sources={sources}
        profiles={profileList}
        catalog={catalog}
        close={close}
      />
    );
  }
  if (search.sheet === "source") {
    const source = sources.find((candidate) => candidate.id === search.id);
    return search.id && !source ? (
      <MissingSheet
        title={gt("Source", { $context: "noun, a source that is missing" })}
        onClose={close}
      />
    ) : (
      <SourceSheet
        key={key}
        environmentId={environmentId}
        source={source}
        projects={projects}
        rules={rules}
        profiles={profileList}
        catalog={catalog}
        close={close}
      />
    );
  }
  const entry = profiles.find(({ profile }) => profile.id === search.id);
  return search.id && !entry ? (
    <MissingSheet title={gt("Agent profile")} onClose={close} />
  ) : (
    <ProfileSheet
      key={key}
      environmentId={environmentId}
      profile={entry?.profile}
      tasksThisWeek={entry?.tasksThisWeek ?? 0}
      rules={rules}
      sources={sources}
      close={close}
    />
  );
}

function ListBody<T extends readonly unknown[]>({
  state,
  thing,
  empty,
  children,
}: {
  state: ListState<T>;
  thing: string;
  empty: string;
  children: (list: T) => ReactNode;
}) {
  const gt = useGT();
  if (state.kind === "loading")
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {gt("Loading {thing}…", { thing })}
      </p>
    );
  if (state.kind === "forbidden")
    return (
      <p role="alert" className="text-muted-foreground text-sm">
        {gt("You don't have access to {thing} on this machine.", { thing })}
      </p>
    );
  if (state.kind === "failed")
    return (
      <p role="alert" className="text-destructive-foreground text-sm">
        {gt("Couldn't load {thing}. Check the machine's connection and reload.", { thing })}
      </p>
    );
  if (state.value.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return <div className="space-y-2">{children(state.value)}</div>;
}

const SOURCE_ICONS = {
  issues: CircleDotIcon,
  feed: RssIcon,
  schedule: CalendarClockIcon,
} as const;

function SourceRow({
  environmentId,
  source,
  onOpen,
}: {
  environmentId: EnvironmentId;
  source: FactoryIntakeSource;
  onOpen: () => void;
}) {
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const [pending, setPending] = useState(false);
  const messages = useMessages();
  const toggle = useFactoryTaskCommand(
    factoryIntake.saveIntakeSource,
    {
      environmentId,
      input: {
        commandId,
        id: source.id,
        expectedVersion: source.version,
        projectId: source.projectId,
        config: source.config,
        enabled: !source.enabled,
      },
    },
    { reportFailure: false },
  );
  const Icon = SOURCE_ICONS[source.config.kind];
  const status = sourceStatusText(source, messages);
  return (
    <div className="flex h-11.5 items-center gap-3 rounded-lg border bg-card pe-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg ps-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{source.label}</span>
          <span className="block truncate text-muted-foreground text-xs">
            {sourceDetail(source, messages)}
            {status ? <span className="text-warning"> · {status}</span> : null}
          </span>
        </span>
      </button>
      <Switch
        size="sm"
        aria-label={source.label}
        checked={source.enabled}
        disabled={!toggle.permission || pending}
        onCheckedChange={() => {
          setPending(true);
          void toggle.run().then((result) => {
            setCommandId(CommandId.make(randomUUID()));
            setPending(false);
            if (result._tag === "Failure")
              toastManager.add({
                type: "error",
                title: refusalText(readRefusal(result).reason, "source", m),
              });
          });
        }}
      />
    </div>
  );
}

function RuleRow({
  environmentId,
  rule,
  then,
  onOpen,
}: {
  environmentId: EnvironmentId;
  rule: FactoryIntakeRule;
  then: string;
  onOpen: () => void;
}) {
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const [pending, setPending] = useState(false);
  const gt = useGT();
  const messages = useMessages();
  const autoStart = rule.autonomy === "auto-start";
  const toggle = useFactoryTaskCommand(
    factoryIntake.saveIntakeRule,
    {
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
    },
    { reportFailure: false },
  );
  return (
    <div className="flex h-11.5 items-center gap-3 rounded-lg border bg-card pe-3">
      <button
        type="button"
        onClick={onOpen}
        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_9rem_minmax(0,1.4fr)] items-center gap-4 self-stretch rounded-lg ps-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {gt("When", { $context: "when the rule matches" })}
          </span>
          <span className="min-w-0 flex-1 truncate">{rule.name}</span>
          <ArrowRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </span>
        <span className="flex min-w-0 items-center gap-3">
          <span className="text-muted-foreground text-xs">
            {gt("Then", { $context: "what the rule does on a match" })}
          </span>
          <span className="truncate">{then}</span>
        </span>
        <span className="text-muted-foreground">{messages(AUTONOMY[rule.autonomy].label)}</span>
        <span className="flex min-w-0 items-center gap-3">
          <FiredText rule={rule} />
          {autoStart ? (
            <span className="ms-auto shrink-0 text-muted-foreground text-xs">
              {messages(EVERY_START_NEEDS_A_PERSON)}
            </span>
          ) : null}
        </span>
      </button>
      <Switch
        size="sm"
        aria-label={rule.name}
        checked={rule.state !== "off"}
        disabled={!toggle.permission || pending || autoStart}
        onCheckedChange={() => {
          setPending(true);
          void toggle.run().then((result) => {
            setCommandId(CommandId.make(randomUUID()));
            setPending(false);
            if (result._tag === "Failure")
              toastManager.add({
                type: "error",
                title: refusalText(readRefusal(result).reason, "rule", m),
              });
          });
        }}
      />
    </div>
  );
}

function FiredText({ rule }: { rule: FactoryIntakeRule }) {
  const relative = useRelativeTimeState(rule.lastFiredAt);
  const trial = rule.state === "trial";
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
      {trial ? (
        <Badge variant="muted" size="sm">
          <T>Try once</T>
        </Badge>
      ) : null}
      {relative.status === "relative" ? (
        <span className="truncate">
          <T>
            Fired{" "}
            <Var>{relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value}</Var>
          </T>
        </span>
      ) : trial ? (
        <span className="truncate text-warning">
          <T>Waiting for its first match</T>
        </span>
      ) : (
        <span className="truncate">
          <T>Never fired</T>
        </span>
      )}
    </span>
  );
}

function ProfileCard({
  profile,
  tasksThisWeek,
  catalog,
  onOpen,
}: {
  profile: FactoryAgentProfile;
  tasksThisWeek: number;
  catalog: FactoryTaskCatalog;
  onOpen: () => void;
}) {
  const messages = useMessages();
  const presentation = setupLabel(profile.setup, catalog, messages);
  const used = handlesText(profile.handles, messages);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex items-center gap-3">
          <Monogram text={presentation.monogram} size="md" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-sm">{profile.name}</span>
            <span className="block truncate text-muted-foreground text-xs">
              {presentation.label}
            </span>
          </span>
        </span>
        <span className="text-muted-foreground text-sm">
          {messages(runtimeModeConfig[profile.setup.runtimeMode].label)}
          {used ? ` · ${used}` : ""}
        </span>
      </button>
      <ProfileTasksLink profileId={profile.id} count={tasksThisWeek} />
    </div>
  );
}
