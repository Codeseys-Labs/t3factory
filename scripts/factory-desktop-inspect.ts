#!/usr/bin/env node

import * as NodeBuffer from "node:buffer";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

export interface NamedBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface RequiredLiteralRule {
  readonly literal: string;
  readonly patterns?: ReadonlyArray<string> | undefined;
  readonly reason: string;
}

export interface ForbiddenLiteralRule {
  readonly literal: string;
  readonly patterns?: ReadonlyArray<string> | undefined;
  readonly excludeFiles?: ReadonlyArray<string> | undefined;
  readonly reason: string;
}

export interface InspectRules {
  readonly expectedExecutable: string;
  readonly forbiddenExecutablePrefix: string;
  readonly forbiddenFileNames: ReadonlyArray<string>;
  readonly required: ReadonlyArray<RequiredLiteralRule>;
  readonly forbidden: ReadonlyArray<ForbiddenLiteralRule>;
}

export interface InspectInput {
  readonly files: ReadonlyArray<string>;
  readonly resources: ReadonlyArray<NamedBytes>;
}

export type InspectProblem =
  | {
      readonly kind: "missing-executable";
      readonly executable: string;
    }
  | {
      readonly kind: "forbidden-executable";
      readonly file: string;
    }
  | {
      readonly kind: "forbidden-file";
      readonly name: string;
      readonly file: string;
    }
  | {
      readonly kind: "missing-literal";
      readonly literal: string;
      readonly reason: string;
    }
  | {
      readonly kind: "forbidden-literal";
      readonly literal: string;
      readonly file: string;
      readonly reason: string;
    };

export interface InspectResult {
  readonly ok: boolean;
  readonly requiredCount: number;
  readonly forbiddenCount: number;
  readonly problems: ReadonlyArray<InspectProblem>;
}

export class FactoryDesktopInspectError extends Schema.TaggedError<FactoryDesktopInspectError>()(
  "FactoryDesktopInspectError",
  {
    appPath: Schema.String,
    operation: Schema.Literals(["stat-app", "read-directory", "stat-entry", "read-file"]),
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.detail ? `: ${this.detail}` : "";
    return `factory-desktop-inspect: failed during ${this.operation} at ${this.appPath}${detail}`;
  }
}

const quotedForms = (literal: string): ReadonlyArray<string> => [
  `"${literal}"`,
  `'${literal}'`,
  `\`${literal}\``,
];

export const DEFAULT_INSPECT_RULES: InspectRules = {
  expectedExecutable: "T3 Factory v2.exe",
  forbiddenExecutablePrefix: "T3 Code",
  forbiddenFileNames: ["app-update.yml"],
  required: [
    {
      literal: "io.github.codeseys-labs.t3factory.v2",
      reason: "Windows AppUserModelID must identify T3 Factory v2 instead of stock T3 Code.",
    },
    {
      literal: "t3factory-v2",
      patterns: quotedForms("t3factory-v2"),
      reason: "Electron userData profile under %APPDATA% must be isolated to t3factory-v2.",
    },
    {
      literal: ".t3factory-v2",
      reason: "Default T3 home directory must be ~/.t3factory-v2 for desktop, server, and CLI.",
    },
    {
      literal: "t3code-factory",
      patterns: quotedForms("t3code-factory"),
      reason: "Registered custom link scheme must be t3code-factory so stock t3code stays intact.",
    },
    {
      literal: "https://github.com/Codeseys-Labs/t3factory/releases",
      reason: "Startup recovery releases link must point to Codeseys-Labs/t3factory releases.",
    },
    {
      literal: "T3 Factory could not start",
      reason: "Startup recovery failure window title must identify T3 Factory.",
    },
    {
      literal: "T3 Factory failed to start",
      reason: "Fatal startup error dialog title must identify T3 Factory.",
    },
    {
      literal: "t3code-factory://app",
      reason: "The server must trust the origin the Factory window loads from.",
    },
    {
      literal: "t3code-factory://pair",
      reason: "An app link printed by the bundled server must open Factory.",
    },
    {
      literal: "Codeseys-Labs/t3factory",
      patterns: quotedForms("Codeseys-Labs/t3factory"),
      reason: "The bundled t3 update and service must look for Factory releases.",
    },
  ],
  forbidden: [
    {
      literal: "com.t3tools.t3code",
      patterns: quotedForms("com.t3tools.t3code"),
      // macOS .mobileconfig template in server.asar keeps PayloadType "com.t3tools.t3code".
      excludeFiles: ["resources/server.asar"],
      reason: "Windows AppUserModelID must not remain stock com.t3tools.t3code in desktop.",
    },
    {
      literal: "t3code-v2",
      patterns: quotedForms("t3code-v2"),
      reason: "Electron userData profile folder must not remain stock t3code-v2.",
    },
    {
      literal: "T3 Code (Alpha)",
      // The packaged installer.nsh names this product too, so match only how the app's code holds it.
      patterns: ['["T3 Code (Alpha)"', 'legacy: "T3 Code (Alpha)"', 'legacy:"T3 Code (Alpha)"'],
      reason: "Factory must not read or take over stock T3 Code (Alpha) profiles or Local Storage.",
    },
    {
      literal: "https://github.com/pingdotgg/t3code/releases",
      patterns: quotedForms("https://github.com/pingdotgg/t3code/releases"),
      reason: "Startup recovery releases link must not point to stock pingdotgg/t3code releases.",
    },
    {
      literal: "T3 Code could not start",
      patterns: quotedForms("T3 Code could not start"),
      reason: "Startup recovery window title must not remain stock T3 Code could not start.",
    },
    {
      literal: "T3 Code failed to start",
      patterns: quotedForms("T3 Code failed to start"),
      // Web client bootError.ts in server.asar keeps the stock web fallback string.
      excludeFiles: ["resources/server.asar"],
      reason: "Desktop fatal error dialog title must not remain stock T3 Code failed to start.",
    },
    {
      literal: "pingdotgg/t3code",
      // The web client in server.asar names this repository for its star prompt, so match the
      // constant `t3 update` and the service download from, as the server and desktop bundles hold it.
      patterns: ['CLI_RELEASE_REPOSITORY = "pingdotgg/t3code"'],
      reason: "The bundled t3 update and service must not download a stock T3 Code runtime.",
    },
  ],
};

