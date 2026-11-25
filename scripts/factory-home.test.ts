import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { initFactoryHome, withWorkflowsEnabled } from "./factory-home.ts";

it.effect.each([
  { name: "absent", input: null, expected: { text: '{\n  "workflowsEnabled": true\n}\n' } },
  {
    name: "preserves keys and order",
    input: '{"first":1,"workflowsEnabled":false,"last":{"x":2}}',
    expected: {
      text: '{\n  "first": 1,\n  "workflowsEnabled": true,\n  "last": {\n    "x": 2\n  }\n}\n',
    },
  },
  {
    name: "already enabled",
    input: '{ "workflowsEnabled": true, "other": 1 }',
    expected: { text: '{ "workflowsEnabled": true, "other": 1 }' },
  },
  { name: "array", input: "[]", expected: { error: "Settings must be a JSON object" } },
  { name: "null", input: "null", expected: { error: "Settings must be a JSON object" } },
  { name: "invalid", input: "{", expected: { error: "Settings must be a JSON object" } },
])("settings: $name", ({ input, expected }) =>
  Effect.sync(() => {
    assert.deepStrictEqual(withWorkflowsEnabled(input), expected);
  }),
);

it.layer(NodeServices.layer)("factory home", (it) => {
  it.effect("initializes idempotently and protects an existing database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-home-" });
      const home = path.join(root, "new-home");
      yield* initFactoryHome({ home, existing: false });
      const settingsPath = path.join(home, "userdata", "settings.json");
      const manifestPath = path.join(home, "workflows", ".factory-pack.json");
      const settings = yield* fs.readFileString(settingsPath);
      const manifest = yield* fs.readFileString(manifestPath);
      assert.strictEqual(settings, '{\n  "workflowsEnabled": true\n}\n');
      assert.isTrue(yield* fs.exists(path.join(home, "workflows", "factory-task.ts")));
      assert.isTrue(yield* fs.exists(path.join(home, "workflows", "lib")));
      yield* initFactoryHome({ home, existing: false });
      assert.strictEqual(yield* fs.readFileString(settingsPath), settings);
      assert.strictEqual(yield* fs.readFileString(manifestPath), manifest);

      const occupied = path.join(root, "occupied");
      const userdata = path.join(occupied, "userdata");
      const database = path.join(userdata, "statev2.sqlite");
      yield* fs.makeDirectory(userdata, { recursive: true });
      yield* fs.writeFile(database, new Uint8Array([0, 1, 2, 255]));
      const error = yield* Effect.flip(initFactoryHome({ home: occupied, existing: false }));
      assert.strictEqual(error._tag, "FactoryHomeError");
      assert.deepStrictEqual(yield* fs.readDirectory(userdata), ["statev2.sqlite"]);
      assert.isFalse(yield* fs.exists(path.join(occupied, "workflows")));
      yield* initFactoryHome({ home: occupied, existing: true });
      assert.deepStrictEqual(yield* fs.readFile(database), new Uint8Array([0, 1, 2, 255]));
      assert.isTrue(yield* fs.exists(path.join(userdata, "settings.json")));
      assert.isTrue(yield* fs.exists(path.join(occupied, "workflows", ".factory-pack.json")));
    }),
  );
});
