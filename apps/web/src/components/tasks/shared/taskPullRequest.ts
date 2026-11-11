import type { FactoryTaskChecks } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";

import {
  linkedPullRequestDetailAtom,
  useSharedPullRequestSummary,
} from "../../../state/pullRequests";
import { useEnvironmentQuery } from "../../../state/query";

/**
 * The checks of the task's open pull request, read through the same shared summary the thread
 * sidebar's pull request chips use. Only screens that show one task read it; lists never do.
 */
export function useTaskPullRequestChecks(task: FactoryTaskSummary): FactoryTaskChecks | null {
  const pullRequest = task.result?.pullRequest ?? null;
  const reference =
    pullRequest?.state === "open"
      ? {
          projectId: task.ref.projectId,
          host: pullRequest.host,
          repository: pullRequest.repository,
          number: pullRequest.number,
        }
      : null;
  // Mounted for its answers, which land in the shared summary read below.
  useEnvironmentQuery(
    reference === null
      ? null
      : linkedPullRequestDetailAtom({ environmentId: task.ref.environmentId, input: reference }),
  );
  return useSharedPullRequestSummary(task.ref.environmentId, reference)?.checksState ?? null;
}
