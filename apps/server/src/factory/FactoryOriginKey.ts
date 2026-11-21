import {
  FactoryOriginKey,
  type FactoryRepository,
  type IssueTrackerKind,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

export const issueNumberOf = (key: string): number | null => {
  const number = Number(key);
  return /^[1-9]\d*$/.test(key) && Number.isSafeInteger(number) ? number : null;
};

export const issueKeyOf = (issue: {
  readonly key?: string;
  readonly number?: number | null;
  readonly issueNumber?: number | string;
}): string => issue.key ?? String(issue.number ?? issue.issueNumber);

export const issueScopeKey = (repository: FactoryRepository): string =>
  repository.issueScope?.canonicalKey ?? repository.canonicalKey;

export const issueTrackerOf = (repository: FactoryRepository) =>
  repository.issueScope?.tracker ?? repository.provider;

// Escape the escape marker too, so literal percent sequences cannot impersonate delimiters.
const component = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("#", "%23").replaceAll(":", "%3A");

// The provider kind is the namespace, so `github:` keys stay byte-identical to the rows written
// before other forges existed. The canonical key already carries the host, so two forges never
// produce the same key for different issues.
export const issueOriginKey = (
  provider: SourceControlProviderKind | IssueTrackerKind,
  canonicalKey: string,
  key: string | number,
): FactoryOriginKey =>
  FactoryOriginKey.make(`${provider}:${component(canonicalKey)}#${component(String(key))}`);

/** The issue an `issueOriginKey` names, or null for any other key. */
export const parseIssueOriginKey = (
  key: string,
): {
  readonly provider: string;
  readonly canonicalKey: string;
  readonly key: string;
  readonly number: number | null;
} | null => {
  const match = /^([a-z][a-z0-9-]*):([^|#]+)#([^|#]+)$/.exec(key);
  if (match === null) return null;
  try {
    return {
      provider: match[1]!,
      canonicalKey: decodeURIComponent(match[2]!),
      key: decodeURIComponent(match[3]!),
      number: issueNumberOf(decodeURIComponent(match[3]!)),
    };
  } catch {
    // Keys copied from retained Work are not all ours; a malformed escape names no issue.
    return null;
  }
};

export const feedItemOriginKey = (
  canonicalKey: string,
  locator: string,
  itemKey: string,
): FactoryOriginKey =>
  FactoryOriginKey.make(
    `feed:${component(canonicalKey)}|${component(locator)}|${component(itemKey)}`,
  );

export const researchRunOriginKey = (protocolId: string, role: string): FactoryOriginKey =>
  FactoryOriginKey.make(`research:${component(protocolId)}:${component(role)}`);

export const knowledgeBriefOriginKey = (briefId: string): FactoryOriginKey =>
  FactoryOriginKey.make(`knowledge:${component(briefId)}`);

// One revision of one task's result. Each accepted revision is its own delivery origin, so a
// re-accepted task can be published again without touching the pull request of an earlier one.
export const taskResultOriginKey = (
  rootId: string,
  taskId: string,
  revision: number,
): FactoryOriginKey =>
  FactoryOriginKey.make(`task:${component(rootId)}|${component(taskId)}#${revision}`);

export const parseTaskResultOriginKey = (
  key: string,
): { readonly rootId: string; readonly taskId: string; readonly revision: number } | null => {
  const match = /^task:([^|#]+)\|([^|#]+)#(\d+)$/.exec(key);
  if (match === null) return null;
  // `component` escapes exactly `%`, `|`, `#` and `:`, which `decodeURIComponent` reverses.
  return {
    rootId: decodeURIComponent(match[1]!),
    taskId: decodeURIComponent(match[2]!),
    revision: Number(match[3]),
  };
};
