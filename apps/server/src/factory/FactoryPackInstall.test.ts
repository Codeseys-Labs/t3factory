import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as FactoryPackInstall from "./FactoryPackInstall.ts";

const PACK = { "lib/helper.ts": "helper", "run.ts": "workflow" };
// The digests `scripts/factory-pack.test.ts` expects the script to record for the same text.
const HELPER = "e81d3b0e9d82feaaf5f6e55bdff24731d7eee08632ffa63801e6397290c5d20a";
const WORKFLOW = "da7f739f627198465eeab537a6f7a435dc4a0c332f9e4a8462293eb3f4ab7ee0";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-pack-install-" });
  const home = path.join(root, "home");
  yield* fs.makeDirectory(home);
  const workflows = path.join(home, "workflows");
  return { fs, path, root, home, workflows, manifest: path.join(workflows, ".factory-pack.json") };
});

/** What `effect` logged, at every level, each as the arguments it was logged with. */
const logged = Effect.fn("FactoryPackInstallTest.logged")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message });
  });
  yield* effect.pipe(
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.provideService(References.MinimumLogLevel, "All"),
  );
  return logs;
});
const warnings = (logs: ReadonlyArray<{ readonly level: string; readonly message: unknown }>) =>
  logs.filter((log) => log.level === "Warn").map((log) => log.message);

const denied = (file: string) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFile",
      pathOrDescriptor: file,
    }),
  );

