import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FactorySignalCandidate,
  FactorySignalFailure,
  FactorySignalFeed,
  FactorySignalFeedView,
  FactoryTaskSummary,
  ProjectId,
} from "@t3tools/contracts";
import { msg, Plural, T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import {
  canFollowMore,
  feedStatus,
  type SignalRow as SignalRowView,
  selectSignalRows,
  signalDecisionWaits,
} from "./signals.logic";
import {
  addSignalFeed,
  admitSignal,
  dismissSignal,
  factorySignalsList,
  factoryTasksLive,
  removeSignalFeed,
  signalDecisionKey,
  signalDecisionLocks,
  useSignalDecisions,
} from "./state";
import { nextAttentionFocus } from "./workDetail.logic";

type SignalsTab = "waiting" | "decided" | "feeds";

const TABS: ReadonlyArray<{ readonly value: SignalsTab; readonly label: string }> = [
  { value: "waiting", label: msg("Waiting") },
  { value: "decided", label: msg("Decided") },
  { value: "feeds", label: msg("Feeds") },
];

const FAILURE_REASONS: Record<FactorySignalFailure, string> = {
  "not-a-url": msg("the address is not a full web address"),
  scheme: msg("the address is not https"),
  credentials: msg("the address holds a user name or password"),
  port: msg("the address uses a port other than 443"),
  hostname: msg("the address names a local host"),
  address: msg("the host resolves to a private, local or reserved address"),
  dns: msg("the host name could not be resolved"),
  network: msg("the connection failed"),
  timeout: msg("the server took longer than 5 seconds"),
  redirect: msg("the server redirected, which Signals does not follow"),
  status: msg("the server answered {status}"),
  "too-large": msg("the feed is larger than 256 KB"),
  encoding: msg("the feed is not plain UTF-8"),
  dtd: msg("the feed declares a DTD or entities"),
  entity: msg("the feed uses an entity XML does not define"),
  malformed: msg("the feed is not well-formed XML"),
  "too-deep": msg("the feed nests elements more than 32 deep"),
  format: msg("the feed is neither RSS 2.0 nor Atom 1.0"),
  store: msg("its record could not be read or saved; remove the feed and follow it again"),
};

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const NO_TASKS: ReadonlyArray<FactoryTaskSummary> = [];
const NO_ROWS: ReadonlyArray<SignalRowView> = [];
const NO_FEEDS: ReadonlyArray<FactorySignalFeedView> = [];
const NO_PROJECT = "";

function formatDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : DATE_FORMAT.format(at);
}

/** A candidate row's key, in the list and on its element. */
const rowKey = (candidate: Pick<FactorySignalCandidate, "feedId" | "id">) =>
  `${candidate.feedId}/${candidate.id}`;

/** The first enabled control of the row keyed `key` in the panel, if it has one. */
function rowControl(panelId: string, key: string): HTMLElement | null {
  return (
    document
      .getElementById(panelId)
      ?.querySelector(`[data-signal-key="${CSS.escape(key)}"]`)
      ?.querySelector<HTMLElement>("button:not(:disabled)") ?? null
  );
}

/**
 * What the feeds an environment follows have found, for a person to admit into Backlog or dismiss,
 * and the feeds themselves. Nothing here starts work.
 */
