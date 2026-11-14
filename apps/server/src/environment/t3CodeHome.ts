import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/**
 * T3 Code's default data folder on this machine, or null when this server stores its own data
 * there (a T3 Code build, or one started with `T3CODE_HOME=~/.t3`).
 */
export const separateT3CodeHome = Effect.fn("t3CodeHome.separateT3CodeHome")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = path.join(yield* HostProcess.HomeDirectory, ".t3");
  const key = (directory: string) => {
    const resolved = path.resolve(directory);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return key(home) === key(baseDir) ? null : home;
});
