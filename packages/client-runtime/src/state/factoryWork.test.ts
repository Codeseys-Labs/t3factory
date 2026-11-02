import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  FACTORY_READINESS_TTL_MS,
  ProjectId,
  SourceControlProviderKind,
  type FactoryWorkListResult,
  type FactoryWorkPrerequisite,
  type FactoryWorkPrerequisitesResult,
  type FactoryWorkSummary,
} from "@t3tools/contracts";
import {
  aggregateFactoryWork,
  factoryWorkKey,
  parseFactoryWorkSelection,
  planFactoryWorkOwners,
  presentFactoryWorkPrerequisites,
  selectFactoryWorkDetail,
} from "./factoryWork.ts";

const here = EnvironmentId.make("here");
const there = EnvironmentId.make("there");
const owner = ProjectId.make("owner");
const observer = ProjectId.make("observer");
const item = (environmentId = here, id = "admission"): FactoryWorkSummary => ({
  ref: { version: 1, environmentId, kind: "issue", id },
  projectId: owner,
  title: "retained",
  createdAt: "2026-10-25T00:00:00.000Z",
  sourceKey: "github:repo#1",
  sourceUrl: null,
  sourceState: "open",
  revision: null,
  supersededBy: null,
  originConflict: false,
  planningStage: null,
});
const page = (
  environmentId: EnvironmentId,
  items: readonly FactoryWorkSummary[],
): FactoryWorkListResult => ({
  environmentId,
  items,
  nextCursor: null,
  fetchedAt: "2026-10-26T00:00:00.000Z",
});

describe("Factory Work aggregation", () => {
  it("keeps copied database work environment-qualified and exposes source conflicts without selecting an owner", () => {
    const a = item(here);
    const b = item(there);
    const result = aggregateFactoryWork([
      { environmentId: here, status: "current", page: page(here, [a]) },
      { environmentId: there, status: "current", page: page(there, [b]) },
    ]);
    expect(result.items.map(({ item }) => factoryWorkKey(item.ref))).toEqual([
      factoryWorkKey(a.ref),
      factoryWorkKey(b.ref),
    ]);
    expect(result.conflicts.has("github:repo#1")).toBe(true);
    expect(result.items.map(({ item }) => item.projectId)).toEqual([owner, owner]);
  });
  it("retains legacy conflict members but does not treat concrete briefs with identical titles as duplicate source work", () => {
    const feedOne = {
      ...item(),
      ref: { ...item().ref, kind: "feed" as const, id: "feed-one" },
      originConflict: true,
    };
    const feedTwo = { ...feedOne, ref: { ...feedOne.ref, id: "feed-two" } };
    const briefOne = {
      ...item(),
      ref: { ...item().ref, kind: "brief" as const, id: "brief-one" },
      sourceKey: null,
    };
    const briefTwo = {
      ...briefOne,
      ref: { ...briefOne.ref, id: "brief-two" },
      supersededBy: "brief-one",
    };
    const result = aggregateFactoryWork([
      {
        environmentId: here,
        status: "current",
        page: page(here, [feedOne, feedTwo, briefOne, briefTwo]),
      },
    ]);
    expect(result.items.map(({ item }) => item.ref.id)).toEqual([
      "brief-one",
      "brief-two",
      "feed-one",
      "feed-two",
    ]);
    expect([...result.conflicts]).toEqual(["github:repo#1"]);
  });
  it("plans exactly one request per environment with local owner filters, not one per checkout observation", () => {
    expect(
      planFactoryWorkOwners({
        environmentIds: [here, here, there],
        projects: [
          { environmentId: here, id: owner },
          { environmentId: here, id: observer },
          { environmentId: here, id: owner },
        ],
      }),
    ).toEqual([
      { environmentId: here, projectIds: [observer, owner] },
      { environmentId: there, projectIds: [] },
    ]);
    expect(planFactoryWorkOwners({ environmentIds: [here], projects: null })).toEqual([
      { environmentId: here, projectIds: undefined },
    ]);
  });
  it.each(["offline", "failed", "loading"] as const)(
    "labels %s summaries stale and does not claim a complete collection",
    (status) => {
      const result = aggregateFactoryWork([
        { environmentId: here, status, page: page(here, [item()]) },
      ]);
      expect(result.items[0]).toMatchObject({ stale: true, fetchedAt: "2026-10-26T00:00:00.000Z" });
      expect(result.incomplete).toBe(true);
      expect(selectFactoryWorkDetail(status, { protected: "detail" })).toBeNull();
    },
  );
  it.each(["forbidden", "unsupported"] as const)(
    "drops protected cached data for %s owners instead of showing it as an empty authoritative page",
    (status) => {
      const result = aggregateFactoryWork([
        { environmentId: here, status, page: page(here, [item()]) },
      ]);
      expect(result.items).toEqual([]);
      expect(result.incomplete).toBe(true);
      expect(selectFactoryWorkDetail(status, { protected: "detail" })).toBeNull();
    },
  );
  it("round-trips concrete selection independent of layout and rejects malformed or foreign-version selections", () => {
    const selected = item(there, "brief:revision/one").ref;
    expect(parseFactoryWorkSelection(JSON.stringify(selected))).toEqual(selected);
    expect(parseFactoryWorkSelection(JSON.stringify({ ...selected, version: 2 }))).toBeNull();
    expect(parseFactoryWorkSelection("not json")).toBeNull();
    expect(parseFactoryWorkSelection(undefined)).toBeNull();
    expect(selectFactoryWorkDetail("current", selected)).toEqual(selected);
  });
});

