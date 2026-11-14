import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as Identities from "./RepositoryIdentityResolver.ts";

// Keep remote normalization and refinement real while tests supply the checkout's primary identity.
export const repositoryIdentitiesLayer = (
  resolve: Identities.RepositoryIdentityResolver["Service"]["resolve"],
  options: Identities.RepositoryIdentityResolverOptions = {},
) =>
  Layer.effect(
    Identities.RepositoryIdentityResolver,
    Identities.make(options).pipe(Effect.map((resolver) => ({ ...resolver, resolve }))),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProcessRunner.ProcessRunner)({}),
        FileSystem.layerNoop({}),
        Path.layer,
      ),
    ),
  );
