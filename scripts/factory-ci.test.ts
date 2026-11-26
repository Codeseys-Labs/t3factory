import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Permissions = Schema.Record(Schema.String, Schema.String);
const Workflow = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  permissions: Permissions,
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ permissions: Schema.optionalKey(Permissions) }),
  ),
});
const decodeWorkflow = Schema.decodeEffect(fromYaml(Workflow));

// A workflow that can start by itself may only read: no write scope, and no start from a timer, a
// tag, a release or another workflow. One that builds or publishes starts by hand and nothing else.
const TRIGGERS = ["pull_request", "push", "workflow_dispatch"];
const policyOffences = (workflow: typeof Workflow.Type): ReadonlyArray<string> => {
  const triggers = Object.keys(workflow.on);
  const scopes =
    triggers.length === 1 && triggers[0] === "workflow_dispatch"
      ? []
      : [
          ["workflow", workflow.permissions] as const,
          ...Object.entries(workflow.jobs).map(
            ([job, { permissions }]) => [job, permissions ?? {}] as const,
          ),
        ];
  return [
    ...triggers
      .filter((trigger) => !TRIGGERS.includes(trigger))
      .map((trigger) => `trigger ${trigger}`),
    ...(typeof workflow.on.push === "object" &&
    workflow.on.push !== null &&
    "tags" in workflow.on.push
      ? ["trigger push tags"]
      : []),
    ...scopes.flatMap(([where, permissions]) =>
      Object.entries(permissions)
        .filter(([, level]) => level !== "read" && level !== "none")
        .map(([scope, level]) => `${where} permission ${scope}: ${level}`),
    ),
  ];
};

it.effect.each([
  {
    name: "a read-only check on pull requests and pushes",
    text: [
      "on:",
      "  pull_request:",
      "    branches: [factory]",
      "  push:",
      "    branches: [factory]",
      "  workflow_dispatch:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  factory:",
      "    runs-on: ubuntu-24.04",
    ].join("\n"),
    expected: [],
  },
  {
    name: "a timer, a tag push and another workflow as triggers",
    text: [
      "on:",
      "  schedule:",
      "    - cron: '0 4 * * *'",
      "  push:",
      "    tags: ['v*']",
      "  workflow_run:",
      "    workflows: [Factory]",
      "permissions:",
      "  contents: read",
      "jobs: {}",
    ].join("\n"),
    expected: ["trigger schedule", "trigger workflow_run", "trigger push tags"],
  },
  {
    name: "a write scope on a workflow that a push can start",
    text: [
      "on:",
      "  push:",
      "    branches: [factory]",
      "  workflow_dispatch:",
      "permissions:",
      "  contents: write",
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
      "      contents: read",
    ].join("\n"),
    expected: ["workflow permission contents: write", "publish permission id-token: write"],
  },
  {
    name: "a write scope on a workflow started only by hand",
    text: [
      "on:",
      "  workflow_dispatch:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  publish:",
      "    permissions:",
      "      contents: write",
    ].join("\n"),
    expected: [],
  },
])("workflow policy: $name", ({ text, expected }) =>
  Effect.gen(function* () {
    assert.deepStrictEqual(policyOffences(yield* decodeWorkflow(text)), expected);
  }),
);

it.effect("every Factory workflow keeps to the policy and names its permissions", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(import.meta.dirname, "..", ".github", "workflows");
    const files = (yield* fileSystem.readDirectory(directory)).filter(
      (file) => file.startsWith("factory") && file.endsWith(".yml"),
    );
    assert.isAbove(files.length, 0);
    for (const file of files) {
      const workflow = yield* decodeWorkflow(
        yield* fileSystem.readFileString(path.join(directory, file)),
      );
      assert.deepStrictEqual(policyOffences(workflow), [], file);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
