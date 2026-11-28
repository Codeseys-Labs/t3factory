import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { applyInstall, prepareInstall } from "../../../../scripts/factory-pack-plan.ts";
import * as ServerConfig from "../config.ts";
import { BUNDLED_FACTORY_PACK } from "./bundledPack.ts";

// WorkflowRuntime.ts reads its folder from this variable too, and does not export it.
const workflowsOverride = Config.String("T3CODE_WORKFLOWS").pipe(Config.option);
const encoder = new TextEncoder();

/**
 * Leaves `<home>/workflows` as `factory-pack.ts install` without `--force` would, when `workflows`
 * is that folder. Never fails: what keeps the pack out is logged once and the caller goes on.
 */
export const install = Effect.fn("FactoryPackInstall.install")(
  function* (input: {
    readonly pack: Readonly<Record<string, string>> | null;
    readonly home: string;
    readonly workflows: string;
  }) {
    if (input.pack === null) return;
    const path = yield* Path.Path;
    const directory = path.join(input.home, "workflows");
    if (path.resolve(input.workflows) !== path.resolve(directory)) {
      return yield* Effect.logWarning(
        "The bundled workflow pack is not installed: this server reads its workflows from another folder",
        { workflows: input.workflows, packFolder: directory },
      );
    }
    const prepared = yield* prepareInstall({
      directory,
      files: new Map(
        Object.entries(input.pack).map(([name, text]) => [name, encoder.encode(text)] as const),
      ),
      force: false,
      managed: true,
    });
    const { written, removed } = yield* applyInstall(prepared);
    if (written.length === 0 && removed.length === 0) return;
    yield* Effect.logInfo("Installed the bundled workflow pack", { directory, written, removed });
  },
  Effect.catchTags({
    FactoryPackConflictError: (error) =>
      Effect.logWarning(
        "The bundled workflow pack is not installed: files in its folder are not what the pack installed",
        { paths: error.paths },
      ),
  }),
  Effect.catchCause((cause) =>
    Effect.logWarning("The bundled workflow pack is not installed", { cause }),
  ),
);

/** Installs this build's pack into the home the server runs on; a checkout has none. */
export const installBundled = Effect.gen(function* () {
  if (BUNDLED_FACTORY_PACK === null) return;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config)) return;
  const override = yield* workflowsOverride;
  yield* install({
    pack: BUNDLED_FACTORY_PACK,
    home: config.value.baseDir,
    workflows: Option.getOrElse(override, () => config.value.workflowsDir),
  });
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("The bundled workflow pack is not installed", { cause }),
  ),
  Effect.withSpan("FactoryPackInstall.installBundled"),
);
