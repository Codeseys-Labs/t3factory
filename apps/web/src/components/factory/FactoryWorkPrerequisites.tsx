import {
  presentFactoryWorkPrerequisites,
  type FactoryWorkOwnerStatus,
  type FactoryWorkPrerequisiteNode,
  type FactoryWorkPrerequisiteTone,
} from "@t3tools/client-runtime/state/factory-work";
import type { FactoryWorkRef, ProjectId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironments } from "../../state/environments";
import {
  factoryEnvironment,
  factoryIssueKeysInput,
  useFactoryIssueKeysSupported,
} from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { safeExternalUrl } from "./factoryIssues.logic";

const NODE_WIDTH = 160;
const NODE_HEIGHT = 36;
const GAP_X = 12;
const GAP_Y = 14;
const COLUMNS = 5;
const toneClasses: Record<FactoryWorkPrerequisiteTone, string> = {
  blocking: "fill-background stroke-destructive",
  unknown: "fill-background stroke-muted-foreground",
  clear: "fill-muted stroke-border",
  removed: "fill-muted stroke-border",
};

function shorten(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** A fixed one-hop layout: blockers on a grid above, the selected item below. */
function FactoryWorkPrerequisiteDiagram(props: {
  readonly nodes: readonly FactoryWorkPrerequisiteNode[];
  readonly omitted: number;
}) {
  const gt = useGT();
  const columns = Math.max(1, Math.min(COLUMNS, props.nodes.length));
  const rows = Math.max(1, Math.ceil(props.nodes.length / columns));
  const gridWidth = columns * NODE_WIDTH + (columns - 1) * GAP_X;
  const width = Math.max(300, gridWidth);
  const subjectY = rows * (NODE_HEIGHT + GAP_Y) + 24;
  const height = subjectY + NODE_HEIGHT + 4;
  const subjectX = width / 2 - NODE_WIDTH / 2;
  const description =
    props.omitted > 0
      ? gt(
          "Diagram of {count} direct prerequisites; {omitted} more appear only in the list. The list below is equivalent.",
          { count: props.nodes.length, omitted: props.omitted },
        )
      : gt("Diagram of {count} direct prerequisites. The list below is equivalent.", {
          count: props.nodes.length,
        });
  return (
    <div
      className="max-w-full overflow-x-auto"
      role="region"
      aria-label={gt("Prerequisite diagram")}
      tabIndex={0}
    >
      <svg
        role="img"
        aria-label={description}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="max-w-none text-xs"
      >
        {props.nodes.map((node, index) => {
          const x = (width - gridWidth) / 2 + (index % columns) * (NODE_WIDTH + GAP_X);
          const y = Math.floor(index / columns) * (NODE_HEIGHT + GAP_Y);
          return (
            <g key={node.key}>
              <line
                x1={x + NODE_WIDTH / 2}
                y1={y + NODE_HEIGHT}
                x2={width / 2}
                y2={subjectY}
                className="stroke-border"
              />
              <rect
                x={x}
                y={y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={4}
                strokeDasharray={
                  node.tone === "unknown" || node.tone === "removed" ? "3 2" : undefined
                }
                className={toneClasses[node.tone]}
              />
              <text x={x + 6} y={y + 14} className="fill-foreground">
                {shorten(node.locator, 22)}
              </text>
              <text x={x + 6} y={y + 28} className="fill-muted-foreground">
                {node.tone}
                {node.link.kind === "retained" ? ` · ${gt("retained")}` : ""}
              </text>
            </g>
          );
        })}
        <rect
          x={subjectX}
          y={subjectY}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={4}
          className="fill-muted stroke-foreground"
        />
        <text x={subjectX + 6} y={subjectY + 22} className="fill-foreground">
          <T>Selected item</T>
        </text>
        {props.omitted > 0 ? (
          <text x={subjectX + NODE_WIDTH + 8} y={subjectY + 22} className="fill-muted-foreground">
            <T>
              +<Var>{props.omitted}</Var> more in the list
            </T>
          </text>
        ) : null}
      </svg>
    </div>
  );
}

interface PrerequisitesProps {
  readonly reference: FactoryWorkRef;
  readonly status: FactoryWorkOwnerStatus;
  readonly withinFilter: (link: {
    readonly ref: FactoryWorkRef;
    readonly projectId: ProjectId;
  }) => boolean;
  readonly onOpen: (reference: FactoryWorkRef) => void;
}

/** Direct source blockers only. Nothing is read until a person expands the disclosure. */
export function FactoryWorkPrerequisites(props: PrerequisitesProps) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="space-y-3" aria-labelledby="factory-work-prerequisites-title">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id="factory-work-prerequisites-title" className="font-medium">
          <T>Prerequisites · direct source blockers</T>
        </h4>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-controls="factory-work-prerequisites"
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? gt("Hide prerequisites") : gt("Show prerequisites")}
        </Button>
      </div>
      {expanded ? <FactoryWorkPrerequisitesBody {...props} /> : null}
    </section>
  );
}

