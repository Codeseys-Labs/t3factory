#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - The CLI needs the host home directory for path refusal.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";
import {
  checkVendor,
  fetchVendor,
  makeDownload,
  statusVendor,
  type Report,
} from "./factory-vendor-lib.ts";

export {
  isNetworkPath,
  vendorProblems,
  assetFile,
  makeDownload,
  checkVendor,
  statusVendor,
  fetchVendor,
  type Download,
  type Report,
} from "./factory-vendor-lib.ts";

const printReport = Effect.fn("factoryVendor.printReport")(function* (report: Report) {
  for (const line of report.stdout) yield* Console.log(line);
  for (const line of report.stderr) yield* Console.error(line);
  process.exitCode = report.exitCode;
});
const command = Command.make("factory-vendor").pipe(
  Command.withSubcommands([
    Command.make("check", {}, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filename = yield* path.fromFileUrl(
          new URL("../factory/vendor/manifest.json", import.meta.url),
        );
        const manifestText = yield* fs
          .readFileString(filename)
          .pipe(Effect.orElseSucceed(() => null));
        yield* printReport(checkVendor(manifestText));
      }),
    ),
    Command.make("status", { dir: Flag.String("dir").pipe(Flag.optional) }, ({ dir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filename = yield* path.fromFileUrl(
          new URL("../factory/vendor/manifest.json", import.meta.url),
        );
        const manifestText = yield* fs
          .readFileString(filename)
          .pipe(Effect.orElseSucceed(() => null));
        yield* printReport(yield* statusVendor({ manifestText, dir: Option.getOrNull(dir) }));
      }),
    ),
    Command.make("fetch", { dir: Flag.String("dir") }, ({ dir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filename = yield* path.fromFileUrl(
          new URL("../factory/vendor/manifest.json", import.meta.url),
        );
        const manifestText = yield* fs
          .readFileString(filename)
          .pipe(Effect.orElseSucceed(() => null));
        const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
        yield* printReport(
          yield* fetchVendor({
            manifestText,
            dir,
            download: makeDownload({ transport: globalThis.fetch, maxBytes: 104857600 }),
            repoRoot,
            home: NodeOS.homedir(),
          }),
        );
      }),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
