import { aggregateFactoryWork } from "@t3tools/client-runtime/state/factory-work";
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  FactoryFeedSourceId,
  FactoryResearchProtocolId,
  ProjectId,
  type FactoryWorkListResult,
  type FactoryWorkReadResult,
  type FactoryWorkSummary,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_WORK_MAX_PAGES,
  factoryWorkAccess,
  factoryWorkPageTargets,
  resolveFactoryWorkOwners,
  resolveFactoryWorkReview,
} from "./factoryWorkList";

const here = EnvironmentId.make("here");
const there = EnvironmentId.make("there");
const owner = ProjectId.make("owner");
const reviewer = ProjectId.make("reviewer");

const item = (id: string, environmentId = here): FactoryWorkSummary => ({
  ref: { version: 1, environmentId, kind: "issue", id },
  projectId: owner,
  title: id,
  createdAt: `2026-10-25T00:00:0${id.length % 10}.000Z`,
  sourceKey: null,
  sourceUrl: null,
  sourceState: "open",
  revision: null,
  supersededBy: null,
  originConflict: false,
  planningStage: null,
});
const page = (
  items: readonly FactoryWorkSummary[],
  nextCursor: string | null,
  fetchedAt = "2026-10-26T00:00:00.000Z",
  environmentId = here,
): FactoryWorkListResult => ({ environmentId, items, nextCursor, fetchedAt });
const ok = (value: FactoryWorkListResult) => AsyncResult.success<FactoryWorkListResult>(value);
const denied = AsyncResult.fail<unknown, FactoryWorkListResult>(
  new EnvironmentAuthorizationError({
    message: "denied",
    requiredScope: AuthOrchestrationReadScope,
  }),
);
const broken = (previous?: FactoryWorkListResult) =>
  AsyncResult.fail<unknown, FactoryWorkListResult>(new Error("offline mid-read"), {
    previousSuccess: previous === undefined ? Option.none() : Option.some(ok(previous)),
  });

const resolve = (
  pages: Record<string, readonly AsyncResult.AsyncResult<FactoryWorkListResult, unknown>[]>,
  access: Record<string, "current" | "offline" | "unsupported"> = {},
) =>
  resolveFactoryWorkOwners({
    plan: Object.keys(pages).map((id) => ({ environmentId: EnvironmentId.make(id) })),
    access: (id) => access[id] ?? "current",
    pages: (id) => pages[id] ?? [],
  });

describe("factoryWorkPageTargets", () => {
  it("requests only readable owners, first page first, within the page bound", () => {
    const targets = factoryWorkPageTargets({
      plan: [
        { environmentId: here, projectIds: [owner] },
        { environmentId: there, projectIds: undefined },
      ],
      access: (id) => (id === here ? "current" : "offline"),
      kind: "brief",
      cursors: () => Array.from({ length: FACTORY_WORK_MAX_PAGES + 3 }, (_, index) => `c${index}`),
    });

    expect(targets).toHaveLength(FACTORY_WORK_MAX_PAGES);
    expect(targets.every((target) => target.environmentId === here)).toBe(true);
    expect(targets[0]?.input).toEqual({
      projectIds: [owner],
      kind: "brief",
      cursor: undefined,
      limit: 25,
    });
    expect(targets[1]?.input.cursor).toBe("c0");
  });
});

describe("resolveFactoryWorkOwners", () => {
  it("merges keyset pages in order with the oldest observation and stays incomplete while a cursor remains", () => {
    const owners = resolve({
      here: [
        ok(page([item("a")], "c1", "2026-10-26T00:00:05.000Z")),
        ok(page([item("bb")], "c2", "2026-10-26T00:00:01.000Z")),
      ],
    });
    const merged = owners[0];

    expect(merged?.status).toBe("current");
    expect(merged?.page?.items.map((entry) => entry.ref.id)).toEqual(["a", "bb"]);
    expect(merged?.page?.fetchedAt).toBe("2026-10-26T00:00:01.000Z");
    expect(merged).toMatchObject({ more: "idle", canLoadMore: true, pageCount: 2 });
    expect(aggregateFactoryWork(owners).incomplete).toBe(true);
  });

  it.each([
    ["failed", broken()],
    ["loading", AsyncResult.initial<FactoryWorkListResult>(true)],
  ] as const)("keeps loaded pages usable when the next page is %s", (more, next) => {
    const owners = resolve({ here: [ok(page([item("a")], "c1")), next] });
    const aggregate = aggregateFactoryWork(owners);

    expect(owners[0]).toMatchObject({ status: "current", more, canLoadMore: false });
    expect(aggregate.items.map(({ item, stale }) => [item.ref.id, stale])).toEqual([["a", false]]);
    expect(aggregate.incomplete).toBe(true);
  });

  it("removes every retained row when any page reports revoked read access", () => {
    const owners = resolve({ here: [ok(page([item("a")], "c1")), denied] });

    expect(owners[0]).toMatchObject({ status: "forbidden", page: null });
    expect(aggregateFactoryWork(owners).items).toEqual([]);
  });

  it("marks a failed first page's previous rows stale rather than empty or current", () => {
    const owners = resolve({ here: [broken(page([item("a")], null))] });
    const aggregate = aggregateFactoryWork(owners);

    expect(owners[0]?.status).toBe("failed");
    expect(aggregate.items.map(({ stale }) => stale)).toEqual([true]);
    expect(aggregate.incomplete).toBe(true);
  });

  it("reports an unreadable owner without rows and keeps other owners complete", () => {
    const owners = resolve(
      { here: [ok(page([item("a")], null))], there: [] },
      { there: "unsupported" },
    );

    expect(owners.map((entry) => [entry.environmentId, entry.status, entry.page])).toEqual([
      [here, "current", page([item("a")], null)],
      [there, "unsupported", null],
    ]);
    expect(aggregateFactoryWork(owners).incomplete).toBe(true);
    expect(aggregateFactoryWork(owners.slice(0, 1)).incomplete).toBe(false);
  });
});

