import { ScheduledTaskId } from "@t3tools/contracts";
import { parseFactoryWorkSelection } from "@t3tools/client-runtime/state/factory-work";
import { FactoryWorkKind, FactoryFeedSourceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  validateSettingsScopeSearch,
  type ResolvedSettingsScope,
  type SettingsScopeSearch,
} from "../settings/settingsScope";
import { parseFactoryStateFilter, type FactoryIssueStateFilter } from "./factoryIssues.logic";
import { parseFactoryIssueViewMode, type FactoryIssueViewMode } from "./factoryIssues.views";
import { parseFactoryWorkBoardGrouping, type FactoryWorkBoardGrouping } from "./factoryWork.views";

export interface FactorySearch extends SettingsScopeSearch {
  state: FactoryIssueStateFilter;
  view: FactoryIssueViewMode;
  taskId?: ScheduledTaskId | undefined;
  work?: string | undefined;
  /** The selection a followed prerequisite link returns to. */
  workFrom?: string | undefined;
  workKind?: FactoryWorkKind | undefined;
  workGroup?: FactoryWorkBoardGrouping | undefined;
  workReturn?: string | undefined;
  reviewId?: string | undefined;
  reviewIssue?: number | undefined;
  reviewFeed?: string | undefined;
}

const isWorkKind = Schema.is(FactoryWorkKind);
export function validateFactorySearch(raw: Record<string, unknown>): FactorySearch {
  return {
    ...validateSettingsScopeSearch(raw),
    state: parseFactoryStateFilter(raw.state),
    view: parseFactoryIssueViewMode(raw.view),
    ...(parseFactoryWorkSelection(raw.work) !== null ? { work: String(raw.work) } : {}),
    ...(parseFactoryWorkSelection(raw.workFrom) !== null ? { workFrom: String(raw.workFrom) } : {}),
    ...(isWorkKind(raw.workKind) ? { workKind: raw.workKind } : {}),
    ...(raw.workGroup === undefined
      ? {}
      : { workGroup: parseFactoryWorkBoardGrouping(raw.workGroup) }),
    ...(typeof raw.workReturn === "string" && raw.workReturn.length <= 8192
      ? { workReturn: raw.workReturn }
      : {}),
    ...(typeof raw.reviewId === "string" && raw.reviewId.length <= 2048
      ? { reviewId: raw.reviewId }
      : {}),
    ...(typeof raw.reviewIssue === "number" &&
    Number.isSafeInteger(raw.reviewIssue) &&
    raw.reviewIssue > 0
      ? { reviewIssue: raw.reviewIssue }
      : {}),
    ...(typeof raw.reviewFeed === "string" && raw.reviewFeed.length <= 4096
      ? { reviewFeed: raw.reviewFeed }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim().length > 0
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export function factoryScopeSearchForMember(
  member: SidebarProjectGroupMember,
  group: SidebarProjectSnapshot,
): SettingsScopeSearch {
  return {
    project: group.projectKey,
    machine: member.environmentId,
    checkout: member.physicalProjectKey,
  };
}

export function singleFactoryMember(
  scope: ResolvedSettingsScope,
): SidebarProjectGroupMember | null {
  if ((scope.kind !== "project" && scope.kind !== "checkout") || scope.members.length !== 1) {
    return null;
  }
  return scope.members[0] ?? null;
}

const returnScope = Schema.fromJsonString(
  Schema.Struct({
    project: Schema.optional(Schema.String),
    machine: Schema.optional(Schema.String),
    checkout: Schema.optional(Schema.String),
    work: Schema.String,
    workKind: Schema.optional(FactoryWorkKind),
    view: Schema.optional(Schema.Literals(["list", "table", "board"])),
    workGroup: Schema.optional(Schema.Literals(["origin", "project"])),
  }),
);
const decodeWorkReturn = Schema.decodeOption(returnScope);
const decodeFeedReview = Schema.decodeOption(
  Schema.fromJsonString(Schema.Tuple([FactoryFeedSourceId, Schema.String])),
);
export function parseFactoryWorkReturn(value: string | undefined) {
  return value === undefined ? null : Option.getOrNull(decodeWorkReturn(value));
}
export function parseFactoryFeedReview(value: string | undefined) {
  return value === undefined ? null : Option.getOrNull(decodeFeedReview(value));
}
