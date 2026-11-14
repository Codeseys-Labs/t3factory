import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * T3 Code's default data folder on this machine, or null when this server stores its own data
 * there (a T3 Code build, or one started with `T3CODE_HOME=~/.t3`).
 */
export const separateT3CodeHome = Effect.fn("t3CodeHome.separateT3CodeHome")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = path.join(yield* HostProcess.HomeDirectory, ".t3");
  // The real path settles symlinks and, on case-insensitive volumes, spelling. A folder that does
  // not exist yet keeps its given path: it cannot be the folder this server already runs in.
  const [homeKey, baseKey] = yield* Effect.forEach([home, baseDir], (directory) =>
    fs.realPath(directory).pipe(
      Effect.orElseSucceed(() => path.resolve(directory)),
      Effect.map((real) => (platform === "win32" ? real.toLowerCase() : real)),
    ),
  );
  return homeKey === baseKey ? null : home;
});
