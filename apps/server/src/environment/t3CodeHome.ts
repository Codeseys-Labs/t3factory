import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
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
  // The volume and file id settle symlinks and, on case-insensitive volumes, spelling: Node's
  // realpath answers with the spelling it was asked. A folder that does not exist yet has no id
  // and keeps its path: it cannot be the folder this server already runs in.
  const [homeKey, baseKey] = yield* Effect.forEach([home, baseDir], (directory) =>
    fs.stat(directory).pipe(
      Effect.map((info) => Option.map(info.ino, (ino) => `id:${info.dev}:${ino}`)),
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.map(
        Option.getOrElse(() => {
          const resolved = path.resolve(directory);
          return platform === "win32" ? resolved.toLowerCase() : resolved;
        }),
      ),
    ),
  );
  return homeKey === baseKey ? null : home;
});
