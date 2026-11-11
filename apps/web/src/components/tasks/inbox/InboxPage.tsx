import {
  factoryTaskKey,
  type FactoryTaskNeed,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { CountBadge, PageHeader, ProjectChip, SourceChip, TaskEmptyState } from "../kit";
import { TaskNeedsRow } from "../shared";
import { TaskPageFrame } from "../TaskPageFrame";
import { validateInboxSearch, type InboxSearch } from "../taskRoutes";
import { ArrivalDetail } from "./ArrivalDetail";
import { arrivalKey, useInboxData, type ArrivalEntry } from "./inboxData";
import { NeedDetail } from "./NeedDetail";

export const needKey = (need: FactoryTaskNeed) =>
  JSON.stringify([factoryTaskKey(need.ref), need.reason, need.threadId, need.requestId]);

export function InboxPage() {
  const [snoozed, setSnoozed] = useState(false);
  const data = useInboxData(snoozed);
  const search = validateInboxSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const change = (next: InboxSearch) =>
    void navigate({ to: "/inbox", search: next, replace: true });
  const triage = search.tab === "triage";
  const rows = triage ? data.arrivals.map(arrivalKey) : data.needs.rows.map(needKey);
  const selectedIndex = triage
    ? data.arrivals.findIndex(
        (entry) => arrivalKey(entry) === search.selected || entry.arrival.id === search.selected,
      )
    : data.needs.rows.findIndex(
        (need) => needKey(need) === search.selected || need.displayId === search.selected,
      );
  const selected = rows[Math.max(0, selectedIndex)];
  const previous = useRef<{
    rows: string[];
    selected: string | undefined;
    urlSelected: string | undefined;
    tab: InboxSearch["tab"];
  }>({ rows: [], selected: undefined, urlSelected: undefined, tab: search.tab });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the URL on the next ask after a change-stream update removes the selected row
  useEffect(() => {
    const before = previous.current;
    if (
      before.tab === search.tab &&
      before.selected &&
      search.selected === before.urlSelected &&
      before.rows.includes(before.selected) &&
      !rows.includes(before.selected)
    ) {
      const next = rows[Math.min(before.rows.indexOf(before.selected), rows.length - 1)];
      change({ ...(search.tab ? { tab: search.tab } : {}), ...(next ? { selected: next } : {}) });
    }
    previous.current = { rows, selected, urlSelected: search.selected, tab: search.tab };
  }, [rows, selected, search.tab, search.selected, change]);
  const [created, setCreated] = useState<FactoryTaskSummary | null>(null);
  const select = (id: string) => change({ ...(triage ? { tab: "triage" } : {}), selected: id });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if ((event.target as HTMLElement).closest("input,textarea,[role=combobox]")) return;
    if (rows.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, rows.indexOf(selected ?? ""));
    select(
      rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))]!,
    );
  };
  const ready = data.machines.every((machine) => machine.state === "current");
  const empty = triage
    ? data.arrivals.length === 0 && ready
    : data.needs.count === 0 && !data.incomplete && ready;
  const running = new Set(
    data.tasks.flatMap((task) =>
      task.liveRuns
        .filter((run) => run.state === "running" || run.state === "stopping")
        .map((run) => JSON.stringify([task.ref.environmentId, run.taskId])),
    ),
  ).size;
  const project = (entry: ArrivalEntry) =>
    data.scope.projects.find((group) =>
      group.memberProjectRefs.some(
        (ref) =>
          ref.environmentId === entry.environmentId && ref.projectId === entry.arrival.projectId,
      ),
    )?.displayName ?? entry.arrival.projectId;
  const arrival = triage ? data.arrivals.find((entry) => arrivalKey(entry) === selected) : null;
  const need = triage ? null : data.needs.rows.find((entry) => needKey(entry) === selected);
  const on = data.rules.filter((rule) => rule.state === "on").length;
  const trial = data.rules.filter((rule) => rule.state === "trial").length;
  const ruleLine = `${on === 1 ? "One rule is" : `${on} rules are`} on and ${trial === 1 ? "one is" : `${trial} are`} on trial.`;
  return (
    <TaskPageFrame
      header={
        <PageHeader
          title="Inbox"
          view={
            <ToggleGroup
              aria-label="Inbox view"
              value={[triage ? "triage" : "needs"]}
              onValueChange={(value) => {
                const tab = value[0];
                if (tab) change(tab === "triage" ? { tab: "triage" } : {});
              }}
            >
              <Toggle value="needs">
                Needs you <CountBadge count={data.needs.count} tone="attention" />
              </Toggle>
              <Toggle value="triage">
                Triage <CountBadge count={data.waiting} />
              </Toggle>
            </ToggleGroup>
          }
        />
      }
    >
      <div aria-live="polite">
        {triage ? (
          <div className="border-b px-6 py-2">
            <ToggleGroup
              aria-label="Triage arrivals"
              value={[snoozed ? "snoozed" : "new"]}
              onValueChange={(value) => {
                if (value[0]) {
                  setSnoozed(value[0] === "snoozed");
                  change({ tab: "triage" });
                }
              }}
            >
              <Toggle value="new">New arrivals</Toggle>
              <Toggle value="snoozed">Snoozed</Toggle>
            </ToggleGroup>
          </div>
        ) : null}
        {data.machines
          .filter((machine) => machine.state !== "current")
          .map((machine) => (
            <div
              key={machine.environmentId}
              role={machine.state === "loading" ? "status" : "alert"}
              className="flex items-center gap-3 border-b px-6 py-2 text-muted-foreground text-sm"
            >
              <p>
                {machine.label}:{" "}
                {machine.state === "loading"
                  ? "Loading Inbox…"
                  : machine.state === "offline"
                    ? "This machine is offline."
                    : machine.state === "forbidden"
                      ? "Ask the owner of this environment for access."
                      : machine.state === "unsupported"
                        ? "Update this environment's server to use Inbox."
                        : (machine.message ?? "Couldn't load Inbox. Try again.")}
              </p>
              <Button size="xs" variant="outline" onClick={data.reload}>
                Reload
              </Button>
            </div>
          ))}
        {data.incomplete ? (
          <div
            role="status"
            className="flex items-center gap-3 border-b px-6 py-2 text-muted-foreground text-sm"
          >
            <p>More may be waiting on you.</p>
            <Button size="xs" variant="outline" onClick={data.reloadAsks}>
              Reload
            </Button>
          </div>
        ) : null}
        {created ? (
          <p className="px-6 py-2 text-muted-foreground text-xs">
            Created{" "}
            <Link
              to="/tasks/$environmentId/$displayId"
              params={{ environmentId: created.ref.environmentId, displayId: created.displayId }}
              className="underline"
            >
              {created.displayId} {created.title}
            </Link>
          </p>
        ) : null}
      </div>
      {empty ? (
        <div className="flex flex-1 items-center justify-center">
          <TaskEmptyState
            icon="inbox"
            title={
              triage ? (snoozed ? "No snoozed arrivals" : "No new arrivals") : "Nothing needs you"
            }
            body={
              triage
                ? snoozed
                  ? "Snooze an arrival to set it aside until later."
                  : `Sources and rules add items here. ${ruleLine}`
                : `${running} ${running === 1 ? "task is" : "tasks are"} running. You will see them here when they have a question or a result.`
            }
            primary={
              triage
                ? {
                    label: "Open Automations",
                    onClick: () => void navigate({ to: "/automations" }),
                  }
                : { label: "Go to Tasks", onClick: () => void navigate({ to: "/tasks" }) }
            }
          />
        </div>
      ) : (
        <main className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(280px,520px)_minmax(0,1fr)]">
          <nav
            aria-label={triage ? "Arrivals" : "Needs you"}
            onKeyDown={onKeyDown}
            className="min-h-0 overflow-y-auto border-e px-3 py-4"
          >
            {triage ? (
              <>
                {data.arrivals.map((entry) => (
                  <ArrivalRow
                    key={arrivalKey(entry)}
                    entry={entry}
                    project={project(entry)}
                    selected={arrivalKey(entry) === selected}
                    onSelect={() => select(arrivalKey(entry))}
                  />
                ))}
                {data.more.map((owner) => (
                  <div key={owner.environmentId} className="mt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => data.loadMore(owner.environmentId)}
                    >
                      Load more arrivals
                    </Button>
                  </div>
                ))}
              </>
            ) : (
              <>
                <NeedsGroup
                  title="Blocking a run"
                  needs={data.needs.blocking}
                  tasks={data.tasks}
                  selected={selected}
                  select={select}
                />
                <NeedsGroup
                  title="Ready to review"
                  needs={data.needs.review}
                  tasks={data.tasks}
                  selected={selected}
                  select={select}
                />
              </>
            )}
          </nav>
          <section aria-label="Inbox detail" className="min-h-0 min-w-0 overflow-y-auto p-6">
            {arrival ? (
              <ArrivalDetail
                key={arrivalKey(arrival)}
                entry={arrival}
                project={project(arrival)}
                onAccepted={setCreated}
              />
            ) : need ? (
              <NeedDetail key={needKey(need)} need={need} />
            ) : null}
          </section>
        </main>
      )}
    </TaskPageFrame>
  );
}