function FactoryWorkPrerequisitesBody(props: PrerequisitesProps) {
  const gt = useGT();
  const [page, setPage] = useState(0);
  // The minute tick is a UTC ISO prefix; staleness is a ten-minute threshold.
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const { environments } = useEnvironments();
  const supported =
    environments.find((candidate) => candidate.environmentId === props.reference.environmentId)
      ?.serverConfig?.environment.capabilities.factoryWorkPrerequisites === true;
  const issueKeysSupported = useFactoryIssueKeysSupported(props.reference.environmentId);
  const query = useEnvironmentQuery(
    supported && props.status === "current"
      ? factoryEnvironment.readWorkPrerequisites({
          environmentId: props.reference.environmentId,
          input: { ref: props.reference, ...factoryIssueKeysInput(issueKeysSupported) },
        })
      : null,
  );
  const view = presentFactoryWorkPrerequisites({
    status: props.status,
    supported,
    failed: query.error !== null,
    result: query.isPending ? null : query.data,
    withinFilter: props.withinFilter,
    page,
    nowMs,
  });
  return (
    <div id="factory-work-prerequisites" className="space-y-3">
      {view.state !== "observed" ? (
        <p role="status">{view.message}</p>
      ) : (
        <>
          <p className="text-sm">{view.verdict}</p>
          <p className="text-xs text-muted-foreground">{view.observation}</p>
          {view.emptyMessage !== null ? (
            <p>{view.emptyMessage}</p>
          ) : (
            <>
              <FactoryWorkPrerequisiteDiagram
                nodes={view.graph.nodes}
                omitted={view.graph.omitted}
              />
              <p role="status" className="text-xs text-muted-foreground">
                <T>
                  Listing <Var>{view.list.first}</Var>–<Var>{view.list.last}</Var> of{" "}
                  <Var>{view.list.total}</Var> direct prerequisites.
                </T>
              </p>
              <ol className="space-y-2" aria-label={gt("Direct prerequisites")}>
                {view.list.entries.map((node) => {
                  const sourceUrl = safeExternalUrl(node.sourceUrl ?? "");
                  const link = node.link;
                  return (
                    <li key={node.key} className="space-y-1 rounded border p-3 text-sm">
                      <p className="break-all">
                        {node.locator} · {node.title ?? gt("Title unavailable")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {node.tone} · {node.sourceLabel}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {link.kind === "retained" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => props.onOpen(link.ref)}
                          >
                            {node.linkLabel}
                          </Button>
                        ) : (
                          <span className="text-xs">{node.linkLabel}</span>
                        )}
                        {sourceUrl ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            render={<a href={sourceUrl} target="_blank" rel="noreferrer" />}
                          >
                            <T>Open source</T>
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {view.list.pageCount > 1 ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={view.list.page === 0}
                    onClick={() => setPage(view.list.page - 1)}
                  >
                    <T>Previous prerequisites</T>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={view.list.page + 1 >= view.list.pageCount}
                    onClick={() => setPage(view.list.page + 1)}
                  >
                    <T>Next prerequisites</T>
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {view.notes.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        <T>
          Sub-issues and Factory execution lineage are separate relations and are not shown here.
        </T>
      </p>
    </div>
  );
}
