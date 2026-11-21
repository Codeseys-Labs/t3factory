import { resolveIssueLinkTarget } from "@t3tools/client-runtime/issue-links";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { readIssueListPreferences } from "../issue/issueListPreferences";
import { ISSUES_PANEL_REF, useRightPanelStore } from "../../rightPanelStore";
import { useProjects, useServerConfigs } from "../../state/entities";

/**
 * Resolves a Factory issue's URL to the Issues page's panel, like `useOpenIssueLink` does for a
 * link, and returns what opens it or null when the panel cannot show it. The queue's checkout is
 * the preferred project, so the panel acts through it and not another on the same repository. A
 * handoff that a URL started passes `replace`, so Back does not return to the URL that handed off.
 */
export function useOpenFactoryIssue(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): (url: string) => ((options?: { readonly replace?: boolean }) => void) | null {
  const { environmentId, projectId } = input;
  const allProjects = useProjects();
  const serverConfigs = useServerConfigs();
  const navigate = useNavigate();
  return (url) => {
    if (serverConfigs.get(environmentId)?.environment.capabilities.issues !== true) return null;
    const target = resolveIssueLinkTarget({
      url,
      projects: allProjects.filter((project) => project.environmentId === environmentId),
      preferredProjectId: projectId,
    });
    if (target === null) return null;
    return (options) => {
      useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, {
        environmentId,
        projectId: target.ref.projectId,
        tracker: target.ref.tracker,
        ...(target.ref.host === undefined ? {} : { host: target.ref.host }),
        scope: target.ref.scope,
        key: target.ref.key,
        url,
      });
      void navigate({
        to: "/issues",
        search: {
          ...readIssueListPreferences(),
          selectedEnvironmentId: environmentId,
          selectedProjectId: target.ref.projectId,
          ...(target.ref.host === undefined ? {} : { selectedHost: target.ref.host }),
          tracker: target.ref.tracker,
          scope: target.ref.scope,
          key: target.ref.key,
        },
        ...(options?.replace === true ? { replace: true } : {}),
      });
    };
  };
}