const normalizePath = (value: string): string => value.replaceAll("\\", "/");

const baseNameOf = (normalizedPath: string): string =>
  normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);

const isExcludedFile = (
  normalizedPath: string,
  excludeFiles: ReadonlyArray<string> | undefined,
): boolean => {
  if (excludeFiles === undefined || excludeFiles.length === 0) return false;
  const lowerPath = normalizedPath.toLowerCase();
  const lowerBase = baseNameOf(normalizedPath).toLowerCase();
  return excludeFiles.some((entry) => {
    const normalized = normalizePath(entry).toLowerCase();
    return lowerPath === normalized || lowerBase === normalized;
  });
};

export const scanDesktopApp = (
  input: InspectInput,
  rules: InspectRules = DEFAULT_INSPECT_RULES,
): InspectResult => {
  const problems: Array<InspectProblem> = [];
  const normalizedResources = input.resources.map((entry) => ({
    path: normalizePath(entry.path),
    buffer: NodeBuffer.Buffer.from(
      entry.bytes.buffer,
      entry.bytes.byteOffset,
      entry.bytes.byteLength,
    ),
  }));

  const allPathsSet = new Set<string>();
  for (const file of input.files) {
    allPathsSet.add(normalizePath(file));
  }
  for (const entry of normalizedResources) {
    allPathsSet.add(entry.path);
  }
  const allPaths = Array.from(allPathsSet).sort();

  const topLevelFiles = allPaths.filter((file) => !file.includes("/"));
  if (!topLevelFiles.includes(rules.expectedExecutable)) {
    problems.push({ kind: "missing-executable", executable: rules.expectedExecutable });
  }

  const forbiddenPrefixLower = rules.forbiddenExecutablePrefix.toLowerCase();
  for (const file of topLevelFiles) {
    const lower = file.toLowerCase();
    if (lower.startsWith(forbiddenPrefixLower) && lower.endsWith(".exe")) {
      problems.push({ kind: "forbidden-executable", file });
    }
  }

  const forbiddenNamesLower = new Map(
    rules.forbiddenFileNames.map((name) => [name.toLowerCase(), name] as const),
  );
  for (const file of allPaths) {
    const matchedName = forbiddenNamesLower.get(baseNameOf(file).toLowerCase());
    if (matchedName !== undefined) {
      problems.push({ kind: "forbidden-file", name: matchedName, file });
    }
  }

  for (const rule of rules.required) {
    const patterns = rule.patterns ?? [rule.literal];
    const needles = patterns.map((pattern) => NodeBuffer.Buffer.from(pattern, "utf8"));
    const found = normalizedResources.some((entry) =>
      needles.some((needle) => entry.buffer.includes(needle)),
    );
    if (!found) {
      problems.push({
        kind: "missing-literal",
        literal: rule.literal,
        reason: rule.reason,
      });
    }
  }

  for (const rule of rules.forbidden) {
    const patterns = rule.patterns ?? [rule.literal];
    const needles = patterns.map((pattern) => NodeBuffer.Buffer.from(pattern, "utf8"));
    for (const entry of normalizedResources) {
      if (isExcludedFile(entry.path, rule.excludeFiles)) continue;
      if (needles.some((needle) => entry.buffer.includes(needle))) {
        problems.push({
          kind: "forbidden-literal",
          literal: rule.literal,
          file: entry.path,
          reason: rule.reason,
        });
      }
    }
  }

  return {
    ok: problems.length === 0,
    requiredCount: rules.required.length,
    forbiddenCount: rules.forbidden.length,
    problems,
  };
};

