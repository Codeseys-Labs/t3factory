import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";

import {
  installFactoryPack,
  needsWorkflowRestart,
  planInstall,
  planStatus,
  uninstallFactoryPack,
} from "./factory-pack.ts";

it.effect("plans installs and status from pack, target, and manifest hashes", () =>
  Effect.sync(() => {
    const pack = new Map([
      ["workflow.ts", "new"],
      ["lib/helper.ts", "helper"],
    ]);
    const empty = new Map<string, string>();
    const fresh = { pack, target: empty, manifest: null, force: false };
    assert.isFalse(needsWorkflowRestart(planInstall(fresh), false));
    assert.deepStrictEqual(planInstall(fresh), {
      conflicts: [],
      write: ["workflow.ts", "lib/helper.ts"],
      remove: [],
      unchanged: [],
    });
    assert.deepStrictEqual(planStatus(fresh), [
      { path: "workflow.ts", status: "missing" },
      { path: "lib/helper.ts", status: "missing" },
    ]);
    const installed = { pack, target: pack, manifest: pack, force: false };
    assert.isFalse(needsWorkflowRestart(planInstall(installed), true));
    assert.deepStrictEqual(planInstall(installed), {
      conflicts: [],
      write: [],
      remove: [],
      unchanged: ["workflow.ts", "lib/helper.ts"],
    });
    assert.deepStrictEqual(planStatus(installed), [
      { path: "workflow.ts", status: "same" },
      { path: "lib/helper.ts", status: "same" },
    ]);
    const old = new Map([
      ["workflow.ts", "old"],
      ["lib/helper.ts", "helper"],
      ["old.ts", "old"],
    ]);
    const update = { pack, target: old, manifest: old, force: false };
    assert.isFalse(needsWorkflowRestart(planInstall(update), true));
    const helperChanged = new Map([
      ["workflow.ts", "new"],
      ["lib/helper.ts", "old"],
    ]);
    assert.isTrue(
      needsWorkflowRestart(
        planInstall({ ...installed, target: helperChanged, manifest: helperChanged }),
        true,
      ),
    );
    assert.isTrue(needsWorkflowRestart({ write: [], remove: ["lib/old.ts"] }, true));
    assert.deepStrictEqual(planInstall(update), {
      conflicts: [],
      write: ["workflow.ts"],
      remove: ["old.ts"],
      unchanged: ["lib/helper.ts"],
    });
    assert.deepStrictEqual(planStatus(update), [
      { path: "workflow.ts", status: "changed" },
      { path: "lib/helper.ts", status: "same" },
      { path: "old.ts", status: "stale" },
    ]);
    const edited = {
      ...update,
      target: new Map([
        ["workflow.ts", "mine"],
        ["lib/helper.ts", "helper"],
        ["old.ts", "mine"],
      ]),
    };
    assert.deepStrictEqual(planInstall(edited), {
      conflicts: ["workflow.ts", "old.ts"],
      write: [],
      remove: [],
      unchanged: ["lib/helper.ts"],
    });
    assert.deepStrictEqual(planInstall({ ...edited, force: true }), {
      conflicts: [],
      write: ["workflow.ts"],
      remove: ["old.ts"],
      unchanged: ["lib/helper.ts"],
    });
    const conflict = { pack, target: old, manifest: null, force: false };
    assert.deepStrictEqual(planInstall(conflict), {
      conflicts: ["workflow.ts"],
      write: [],
      remove: [],
      unchanged: ["lib/helper.ts"],
    });
    assert.deepStrictEqual(planInstall({ ...conflict, force: true }), {
      conflicts: [],
      write: ["workflow.ts"],
      remove: [],
      unchanged: ["lib/helper.ts"],
    });
    assert.deepStrictEqual(planInstall({ ...fresh, target: pack }), {
      conflicts: [],
      write: [],
      remove: [],
      unchanged: ["workflow.ts", "lib/helper.ts"],
    });
  }),
);

it.layer(NodeServices.layer)("factory pack", (it) => {
  it.effect("installs workflow and skill files and uninstalls only managed workflows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-pack-" });
      const source = path.join(root, "source");
      const home = path.join(root, "home");
      const skills = path.join(root, "skills");
      yield* fs.makeDirectory(path.join(source, "workflows", "lib"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "skills", "t3factory-orchestrator"), {
        recursive: true,
      });
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(path.join(source, "workflows", "run.ts"), "workflow");
      yield* fs.writeFileString(path.join(source, "workflows", "lib", "helper.ts"), "helper");
      yield* fs.writeFileString(
        path.join(source, "skills", "t3factory-orchestrator", "SKILL.md"),
        "skill",
      );
      yield* installFactoryPack({ home, skills, force: false, source });
      const workflows = path.join(home, "workflows");
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "run.ts")), "workflow");
      assert.strictEqual(
        yield* fs.readFileString(path.join(workflows, "lib", "helper.ts")),
        "helper",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(skills, "t3factory-orchestrator", "SKILL.md")),
        "skill",
      );
      const manifest: unknown = JSON.parse(
        yield* fs.readFileString(path.join(workflows, ".factory-pack.json")),
      );
      assert.deepStrictEqual(manifest, {
        v: 1,
        files: {
          "lib/helper.ts": "e81d3b0e9d82feaaf5f6e55bdff24731d7eee08632ffa63801e6397290c5d20a",
          "run.ts": "da7f739f627198465eeab537a6f7a435dc4a0c332f9e4a8462293eb3f4ab7ee0",
        },
      });
      yield* fs.writeFileString(path.join(workflows, "other.ts"), "other");
      yield* uninstallFactoryPack(home);
      assert.include(
        (yield* TestConsole.logLines).join("\n"),
        "Restart the server to finish removing this pack: a running server keeps the old lib/ helpers.",
      );
      assert.isFalse(yield* fs.exists(path.join(workflows, "run.ts")));
      assert.isFalse(yield* fs.exists(path.join(workflows, "lib", "helper.ts")));
      assert.isFalse(yield* fs.exists(path.join(workflows, ".factory-pack.json")));
      assert.strictEqual(yield* fs.readFileString(path.join(workflows, "other.ts")), "other");
      assert.strictEqual(
        yield* fs.readFileString(path.join(skills, "t3factory-orchestrator", "SKILL.md")),
        "skill",
      );
    }),
  );
});
