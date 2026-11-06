import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FactoryDeliveryService from "../../factory/FactoryDeliveryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { EnvironmentId } from "@t3tools/contracts";

/**
 * The runtime without a live delivery service or factory execution: these tests never
 * run a delivery effect, dispatch a factory execution command, or open a provider.
 * The mocked side services are never reached, so their responses are never observed.
 */
export const layer = RuntimeLayer.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(FactoryDeliveryService.FactoryDeliveryService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProcessRunner.ProcessRunner)({}),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
      }),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("runtime-testkit")),
      }),
    ),
  ),
);