import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { separateT3CodeHome } from "./t3CodeHome.ts";

it.effect("knows T3 Code's folder under another spelling on a case-insensitive volume", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-home-" });
    yield* fs.makeDirectory(path.join(home, ".t3"));
    yield* fs.makeDirectory(path.join(home, ".t3factory"));
    // Such a volume opens ".t3" for ".T3", and Node's realpath answers with the spelling asked.
    const fold = (file: string) => file.replace(".T3", ".t3");
    const locate = (baseDir: string) =>
      separateT3CodeHome(baseDir).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) => fs.stat(fold(file)),
          realPath: (file) => Effect.as(fs.realPath(fold(file)), file),
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
    assert.deepEqual(
      [yield* locate(path.join(home, ".T3")), yield* locate(path.join(home, ".t3factory"))],
      [null, path.join(home, ".t3")],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
