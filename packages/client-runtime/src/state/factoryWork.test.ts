import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type FactoryWorkListResult,
  type FactoryWorkSummary,
} from "@t3tools/contracts";
import {
  aggregateFactoryWork,
  factoryWorkKey,
  parseFactoryWorkSelection,
  planFactoryWorkOwners,
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