function NeedsGroup({
  title,
  needs,
  tasks,
  selected,
  select,
}: {
  title: string;
  needs: readonly FactoryTaskNeed[];
  tasks: readonly FactoryTaskSummary[];
  selected: string | undefined;
  select: (key: string) => void;
}) {
  if (!needs.length) return null;
  return (
    <section aria-label={title} className="mb-6">
      <h2 className="mb-2 px-3 text-muted-foreground text-xs">{title}</h2>
      {needs.map((need) => (
        <TaskNeedsRow
          key={needKey(need)}
          need={need}
          task={tasks.find((task) => factoryTaskKey(task.ref) === factoryTaskKey(need.ref)) ?? null}
          layout="stacked"
          selected={selected === needKey(need)}
          onOpen={() => select(needKey(need))}
        />
      ))}
    </section>
  );
}

function ArrivalRow({
  entry,
  project,
  selected,
  onSelect,
}: {
  entry: ArrivalEntry;
  project: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const relative = useRelativeTimeState(entry.arrival.arrivedAt);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={`mb-2 flex w-full min-w-0 flex-col gap-2 rounded-lg px-3 py-3 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? "bg-accent" : ""}`}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <SourceChip
          kind={entry.arrival.sourceKind === "issues" ? "issue" : "feed"}
          label={entry.arrival.label}
        />
        <span className="min-w-0 flex-1 truncate text-sm">{entry.arrival.title}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {relative.status === "relative" ? relative.value : ""}
        </span>
      </span>
      <ProjectChip name={project} />
    </button>
  );
}