export function SignalsDialog({
  environmentId,
  projects,
  projectId,
  workflowsOn,
  onClose,
  onOpenTask,
}: {
  readonly environmentId: EnvironmentId;
  /** That environment's projects, archived ones included, to name a feed's project. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The project a new feed starts in, or null for none. */
  readonly projectId: ProjectId | null;
  /** Whether that environment runs workflows, without which no feed is read. */
  readonly workflowsOn: boolean;
  readonly onClose: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const panelId = `${id}-panel`;
  const [tab, setTab] = useState<SignalsTab>("waiting");
  // Decided items are read once that tab is first opened, not with the dialog.
  const [decidedOpened, setDecidedOpened] = useState(false);
  const waiting = useEnvironmentQuery(
    factorySignalsList({ environmentId, input: { view: "pending" } }),
  );
  const decided = useEnvironmentQuery(
    decidedOpened ? factorySignalsList({ environmentId, input: { view: "decided" } }) : null,
  );
  const live = useEnvironmentQuery(factoryTasksLive({ environmentId, input: {} }));
  const canAdmit = useAtomValue(admitSignal.permissionAtom(environmentId));
  const canDismiss = useAtomValue(dismissSignal.permissionAtom(environmentId));
  const canAdd = useAtomValue(addSignalFeed.permissionAtom(environmentId));
  const canRemove = useAtomValue(removeSignalFeed.permissionAtom(environmentId));
  const decisions = useSignalDecisions();
  const locks = useAtomValue(signalDecisionLocks);
  const add = useAtomCommand(addSignalFeed, {
    label: "factory signal feed add",
    reportFailure: false,
  });
  const remove = useAtomCommand(removeSignalFeed, {
    label: "factory signal feed remove",
    reportFailure: false,
  });
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [project, setProject] = useState(projectId);
  const [following, setFollowing] = useState(false);
  // The feed Stop following was last asked for, kept while its confirmation closes.
  const [removing, setRemoving] = useState<FactorySignalFeed | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Set once that feed was removed: the feed focus goes on to, null when none is left.
  const [afterRemoval, setAfterRemoval] = useState<{ readonly next: string | null } | null>(null);
  // The row focus was last in, and the rows shown then, so a row that leaves the list or loses
  // the control focus was on does not drop focus to the page.
  const focusedRow = useRef<string | null>(null);
  const shownRows = useRef<ReadonlyArray<string>>([]);

  const tasks = live.data?.tasks ?? NO_TASKS;
  const waitingList = waiting.data;
  const decidedList = decided.data;
  const shownList = tab === "decided" ? decidedList : waitingList;
  const feeds = waitingList?.feeds ?? NO_FEEDS;
  const rows = tab === "feeds" || shownList === null ? NO_ROWS : selectSignalRows(shownList, tasks);
  const pickable = projects.filter((candidate) => !candidate.archivedAt);
  const picked = pickable.find((candidate) => candidate.id === project) ?? null;
  const full = waitingList === null || !canFollowMore(waitingList);
  const formLocked = following || full;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus on when the row it was in leaves the list or loses the control it was on, so focus never falls to the page
  useEffect(() => {
    const keys =
      tab === "feeds"
        ? feeds.map((view) => view.feed.id)
        : rows.map((row) => rowKey(row.candidate));
    const before = shownRows.current;
    shownRows.current = keys;
    const lost = focusedRow.current;
    const active = document.activeElement;
    if (lost === null || (active !== null && active !== document.body)) return;
    const next = nextAttentionFocus(before, keys, lost);
    // Still listed, its controls waiting on a decision: they come back, or the row leaves.
    const listed = rows.find((row) => rowKey(row.candidate) === next)?.candidate;
    if (
      next === lost &&
      listed !== undefined &&
      signalDecisionWaits(locks.get(signalDecisionKey(environmentId, listed.id)), listed)
    ) {
      return;
    }
    const control = next === null ? null : rowControl(panelId, next);
    (control ?? document.getElementById(`${id}-tab-${tab}`))?.focus();
  }, [feeds, rows, locks, environmentId, tab, id, panelId]);

  const showTab = (next: SignalsTab) => {
    focusedRow.current = null;
    setTab(next);
    if (next === "decided") setDecidedOpened(true);
  };
  const failed = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) =>
    toastManager.add({
      type: "error",
      title,
      description:
        errorDisplayMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
    });
  const admitCandidate = async (candidate: FactorySignalCandidate) => {
    const result = await decisions.admit(environmentId, candidate);
    if (result === null) return;
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Added T-{number} to Backlog", { number: result.value.task.number }),
        description: gt(
          "Its title is the item's title. Write what you want done in it before you start it.",
        ),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) failed(gt("Could not admit this item"), result);
  };
  const dismissCandidate = async (candidate: FactorySignalCandidate) => {
    const result = await decisions.dismiss(environmentId, candidate);
    if (result !== null && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failed(gt("Could not dismiss this item"), result);
    }
  };
  const follow = async () => {
    if (formLocked || !canAdd || address.trim() === "" || name.trim() === "") return;
    setFollowing(true);
    const result = await add({
      environmentId,
      input: { url: address, label: name, projectId: picked?.id ?? null },
    });
    setFollowing(false);
    if (result._tag === "Success") {
      setAddress("");
      setName("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) failed(gt("Could not follow this feed"), result);
  };
  const askRemove = (feed: FactorySignalFeed) => {
    setRemoving(feed);
    setAfterRemoval(null);
    setConfirming(true);
  };
  const stopFollowing = async (feed: FactorySignalFeed) => {
    const keys = feeds.map((view) => view.feed.id);
    setStopping(true);
    const result = await remove({ environmentId, input: { feedId: feed.id } });
    setStopping(false);
    if (result._tag === "Success") {
      setAfterRemoval({
        next: nextAttentionFocus(
          keys,
          keys.filter((key) => key !== feed.id),
          feed.id,
        ),
      });
    }
    setConfirming(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failed(gt("Could not stop following this feed"), result);
    }
  };
  const statusLine = (view: FactorySignalFeedView) => {
    const status = feedStatus(view);
    switch (status.kind) {
      case "unread":
        return gt("Not read yet");
      case "ok":
        return gt("Read {date}", { date: formatDate(status.at) });
      case "failed":
        return gt("Last read failed {date}: {reason}", {
          date: formatDate(status.at),
          reason: m(FAILURE_REASONS[status.failure], { status: status.httpStatus ?? "" }),
        });
    }
  };

  const notices: Array<{ readonly key: string; readonly body: ReactNode }> = [];
  if (!workflowsOn) {
    notices.push({
      key: "workflows",
      body: <T>Workflows are off on this server, so feeds are not read.</T>,
    });
  }
  if (shownList !== null && shownList.damaged > 0) {
    notices.push({
      key: "damaged",
      body: (
        <T>
          <Plural
            n={shownList.damaged}
            one={
              <>
                <Var>{shownList.damaged}</Var> signal record could not be read.
              </>
            }
            other={
              <>
                <Var>{shownList.damaged}</Var> signal records could not be read.
              </>
            }
          />
        </T>
      ),
    });
  }
  if (shownList !== null && shownList.truncated) {
    notices.push({ key: "truncated", body: <T>Showing the newest 200 items.</T> });
  }

  const shownError = tab === "decided" ? decided.error : waiting.error;
  const content =
    tab !== "feeds" ? (
      shownList === null ? (
        shownError === null ? null : (
          <p role="alert" className="text-sm text-muted-foreground">
            {shownError}
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tab === "decided" ? (
            <T>Nothing decided yet.</T>
          ) : shownList.feeds.length > 0 ? (
            <T>Nothing is waiting.</T>
          ) : (
            <T>Follow a feed on the Feeds tab to see its items here.</T>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <SignalRow
              key={rowKey(row.candidate)}
              row={row}
              decided={tab === "decided"}
              busy={signalDecisionWaits(
                locks.get(signalDecisionKey(environmentId, row.candidate.id)),
                row.candidate,
              )}
              canAdmit={canAdmit}
              canDismiss={canDismiss}
              onAdmit={(candidate) => void admitCandidate(candidate)}
              onDismiss={(candidate) => void dismissCandidate(candidate)}
              onOpenTask={onOpenTask}
            />
          ))}
        </ul>
      )
    ) : (
      <div className="flex flex-col gap-4">
        {feeds.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {feeds.map((view) => (
              <li
                key={view.feed.id}
                data-signal-key={view.feed.id}
                className="flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    <bdi>{view.feed.label}</bdi>
                  </span>
                  <Button
                    size="xs"
                    variant="ghost-destructive"
                    disabled={!canRemove}
                    onClick={() => askRemove(view.feed)}
                  >
                    <T>Stop following</T>
                  </Button>
                </div>
                <code className="font-mono text-xs break-all text-muted-foreground">
                  <bdi>{view.feed.url}</bdi>
                </code>
                <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>
                    {projects.find((candidate) => candidate.id === view.feed.projectId)?.title ??
                      gt("No project")}
                  </span>
                  <span className="wrap-anywhere">{statusLine(view)}</span>
                  <span>
                    <T>
                      <Plural
                        n={view.pending}
                        one={
                          <>
                            <Var>{view.pending}</Var> item waiting
                          </>
                        }
                        other={
                          <>
                            <Var>{view.pending}</Var> items waiting
                          </>
                        }
                      />
                    </T>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void follow();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-address`}>
              <T>Feed address</T>
            </Label>
            <Input
              id={`${id}-address`}
              value={address}
              maxLength={2048}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={gt("https://example.com/feed.xml")}
              disabled={formLocked}
              onChange={(event) => setAddress(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-name`}>
              <T>Name</T>
            </Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={100}
              disabled={formLocked}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              <T>Project</T>
            </span>
            <Select
              value={picked?.id ?? NO_PROJECT}
              disabled={formLocked}
              onValueChange={(value) =>
                setProject(pickable.find((candidate) => candidate.id === value)?.id ?? null)
              }
            >
              <SelectTrigger aria-label={gt("Project")}>
                <SelectValue>{picked?.title ?? gt("No project")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={NO_PROJECT}>
                  <T>No project</T>
                </SelectItem>
                {pickable.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>
              Public https addresses on port 443 only. The server reads each feed at most once an
              hour and never opens the links inside.
            </T>
          </p>
          {waitingList !== null && full ? (
            <p role="status" className="text-xs text-muted-foreground">
              <T>This server follows 20 feeds, the most it can.</T>
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={formLocked || !canAdd || address.trim() === "" || name.trim() === ""}
            >
              <T>Follow feed</T>
            </Button>
          </div>
        </form>
      </div>
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle id={`${id}-title`}>
            <T context="opens the items found in followed feeds">Signals</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Items from public feeds this server follows. Nothing here runs by itself. Admit adds a
              Backlog task, not started, with the item's title; the item's text and link stay here.
            </T>
          </DialogDescription>
          <div
            role="tablist"
            aria-labelledby={`${id}-title`}
            className="flex flex-wrap gap-1"
            onKeyDown={(event) => {
              const current = TABS.findIndex((entry) => entry.value === tab);
              const next =
                event.key === "ArrowRight"
                  ? (current + 1) % TABS.length
                  : event.key === "ArrowLeft"
                    ? (current + TABS.length - 1) % TABS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : -1;
              const entry = TABS[next];
              if (entry === undefined) return;
              event.preventDefault();
              showTab(entry.value);
              const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              tabs[next]?.focus();
            }}
          >
            {TABS.map((entry) => (
              <button
                key={entry.value}
                id={`${id}-tab-${entry.value}`}
                type="button"
                role="tab"
                aria-selected={entry.value === tab}
                aria-controls={panelId}
                tabIndex={entry.value === tab ? 0 : -1}
                onClick={() => showTab(entry.value)}
                className="h-7 shrink-0 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent aria-selected:bg-accent aria-selected:text-foreground"
              >
                {m(entry.label)}
              </button>
            ))}
          </div>
        </DialogHeader>
        <DialogPanel>
          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={`${id}-tab-${tab}`}
            className="flex flex-col gap-3"
            onFocus={(event) => {
              const row =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>("[data-signal-key]")
                  : null;
              focusedRow.current = row?.dataset.signalKey ?? null;
            }}
            onBlur={(event) => {
              // Focus moved elsewhere stops steering; focus dropped by a removed row has no target.
              if (
                event.relatedTarget !== null &&
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                focusedRow.current = null;
              }
            }}
          >
            {notices.map((notice) => (
              <p key={notice.key} role="status" className="text-xs text-muted-foreground">
                {notice.body}
              </p>
            ))}
            {content}
          </div>
        </DialogPanel>
        <AlertDialog
          open={confirming}
          onOpenChange={(open) => {
            if (!open && !stopping) setConfirming(false);
          }}
        >
          {removing === null ? null : (
            <AlertDialogPopup
              // A removed feed's row is going: focus goes on to the next feed, else the tab.
              finalFocus={() =>
                afterRemoval === null
                  ? true
                  : ((afterRemoval.next === null ? null : rowControl(panelId, afterRemoval.next)) ??
                    document.getElementById(`${id}-tab-${tab}`) ??
                    true)
              }
            >
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <T>
                    Stop following{" "}
                    <Var>
                      <bdi>{removing.label}</bdi>
                    </Var>
                    ?
                  </T>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <T>Its waiting and decided items leave Signals. Tasks already admitted stay.</T>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={stopping}
                  render={<Button variant="outline" disabled={stopping} />}
                >
                  <T>Cancel</T>
                </AlertDialogClose>
                <Button
                  variant="destructive"
                  disabled={stopping || !canRemove}
                  onClick={() => void stopFollowing(removing)}
                >
                  <T>Stop following</T>
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          )}
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}

/** One candidate: its text and link as plain text, what was decided, and what can be done. */
function SignalRow({
  row,
  decided,
  busy,
  canAdmit,
  canDismiss,
  onAdmit,
  onDismiss,
  onOpenTask,
}: {
  readonly row: SignalRowView;
  /** A row of the Decided tab, which says what was decided. */
  readonly decided: boolean;
  /** A decision on it is under way, or made and not yet read back. */
  readonly busy: boolean;
  readonly canAdmit: boolean;
  readonly canDismiss: boolean;
  readonly onAdmit: (candidate: FactorySignalCandidate) => void;
  readonly onDismiss: (candidate: FactorySignalCandidate) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const gt = useGT();
  const { candidate, taskNumber } = row;
  const taskId = candidate.taskId;
  return (
    <li
      data-signal-key={rowKey(candidate)}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border px-3 py-2"
    >
      <p className="text-sm font-medium wrap-anywhere">
        <bdi>{candidate.title}</bdi>
      </p>
      <p className="text-xs text-muted-foreground wrap-anywhere">
        <T>
          <Var>
            <bdi>{row.feedLabel ?? candidate.feedId}</bdi>
          </Var>{" "}
          · revision <Var>{candidate.revision}</Var>
        </T>
      </p>
      {candidate.summary === "" ? null : (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground wrap-anywhere">
          <bdi>{candidate.summary}</bdi>
        </p>
      )}
      {candidate.link === null ? null : (
        <p className="flex min-w-0 gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">
            <T>Link:</T>
          </span>
          <code className="min-w-0 font-mono break-all">
            <bdi>{candidate.link}</bdi>
          </code>
        </p>
      )}
      {decided ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {candidate.state === "admitted" ? (
            <Badge size="sm" variant="success">
              {taskNumber === null ? (
                <T>Admitted</T>
              ) : (
                gt("Admitted as T-{number}", { number: taskNumber })
              )}
            </Badge>
          ) : candidate.state === "dismissed" ? (
            <Badge size="sm" variant="secondary">
              <T>Dismissed</T>
            </Badge>
          ) : null}
          {row.changedAfterAdmit ? (
            <Badge size="sm" variant="warning">
              <T>Changed after it was admitted</T>
            </Badge>
          ) : null}
        </div>
      ) : null}
      {row.actions.length === 0 ? null : (
        <div className="flex flex-wrap justify-end gap-2">
          {row.actions.map((action) =>
            action === "admit" ? (
              <Button
                key={action}
                size="xs"
                variant="outline"
                disabled={!canAdmit || busy}
                onClick={() => onAdmit(candidate)}
              >
                <T>Admit</T>
              </Button>
            ) : action === "dismiss" ? (
              <Button
                key={action}
                size="xs"
                variant="ghost"
                disabled={!canDismiss || busy}
                onClick={() => onDismiss(candidate)}
              >
                <T>Dismiss</T>
              </Button>
            ) : taskId === null || taskNumber === null ? null : (
              <Button key={action} size="xs" variant="outline" onClick={() => onOpenTask(taskId)}>
                {gt("Open T-{number}", { number: taskNumber })}
              </Button>
            ),
          )}
        </div>
      )}
    </li>
  );
}