const observedAt = "2026-10-26T00:00:00.000Z";
const blocker = (
  number: number,
  link: FactoryWorkPrerequisite["link"],
  edge: Partial<FactoryWorkPrerequisite["edge"]> = {},
): FactoryWorkPrerequisite => ({
  edge: {
    targetId: number,
    targetHost: "github.com",
    targetRepository: "acme/app",
    targetNumber: number,
    targetUrl: `https://github.com/acme/app/issues/${number}`,
    title: `Blocker ${number}`,
    state: "open",
    stateReason: null,
    closedAt: null,
    resolution: "open",
    status: "present",
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    fingerprint: String(number),
    override: null,
    ...edge,
  },
  link,
});
const observed = (
  prerequisites: readonly FactoryWorkPrerequisite[],
  readiness: Partial<
    Extract<FactoryWorkPrerequisitesResult, { status: "observed" }>["readiness"]
  > = {},
): FactoryWorkPrerequisitesResult => ({
  status: "observed",
  reviewProjectId: owner,
  repository: {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "acme/app",
    canonicalKey: "github.com/acme/app",
    url: "https://github.com/acme/app",
  },
  issueNumber: 1,
  readiness: {
    status: "blocked",
    reasons: ["open-blocker"],
    basis: null,
    overrides: [],
    complete: true,
    listedCount: prerequisites.length,
    summaryTotal: prerequisites.length,
    observedAt,
    ...readiness,
  },
  prerequisites,
  omittedCount: 0,
  fetchedAt: observedAt,
});
const present = (
  result: FactoryWorkPrerequisitesResult | null,
  options: Partial<Parameters<typeof presentFactoryWorkPrerequisites>[0]> = {},
) =>
  presentFactoryWorkPrerequisites({
    status: "current",
    supported: true,
    failed: false,
    result,
    withinFilter: (link) => link.projectId === owner,
    page: 0,
    nowMs: Date.parse(observedAt),
    ...options,
  });

describe("Factory Work prerequisites", () => {
  it.each(["forbidden", "offline", "unsupported"] as const)(
    "clears protected blockers for %s owners",
    (status) => {
      expect(present(observed([blocker(1, { kind: "none" })]), { status })).toMatchObject({
        state: "unavailable",
      });
    },
  );
  it("never presents a failed, unsupported or non-issue read as an empty graph", () => {
    expect(present(null, { supported: false }).state).toBe("unavailable");
    expect(present(null, { failed: true }).state).toBe("unavailable");
    const brief = present({ status: "not-modeled", kind: "brief", fetchedAt: observedAt });
    expect(brief).toMatchObject({ state: "not-modeled" });
    expect(brief.state !== "observed" && brief.message).toMatch(
      /not modeled here.*does not mean the work has no real-world dependencies/,
    );
    const partial = present(observed([], { complete: false, summaryTotal: null }), {
      nowMs: Date.parse(observedAt) + FACTORY_READINESS_TTL_MS + 1,
    });
    expect(partial).toMatchObject({ state: "observed", stale: true });
    expect(partial.state === "observed" && partial.emptyMessage).toMatch(/not an empty/);
  });
  it("withholds inaccessible tombstone details and distinguishes off-filter retained links", () => {
    const view = present(
      observed([
        blocker(
          2,
          { kind: "not-current" },
          { status: "inaccessible", resolution: "inaccessible", title: "leaked", state: null },
        ),
        blocker(3, {
          kind: "retained",
          ref: item(here, "other-root").ref,
          projectId: ProjectId.make("other"),
        }),
        blocker(4, { kind: "retained", ref: item(here, "own-root").ref, projectId: owner }),
        blocker(5, { kind: "unresolved", reason: "cycle" }, { resolution: "accepted" }),
      ]),
    );
    if (view.state !== "observed") throw new Error(view.state);
    expect(
      view.list.entries.map((node) => [node.locator, node.tone, node.title, node.linkLabel]),
    ).toEqual([
      ["acme/app#3", "blocking", "Blocker 3", "Open retained Work (outside current filter)"],
      ["acme/app#4", "blocking", "Blocker 4", "Open retained Work"],
      [
        "acme/app#2",
        "unknown",
        null,
        "Not linked: this blocker was not verified in the latest source observation",
      ],
      ["acme/app#5", "clear", "Blocker 5", "Retained Work lineage has a cycle; not linked"],
    ]);
    expect(view.list.entries[2]?.sourceUrl).toBeNull();
  });
  it("caps the diagram at 25 nodes with an omitted count and pages the full list", () => {
    const view = present(
      observed(Array.from({ length: 60 }, (_, index) => blocker(index + 1, { kind: "none" }))),
      { page: 99 },
    );
    if (view.state !== "observed") throw new Error(view.state);
    expect(view.graph.nodes).toHaveLength(25);
    expect(view.graph.omitted).toBe(35);
    expect(view.list).toMatchObject({ page: 2, pageCount: 3, first: 51, last: 60, total: 60 });
  });
});
