import { factoryWorkKey } from "@t3tools/client-runtime/state/factory-work";
import type {
  EnvironmentId,
  FactoryWorkKind,
  FactoryWorkRef,
  FactoryWorkSummary,
} from "@t3tools/contracts";
import type { KeyboardEvent } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  FACTORY_WORK_ORIGIN_LABELS,
  groupFactoryWorkForBoard,
  moveFactoryWorkFocus,
  type FactoryWorkBoardGrouping,
  type FactoryWorkEntry,
} from "./factoryWork.views";

interface FactoryWorkCollectionProps {
  readonly entries: readonly FactoryWorkEntry[];
  readonly conflicts: ReadonlySet<string>;
  readonly selectedKey: string | null;
  readonly ownerLabel: (environmentId: EnvironmentId) => string;
  readonly projectLabel: (item: FactoryWorkSummary) => string;
  readonly onSelect: (reference: FactoryWorkRef) => void;
}

export function FactoryWorkItemConditions(props: {
  readonly entry: FactoryWorkEntry;
  readonly conflicts: ReadonlySet<string>;
}) {
  const { item, stale } = props.entry;
  const conflict =
    item.originConflict || (item.sourceKey !== null && props.conflicts.has(item.sourceKey));
  if (!stale && item.sourceState === null && item.supersededBy === null && !conflict) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {stale ? <Badge variant="outline">Stale, actions disabled</Badge> : null}
      {item.sourceState !== null ? (
        <Badge variant="secondary">Source snapshot: {item.sourceState}</Badge>
      ) : null}
      {item.supersededBy !== null ? <Badge variant="outline">Superseded brief</Badge> : null}
      {conflict ? (
        <Badge variant="warning">Comparable source conflict, owners remain separate</Badge>
      ) : null}
    </div>
  );
}