it.layer(NodeServices.layer)("FactoryPackInstall", (it) => {
  it.effect.each([
    { label: "there is no pack", elsewhere: false, pack: null, warned: 0 },
    { label: "the workflows folder is elsewhere", elsewhere: true, pack: PACK, warned: 1 },
  ])("leaves the home untouched when $label", ({ elsewhere, pack, warned }) =>
    Effect.gen(function* () {
      const { fs, path, root, home, workflows } = yield* setup;
      const logs = yield* logged(
        FactoryPackInstall.install({
          pack,
          home,
          workflows: elsewhere ? path.join(root, "elsewhere") : workflows,
        }),
      );
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["home"]);
      assert.deepStrictEqual(yield* fs.readDirectory(home), []);
      assert.lengthOf(logs, warned);
    }),
  );

  it.effect("installs every file and the manifest, and rewrites nothing the second time", () =>
    Effect.gen(function* () {
      const { fs, path, home, workflows, manifest } = yield* setup;
      yield* FactoryPackInstall.install({ pack: PACK, home, workflows });
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "run.ts")), "workflow");
      assert.strictEqual(
        yield* fs.readFileString(path.join(workflows, "lib", "helper.ts")),
        "helper",
      );
      assert.strictEqual(
        yield* fs.readFileString(manifest),
        `${JSON.stringify({ v: 1, files: { "lib/helper.ts": HELPER, "run.ts": WORKFLOW } })}\n`,
      );

      const touched: string[] = [];
      const touch = (file: string) =>
        Effect.sync(() => {
          touched.push(file);
        });
      const recording = FileSystem.FileSystem.of({
        ...fs,
        writeFile: (...args) => Effect.andThen(touch(args[0]), fs.writeFile(...args)),
        writeFileString: (...args) => Effect.andThen(touch(args[0]), fs.writeFileString(...args)),
        remove: (...args) => Effect.andThen(touch(args[0]), fs.remove(...args)),
      });
      const logs = yield* logged(
        FactoryPackInstall.install({ pack: PACK, home, workflows }).pipe(
          Effect.provideService(FileSystem.FileSystem, recording),
        ),
      );
      assert.deepStrictEqual(touched, []);
      assert.deepStrictEqual(logs, []);
    }),
  );

  it.effect("updates its own files, removes those it dropped, and keeps other files", () =>
    Effect.gen(function* () {
      const { fs, path, home, workflows, manifest } = yield* setup;
      yield* FactoryPackInstall.install({
        pack: { ...PACK, "lib/old.ts": "old", "old.ts": "old" },
        home,
        workflows,
      });
      yield* fs.writeFileString(path.join(workflows, "mine.ts"), "mine");
      const logs = yield* logged(
        FactoryPackInstall.install({
          pack: { "lib/helper.ts": "helper", "run.ts": "helper" },
          home,
          workflows,
        }),
      );
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "run.ts")), "helper");
      assert.isFalse(yield* fs.exists(path.join(workflows, "old.ts")));
      assert.isFalse(yield* fs.exists(path.join(workflows, "lib", "old.ts")));
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "mine.ts")), "mine");
      assert.strictEqual(
        yield* fs.readFileString(manifest),
        `${JSON.stringify({ v: 1, files: { "lib/helper.ts": HELPER, "run.ts": HELPER } })}\n`,
      );
      assert.deepStrictEqual(warnings(logs), []);
    }),
  );

  it.effect("installs nothing and names the path when a file in the way is not the pack's", () =>
    Effect.gen(function* () {
      const { fs, path, home, workflows } = yield* setup;
      yield* fs.makeDirectory(workflows);
      yield* fs.writeFileString(path.join(workflows, "run.ts"), "mine");
      const logs = yield* logged(FactoryPackInstall.install({ pack: PACK, home, workflows }));
      assert.deepStrictEqual(yield* fs.readDirectory(workflows), ["run.ts"]);
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "run.ts")), "mine");
      assert.deepStrictEqual(warnings(logs), [
        [
          "The bundled workflow pack is not installed: files in its folder are not what the pack installed",
          { paths: [path.join(workflows, "run.ts")] },
        ],
      ]);
    }),
  );

  it.effect.each([
    { label: "a pack file", edited: "run.ts" },
    { label: "a file the pack dropped", edited: "old.ts" },
  ])("installs nothing and names the path when $label was edited", ({ edited }) =>
    Effect.gen(function* () {
      const { fs, path, home, workflows, manifest } = yield* setup;
      yield* FactoryPackInstall.install({ pack: { ...PACK, "old.ts": "old" }, home, workflows });
      const installed = yield* fs.readFileString(manifest);
      yield* fs.writeFileString(path.join(workflows, edited), "mine");
      const logs = yield* logged(
        FactoryPackInstall.install({
          pack: { "lib/helper.ts": "changed", "run.ts": "changed" },
          home,
          workflows,
        }),
      );
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, edited)), "mine");
      assert.strictEqual(
        yield* fs.readFileString(path.join(workflows, "lib", "helper.ts")),
        "helper",
      );
      assert.strictEqual(yield* fs.readFileString(manifest), installed);
      assert.deepStrictEqual(warnings(logs), [
        [
          "The bundled workflow pack is not installed: files in its folder are not what the pack installed",
          { paths: [path.join(workflows, edited)] },
        ],
      ]);
    }),
  );

  it.effect("logs once and does not fail its caller when the folder cannot be written", () =>
    Effect.gen(function* () {
      const { fs, home, workflows, manifest } = yield* setup;
      const readOnly = FileSystem.FileSystem.of({
        ...fs,
        writeFile: (file) => Effect.fail(denied(file)),
      });
      const logs = yield* logged(
        FactoryPackInstall.install({ pack: PACK, home, workflows }).pipe(
          Effect.provideService(FileSystem.FileSystem, readOnly),
        ),
      );
      assert.deepStrictEqual(
        warnings(logs).map((message) => (Array.isArray(message) ? message[0] : message)),
        ["The bundled workflow pack is not installed"],
      );
      assert.isFalse(yield* fs.exists(manifest));
    }),
  );

  it.effect("keeps a file whole when its write fails, and installs on the next start", () =>
    Effect.gen(function* () {
      const { fs, path, home, workflows } = yield* setup;
      yield* FactoryPackInstall.install({ pack: PACK, home, workflows });
      const next = { ...PACK, "run.ts": "changed" };
      const torn = FileSystem.FileSystem.of({
        ...fs,
        writeFile: (file, data, options) =>
          Effect.andThen(
            fs.writeFile(file, data.subarray(0, 1), options),
            Effect.fail(denied(file)),
          ),
      });
      yield* FactoryPackInstall.install({ pack: next, home, workflows }).pipe(
        Effect.provideService(FileSystem.FileSystem, torn),
      );
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "run.ts")), "workflow");

      const logs = yield* logged(FactoryPackInstall.install({ pack: next, home, workflows }));
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "run.ts")), "changed");
      assert.deepStrictEqual(warnings(logs), []);
    }),
  );
});
