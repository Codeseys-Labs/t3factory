#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { installFactoryPack, statusFactoryPack } from "./factory-pack.ts";

const Settings = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Settings));
const encodeSettings = Schema.encodeSync(fromJsonStringPretty(Settings));

export const withWorkflowsEnabled = (
  settingsText: string | null,
): { text: string } | { error: string } => {
  const settings =
    settingsText === null ? Option.some<Record<string, unknown>>({}) : decodeSettings(settingsText);
  if (Option.isNone(settings)) return { error: "Settings must be a JSON object" };
  if (settingsText !== null && settings.value.workflowsEnabled === true)
    return { text: settingsText };
  return { text: `${encodeSettings({ ...settings.value, workflowsEnabled: true })}\n` };
};

export class FactoryHomeError extends Schema.TaggedError<FactoryHomeError>()("FactoryHomeError", {
  message: Schema.String,
}) {}

export const initFactoryHome = Effect.fn("factoryHome.init")(function* (input: {
  readonly home: string;
  readonly skills?: string | undefined;
  readonly existing: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userdata = path.join(input.home, "userdata");
  const database = path.join(userdata, "statev2.sqlite");
  if (!input.existing && (yield* fs.exists(database))) {
    return yield* new FactoryHomeError({
      message: `Database already exists: ${database}; use --existing to proceed`,
    });
  }
  const settingsPath = path.join(userdata, "settings.json");
  const previous = (yield* fs.exists(settingsPath)) ? yield* fs.readFileString(settingsPath) : null;
  const updated = withWorkflowsEnabled(previous);
  if ("error" in updated)
    return yield* new FactoryHomeError({ message: `${updated.error}: ${settingsPath}` });
  yield* fs.makeDirectory(userdata, { recursive: true });
  if (updated.text !== previous) yield* fs.writeFileString(settingsPath, updated.text);
  yield* installFactoryPack({ home: input.home, skills: input.skills, force: false });
});

export const statusFactoryHome = Effect.fn("factoryHome.status")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(home, "userdata", "settings.json");
  const settings = (yield* fs.exists(settingsPath))
    ? decodeSettings(yield* fs.readFileString(settingsPath))
    : Option.none();
  const enabled = Option.isSome(settings) && settings.value.workflowsEnabled === true;
  const pack = yield* statusFactoryPack(home);
  return { enabled, pack };
});

const command = Command.make("factory-home").pipe(
  Command.withSubcommands([
    Command.make(
      "init",
      {
        home: Flag.String("home"),
        skills: Flag.String("skills").pipe(Flag.optional),
        existing: Flag.Boolean("existing").pipe(Flag.withDefault(false)),
      },
      ({ home, skills, existing }) =>
        Effect.gen(function* () {
          yield* initFactoryHome({ home, skills: Option.getOrUndefined(skills), existing });
          const quotedHome = `"${home.replaceAll('"', '\\"')}"`;
          yield* Console.log(`vp run dev --home-dir ${quotedHome}`);
          yield* Console.log(
            `Open the pairingUrl it prints. To get a new one later: node apps/server/src/bin.ts pair --base-dir ${quotedHome}`,
          );
        }),
    ),
    Command.make("status", { home: Flag.String("home") }, ({ home }) =>
      Effect.gen(function* () {
        const result = yield* statusFactoryHome(home);
        yield* Console.log(`workflows ${result.enabled ? "enabled" : "disabled"}`);
        for (const entry of result.pack) yield* Console.log(`${entry.status} ${entry.path}`);
        if (!result.enabled || result.pack.some((entry) => entry.status !== "same"))
          process.exitCode = 1;
      }),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.catchTags({
      FactoryHomeError: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      FactoryPackHomeError: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      FactoryPackConflictError: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
    }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