/** Arrow keys move between enabled items; columns are `[data-work-column]`, items `[data-work-item]`. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-work-item]")) return;
  const columns = [...event.currentTarget.querySelectorAll("[data-work-column]")].map((column) => [
    ...column.querySelectorAll<HTMLElement>("[data-work-item]:not(:disabled)"),
  ]);
  const column = columns.findIndex((items) => items.includes(event.target as HTMLElement));
  if (column === -1) return;
  const row = columns[column]?.indexOf(event.target) ?? -1;
  const next = moveFactoryWorkFocus(
    columns.map((items) => items.length),
    { column, row },
    event.key,
  );
  if (next === null) return;
  event.preventDefault();
  columns[next.column]?.[next.row]?.focus();
}

function SelectWorkButton(props: {
  readonly entry: FactoryWorkEntry;
  readonly selected: boolean;
  readonly onSelect: (reference: FactoryWorkRef) => void;
}) {
  return (
    <Button
      size="sm-multiline"
      variant="ghost"
      className="w-full justify-start"
      data-work-item
      disabled={props.entry.stale}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(props.entry.item.ref)}
    >
      <span className="min-w-0 text-left break-words">{props.entry.item.title}</span>
    </Button>
  );
}

export function FactoryWorkTable(props: FactoryWorkCollectionProps) {
  return (
    <div
      className="max-w-full overflow-x-auto rounded-lg border border-border/60 focus-visible:outline-2 focus-visible:outline-ring"
      role="region"
      aria-label="Work table, loaded pages only"
      tabIndex={0}
      onKeyDown={moveFocus}
    >
      <Table className="min-w-4xl">
        <caption className="sr-only">
          Work on loaded owner pages. Use the arrow keys to move between items.
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Work</TableHead>
            <TableHead scope="col">Origin</TableHead>
            <TableHead scope="col">Owner</TableHead>
            <TableHead scope="col">Admission project</TableHead>
            <TableHead scope="col">Source snapshot</TableHead>
            <TableHead scope="col">Revision</TableHead>
            <TableHead scope="col">Planning stage</TableHead>
            <TableHead scope="col">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody data-work-column>
          {props.entries.map((entry) => {
            const key = factoryWorkKey(entry.item.ref);
            const selected = key === props.selectedKey;
            return (
              <TableRow key={key} data-state={selected ? "selected" : undefined}>
                <TableCell className="w-80 max-w-80 align-top">
                  <SelectWorkButton entry={entry} selected={selected} onSelect={props.onSelect} />
                  <FactoryWorkItemConditions entry={entry} conflicts={props.conflicts} />
                </TableCell>
                <TableCell className="align-top">
                  {FACTORY_WORK_ORIGIN_LABELS[entry.item.ref.kind]}
                </TableCell>
                <TableCell className="align-top">
                  {props.ownerLabel(entry.item.ref.environmentId)}
                </TableCell>
                <TableCell className="align-top">{props.projectLabel(entry.item)}</TableCell>
                <TableCell className="align-top">
                  {entry.item.sourceState ?? <Muted>None (authored)</Muted>}
                </TableCell>
                <TableCell className="max-w-40 align-top">
                  {entry.item.revision === null ? (
                    <Muted>Not stored</Muted>
                  ) : (
                    <span className="break-all">{entry.item.revision}</span>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  <Muted>Unavailable</Muted>
                </TableCell>
                <TableCell className="align-top">{entry.item.createdAt}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function Muted(props: { readonly children: string }) {
  return <span className="text-muted-foreground">{props.children}</span>;
}

export function FactoryWorkBoard(
  props: FactoryWorkCollectionProps & {
    readonly grouping: FactoryWorkBoardGrouping;
    readonly kind: FactoryWorkKind | undefined;
    readonly projectOf: (item: FactoryWorkSummary) => {
      readonly key: string;
      readonly label: string;
    };
  },
) {
  const columns = groupFactoryWorkForBoard(props.entries, props.grouping, {
    kind: props.kind,
    projectOf: props.projectOf,
  });
  return (
    <div
      className="flex max-w-full flex-col gap-3 pb-2 focus-visible:outline-2 focus-visible:outline-ring md:flex-row md:items-start md:overflow-x-auto"
      role="region"
      aria-label={`Work board by ${props.grouping === "origin" ? "origin" : "admission project"}, loaded pages only`}
      tabIndex={0}
      onKeyDown={moveFocus}
    >
      {columns.length === 0 ? <p>No loaded work to group.</p> : null}
      {columns.map((column) => (
        <section
          key={column.key}
          className="min-w-0 space-y-2 rounded-lg bg-muted/40 p-2 md:w-72 md:shrink-0"
          aria-label={`${column.label}, ${column.entries.length} loaded`}
        >
          <h3 className="flex items-baseline justify-between gap-2 px-1 text-sm font-medium">
            <span className="min-w-0 break-words">{column.label}</span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              {column.entries.length} loaded
            </span>
          </h3>
          {column.entries.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">None on loaded pages.</p>
          ) : null}
          <ul className="flex flex-col gap-2" data-work-column>
            {column.entries.map((entry) => {
              const key = factoryWorkKey(entry.item.ref);
              const selected = key === props.selectedKey;
              return (
                <li
                  key={key}
                  data-selected={selected}
                  className="space-y-1.5 rounded-lg border border-border/60 bg-card p-1.5 data-[selected=true]:border-primary"
                >
                  <SelectWorkButton entry={entry} selected={selected} onSelect={props.onSelect} />
                  <p className="px-2 text-xs text-muted-foreground">
                    {props.grouping === "origin"
                      ? props.projectLabel(entry.item)
                      : FACTORY_WORK_ORIGIN_LABELS[entry.item.ref.kind]}{" "}
                    · {props.ownerLabel(entry.item.ref.environmentId)}
                  </p>
                  <div className="px-2">
                    <FactoryWorkItemConditions entry={entry} conflicts={props.conflicts} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