export const formatInspectResult = (result: InspectResult): ReadonlyArray<string> => {
  if (result.ok) {
    return [
      `factory-desktop-inspect: ok (${result.requiredCount} required, ${result.forbiddenCount} forbidden)`,
    ];
  }
  return result.problems.map((problem) => {
    switch (problem.kind) {
      case "missing-executable":
        return `missing ${problem.executable}`;
      case "forbidden-executable":
        return `forbidden ${problem.file}`;
      case "forbidden-file":
        return `forbidden ${problem.name} in ${problem.file}`;
      case "missing-literal":
        return `missing ${problem.literal}`;
      case "forbidden-literal":
        return `forbidden ${problem.literal} in ${problem.file}`;
    }
  });
};

export const inspectDesktopApp = Effect.fn("factoryDesktopInspect.inspectDesktopApp")(function* (
  appPath: string,
  rules: InspectRules = DEFAULT_INSPECT_RULES,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedAppPath = path.resolve(appPath);

  const rootStat = yield* fs.stat(resolvedAppPath).pipe(Effect.option);
  if (Option.isNone(rootStat) || rootStat.value.type !== "Directory") {
    return yield* new FactoryDesktopInspectError({
      appPath: resolvedAppPath,
      operation: "stat-app",
      detail: "app path must be an existing directory",
    });
  }

  const entries = yield* fs.readDirectory(resolvedAppPath, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new FactoryDesktopInspectError({
          appPath: resolvedAppPath,
          operation: "read-directory",
          cause,
        }),
    ),
  );

  const files: Array<string> = [];
  const resources: Array<NamedBytes> = [];

  for (const entry of entries.sort()) {
    const absolute = path.join(resolvedAppPath, entry);
    const info = yield* fs.stat(absolute).pipe(
      Effect.mapError(
        (cause) =>
          new FactoryDesktopInspectError({
            appPath: absolute,
            operation: "stat-entry",
            cause,
          }),
      ),
    );
    if (info.type !== "File") continue;

    const relative = normalizePath(entry);
    files.push(relative);
    if (relative.startsWith("resources/")) {
      const bytes = yield* fs.readFile(absolute).pipe(
        Effect.mapError(
          (cause) =>
            new FactoryDesktopInspectError({
              appPath: absolute,
              operation: "read-file",
              cause,
            }),
        ),
      );
      resources.push({ path: relative, bytes });
    }
  }

  return scanDesktopApp({ files, resources }, rules);
});

const command = Command.make(
  "factory-desktop-inspect",
  {
    app: Flag.String("app").pipe(
      Flag.withDescription("Path to the unpacked desktop app directory to inspect."),
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the inspection result as JSON."),
      Flag.withDefault(false),
    ),
  },
  ({ app, json }) =>
    inspectDesktopApp(app).pipe(
      Effect.tap((result) =>
        json
          ? Console.log(JSON.stringify(result, null, 2))
          : Effect.forEach(formatInspectResult(result), (line) => Console.log(line), {
              discard: true,
            }),
      ),
      Effect.tap((result) =>
        result.ok
          ? Effect.void
          : Effect.sync(() => {
              process.exitCode = 1;
            }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Inspect an unpacked T3 Factory desktop build for identity isolation without executing it.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.catchTags({
      FactoryDesktopInspectError: (error) =>
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