describe("factoryWorkAccess", () => {
  const environment = (phase: string, factoryWork: boolean | null) => ({
    connection: { phase },
    serverConfig: factoryWork === null ? null : { environment: { capabilities: { factoryWork } } },
  });

  it.each([
    [undefined, true, "offline"],
    [environment("disconnected", true), true, "offline"],
    [environment("connected", null), true, "loading"],
    [environment("connected", false), true, "unsupported"],
    [environment("connected", true), false, "forbidden"],
    [environment("connected", true), true, "current"],
  ] as const)("classifies %o with read %s as %s", (target, readable, expected) => {
    expect(factoryWorkAccess(target, readable)).toBe(expected);
  });
});

describe("resolveFactoryWorkReview", () => {
  const detail = (
    reviewTarget: FactoryWorkReadResult["reviewTarget"],
    patch: Partial<FactoryWorkReadResult> = {},
    itemPatch: Partial<FactoryWorkSummary> = {},
  ): FactoryWorkReadResult => ({
    item: { ...item("work"), ...itemPatch },
    reviewTarget,
    snapshot: "",
    snapshotTruncated: false,
    projectAvailable: true,
    reviewProjectId: reviewer,
    projectCoordinatorThreadId: null,
    supersedes: null,
    fetchedAt: "2026-10-26T00:00:00.000Z",
    ...patch,
  });
  const supported = { factoryIssues: true, factoryKnowledge: true };
  const review = (
    value: FactoryWorkReadResult,
    options: { known?: boolean; capabilities?: object; canOperate?: boolean } = {},
  ) =>
    resolveFactoryWorkReview({
      detail: value,
      reviewProjectKnown: options.known ?? true,
      capabilities: options.capabilities ?? supported,
      canOperate: options.canOperate ?? true,
    });

  it("opens the review project, not the admission project, and names a missing operate grant", () => {
    expect(review(detail({ kind: "issue", issueNumber: 7 }, {}, { projectId: owner }))).toEqual({
      kind: "open",
      section: "issues",
      projectId: reviewer,
      label: "Review issue #7",
      operateNote: null,
    });
    expect(review(detail({ kind: "brief", briefId: "b" }), { canOperate: false })).toMatchObject({
      kind: "open",
      section: "briefs",
      operateNote: expect.stringContaining("operate permission"),
    });
  });

  it.each([
    [
      "feed review has no mobile surface",
      detail({ kind: "feed", sourceId: FactoryFeedSourceId.make("source"), itemKey: "k" }),
      {},
      "Feed review isn't available on mobile",
    ],
    [
      "legacy feed conflicts choose no member",
      detail(
        { kind: "feed", sourceId: FactoryFeedSourceId.make("source"), itemKey: "k" },
        {},
        { originConflict: true },
      ),
      {},
      "legacy feed admissions conflict",
    ],
    [
      "protocol review has no mobile surface",
      detail({ kind: "protocol", protocolId: FactoryResearchProtocolId.make("p") }),
      {},
      "Research protocol review isn't available on mobile",
    ],
    [
      "the review project is missing",
      detail({ kind: "issue", issueNumber: 7 }, { reviewProjectId: null }),
      {},
      "saved review project is missing",
    ],
    [
      "the review project is unknown to this device",
      detail({ kind: "brief", briefId: "b" }),
      { known: false },
      "saved review project is missing",
    ],
    [
      "the server lacks the review capability",
      detail({ kind: "issue", issueNumber: 7 }),
      { capabilities: { factoryKnowledge: true } },
      "Issue review is unsupported",
    ],
  ] as const)("is unavailable, with a reason, when %s", (_name, value, options, reason) => {
    const result = review(value, options);
    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" ? result.reason : "").toContain(reason);
  });
});
