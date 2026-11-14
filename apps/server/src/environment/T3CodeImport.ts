import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  ProjectId,
  ProjectSettingsOverrides,
  ServerSettingsPatch,
  T3CodeImportError,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
  type T3CodeImportInput,
  type T3CodeImportPreview,
  type T3CodeImportProject,
  type T3CodeImportResult,
  type T3CodeImportSetting,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { secretFileName } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { mapSettingsSecrets } from "../settingsSecrets.ts";
import { separateT3CodeHome } from "./t3CodeHome.ts";

export class T3CodeImport extends Context.Service<
  T3CodeImport,
  {
    /** What T3 Code on this machine has that this install could add. Reads only. */
    readonly preview: Effect.Effect<T3CodeImportPreview, T3CodeImportError>;
    /** Adds what the preview calls new. Never changes or removes anything already here. */
    readonly apply: (
      input: T3CodeImportInput,
    ) => Effect.Effect<T3CodeImportResult, T3CodeImportError>;
  }
>()("t3/environment/T3CodeImport") {}

// Preferences worth carrying over. Left out on purpose: worktree locations and cleanup rules (they
// would point this install at T3 Code's worktrees or delete things), remote access and device
// hosts (tied to that install's identity), and internal migration flags.
const SCALAR_SETTINGS = [
  "favorites",
  "providerModelPreferences",
  "defaultModelSelection",
  "fallbackModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "removeAgentCreditsOnMerge",
  "sourceControlWritingStyle",
  "sourceControlWriterModelSelection",
  "reviewGuidesEnabled",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "pullRequestMergeMethod",
  "responseStreamingMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentBrowserAccess",
  "enableProviderUpdateChecks",
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleKeepPullRequests",
  "idleCompaction",
  "snoozeLimitedThreads",
  "autoResumeLimitedThreads",
  "snoozePresets",
  "addProjectBaseDirectory",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

// A project's own settings follow the same list, so cleanup rules stay behind there too.
const PROJECT_SETTINGS = new Set<string>(
  SCALAR_SETTINGS.filter((key) => key in ProjectSettingsOverrides.fields),
);

const PLAIN_MAP_SETTINGS = {
  usagePriceOverrides: "Price override",
  usageModelAliases: "Model alias",
} as const satisfies Partial<Record<keyof ServerSettings & keyof ServerSettingsPatch, string>>;

// One entry each, with any keys and tokens it keeps in T3 Code's secret store.
const SECRET_MAP_SETTINGS = {
  providerInstances: "Provider",
  sourceControlHosts: "Source control",
  usageLimitSources: "Usage limit source",
} as const satisfies Partial<Record<keyof ServerSettings & keyof ServerSettingsPatch, string>>;

/** Settings holding just this one decoded entry, so its secrets can be found and resolved. */
const singleSecretSetting = (
  key: keyof typeof SECRET_MAP_SETTINGS,
  patch: ServerSettingsPatch,
): ServerSettings | null => {
  switch (key) {
    case "providerInstances":
      return patch.providerInstances === undefined
        ? null
        : { ...DEFAULT_SERVER_SETTINGS, providerInstances: patch.providerInstances };
    case "sourceControlHosts":
      return patch.sourceControlHosts === undefined
        ? null
        : { ...DEFAULT_SERVER_SETTINGS, sourceControlHosts: patch.sourceControlHosts };
    case "usageLimitSources": {
      const sources = Object.entries(patch.usageLimitSources ?? {}).flatMap(([id, source]) =>
        source === null ? [] : [[id, source] as const],
      );
      return sources.length === 0
        ? null
        : { ...DEFAULT_SERVER_SETTINGS, usageLimitSources: Object.fromEntries(sources) };
    }
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
};

const RawSettings = fromLenientJson(Schema.Record(Schema.String, Schema.Unknown));
const decodeRawSettings = Schema.decodeUnknownExit(RawSettings);
const decodePatch = Schema.decodeUnknownExit(ServerSettingsPatch);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const ProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  scripts: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(Schema.String),
  defaultThreadEnvMode: Schema.NullOr(Schema.String),
  autoPull: Schema.NullOr(Schema.Number),
});
const decodeProjectRows = Schema.decodeUnknownEffect(Schema.Array(ProjectRow));

const decodeEntries = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeInstanceId = Schema.decodeUnknownOption(ProviderInstanceId);

/** Key order differs between a default and a decoded value; compare canonical JSON. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  ) ?? "undefined";

/** As the settings service reports them: the idle compaction mode has no stored default. */
const effective = (settings: ServerSettings): ServerSettings =>
  withIdleCompaction(settings, globalIdleCompaction(settings));
const DEFAULTS = effective(DEFAULT_SERVER_SETTINGS);

/**
 * T3 Code's settings for one project, from wherever its version keeps them. Before it folds
 * them into its settings file they sit on the project row and in three older maps; afterwards
 * those are stale copies, and reading them would bring back what the user reset.
 */
const sourceProjectSettings = (
  source: Readonly<Record<string, unknown>>,
  row: typeof ProjectRow.Type,
): Readonly<Record<string, unknown>> => {
  const own = (key: string) => Option.getOrUndefined(decodeEntries(source[key]))?.[row.projectId];
  const legacy: Record<string, unknown> = {};
  if (source.projectSettingsFolded !== true) {
    const model = Option.getOrNull(decodeJson(row.defaultModelSelection ?? "null"));
    if (model !== null) legacy.defaultModelSelection = model;
    // A null script override reset the project to the machine's scripts.
    const override = own("projectScriptOverrides");
    const onRow = Option.getOrNull(decodeJson(row.scripts ?? "[]"));
    const scripts =
      override === undefined ? (Array.isArray(onRow) && onRow.length > 0 ? onRow : null) : override;
    if (scripts !== null) legacy.defaultProjectScripts = scripts;
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree")
      legacy.defaultThreadEnvMode = row.defaultThreadEnvMode;
    const autoPull = own("projectAutoPullOverrides");
    if (autoPull !== undefined) legacy.defaultAutoPull = autoPull;
    else if (row.autoPull === 1) legacy.defaultAutoPull = true;
    const browserAccess = own("projectAgentBrowserAccessOverrides");
    if (browserAccess !== undefined) legacy.enableAgentBrowserAccess = browserAccess;
  }
  const stored = Option.getOrElse(decodeEntries(own("projectSettingsOverrides")), () => ({}));
  return Object.fromEntries(
    Object.entries({ ...legacy, ...stored }).filter(([key]) => PROJECT_SETTINGS.has(key)),
  );
};

const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type SettingWrite =
  | {
      readonly kind: "patch";
      /** Asked under the settings lock: null once this install has a value of its own. */
      readonly patch: (stored: ServerSettings) => ServerSettingsPatch | null;
    }
  | {
      readonly kind: "provider";
      readonly instanceId: ProviderInstanceId;
      readonly instance: ProviderInstanceConfig;
    };

interface PlannedSetting {
  readonly entry: T3CodeImportSetting;
  readonly write: SettingWrite | null;
}

type Plan =
  | { readonly status: "unavailable"; readonly preview: T3CodeImportPreview }
  | {
      readonly status: "available";
      readonly source: string;
      readonly projectsReadable: boolean;
      readonly projects: ReadonlyArray<T3CodeImportProject>;
      readonly settings: ReadonlyArray<PlannedSetting>;
    };

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const applying = yield* Semaphore.make(1);
  // Fixed for the server's lifetime: its own data folder cannot move while it runs.
  const sourceHome = yield* separateT3CodeHome(serverConfig.baseDir);
  const source =
    sourceHome === null
      ? null
      : yield* ServerConfig.deriveServerPaths(sourceHome, undefined, { baseDirIsExplicit: true });

  /** None when the database has a shape this version cannot read; settings still import. */
  const readSourceProjects = Effect.fn("T3CodeImport.readSourceProjects")(function* (
    dbPath: string,
  ) {
    if (!(yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))) return Option.some([]);
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The thread mode and auto-pull columns came later; a version without them has neither set.
      const columns = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM pragma_table_info('projection_projects')`;
      const ifPresent = (column: string) =>
        sql.literal(columns.some(({ name }) => name === column) ? column : "NULL");
      const rows = yield* sql`
        SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot",
          scripts_json AS "scripts", default_model_selection_json AS "defaultModelSelection",
          ${ifPresent("default_thread_env_mode")} AS "defaultThreadEnvMode",
          ${ifPresent("auto_pull")} AS "autoPull"
        FROM projection_projects
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC`;
      return yield* decodeProjectRows(rows);
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
      Effect.asSome,
      Effect.catch((cause) =>
        Effect.logWarning("could not read T3 Code's projects", { cause }).pipe(
          Effect.as(Option.none()),
        ),
      ),
    );
  });

  /** None when the file cannot be read or parsed; projects still import. */
  const readSourceSettings = Effect.fn("T3CodeImport.readSourceSettings")(function* (
    settingsPath: string,
  ) {
    if (!(yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false))))
      return Option.some({});
    const raw = yield* Effect.result(fs.readFileString(settingsPath));
    if (Result.isFailure(raw)) {
      yield* Effect.logWarning("could not read T3 Code's settings", { cause: raw.failure });
      return Option.none();
    }
    const decoded = decodeRawSettings(raw.success);
    return Exit.isSuccess(decoded) ? Option.some(decoded.value) : Option.none();
  });

  /**
   * Swaps T3 Code's secret placeholders for the values in its secret store. Null when a saved
   * key exists but cannot be read: importing the entry without it would leave a broken setup.
   */
  const resolveSecrets = Effect.fn("T3CodeImport.resolveSecrets")(function* (
    secretsDir: string,
    settings: ServerSettings,
  ) {
    const names: string[] = [];
    mapSettingsSecrets(settings, (secret) => {
      if (secret.redacted) names.push(secret.secretName);
      return secret;
    });
    const values = new Map<string, string>();
    for (const name of names) {
      const bytes = yield* Effect.result(fs.readFile(path.join(secretsDir, secretFileName(name))));
      if (Result.isSuccess(bytes)) values.set(name, new TextDecoder().decode(bytes.success));
      else if (bytes.failure.reason._tag !== "NotFound") {
        yield* Effect.logWarning("could not read a T3 Code secret", { cause: bytes.failure });
        return null;
      }
    }
    const resolved = mapSettingsSecrets(settings, (secret) =>
      secret.redacted ? { value: values.get(secret.secretName) ?? "", redacted: false } : secret,
    );
    return { resolved, secrets: values.size, missingSecrets: names.length - values.size };
  });

  const planProjects = Effect.fn("T3CodeImport.planProjects")(function* (
    sourceHome: string,
    rows: ReadonlyArray<typeof ProjectRow.Type>,
  ) {
    const inside = (root: string) => {
      const relative = path.relative(sourceHome, root);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    const planned: T3CodeImportProject[] = [];
    for (const row of rows) {
      // Scratch projects and other folders T3 Code manages itself stay with T3 Code.
      if (inside(row.workspaceRoot)) continue;
      const atRoot = yield* projects
        .getByWorkspaceRoot(row.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const byId = Option.isSome(atRoot)
        ? atRoot
        : yield* projects
            .getById(row.projectId, { includeDeleted: true })
            .pipe(Effect.orElseSucceed(() => Option.none()));
      const status: T3CodeImportProject["status"] = Option.isSome(atRoot)
        ? "present"
        : Option.isSome(byId)
          ? byId.value.deletedAt === null
            ? "present"
            : "removed-here"
          : (yield* fs.stat(row.workspaceRoot).pipe(
                Effect.map((info) => info.type === "Directory"),
                Effect.orElseSucceed(() => false),
              ))
            ? "new"
            : "missing-folder";
      planned.push({
        projectId: Option.isSome(atRoot) ? atRoot.value.id : row.projectId,
        title: row.title,
        workspaceRoot: row.workspaceRoot,
        status,
      });
    }
    return planned;
  });

  const planSettings = Effect.fn("T3CodeImport.planSettings")(function* (
    secretsDir: string,
    raw: Option.Option<Readonly<Record<string, unknown>>>,
    sourceProjects: ReadonlyArray<typeof ProjectRow.Type>,
    planned: ReadonlyArray<T3CodeImportProject>,
  ) {
    if (Option.isNone(raw))
      return [
        {
          entry: {
            key: "settings.json",
            label: "T3 Code's settings file",
            status: "unreadable",
            secrets: 0,
            missingSecrets: 0,
          },
          write: null,
        } satisfies PlannedSetting,
      ];
    const source = raw.value;
    const current = yield* settingsService.getSettings.pipe(
      Effect.mapError((cause) => new T3CodeImportError({ cause })),
    );
    const result: PlannedSetting[] = [];
    const plain = (item: {
      readonly key: string;
      readonly label: string;
      readonly setting: keyof ServerSettings & keyof ServerSettingsPatch;
      readonly value: unknown;
      /** This install already chose its own value, so T3 Code's is not wanted. */
      readonly ownValue: (here: ServerSettings) => boolean;
    }) => {
      const decoded = decodePatch({ [item.setting]: item.value });
      // Null also when the value here is already this one, or every import would "add" it again.
      const missing = (stored: ServerSettings) => {
        const here = effective(stored);
        if (Exit.isFailure(decoded) || item.ownValue(here)) return null;
        const next = applyServerSettingsPatch(here, decoded.value);
        return canonical(next[item.setting]) === canonical(here[item.setting])
          ? null
          : decoded.value;
      };
      result.push({
        entry: {
          key: item.key,
          label: item.label,
          status:
            missing(current) !== null
              ? "new"
              : Exit.isFailure(decoded) && !item.ownValue(effective(current))
                ? "unreadable"
                : "present",
          secrets: 0,
          missingSecrets: 0,
        },
        write: { kind: "patch", patch: missing },
      });
    };

    // Older T3 Code versions kept the idle compaction mode in `compactIdleThreads`.
    const legacyCompaction = decodePatch({ compactIdleThreads: source.compactIdleThreads });
    const scalars: Readonly<Record<string, unknown>> =
      "idleCompaction" in source ||
      Exit.isFailure(legacyCompaction) ||
      legacyCompaction.value.compactIdleThreads === undefined
        ? source
        : {
            ...source,
            idleCompaction: globalIdleCompaction({
              compactIdleThreads: legacyCompaction.value.compactIdleThreads,
            }),
          };
    for (const key of SCALAR_SETTINGS) {
      if (!(key in scalars)) continue;
      plain({
        key,
        label: humanize(key),
        setting: key,
        value: scalars[key],
        ownValue: (here) => canonical(here[key]) !== canonical(DEFAULTS[key]),
      });
    }

    for (const row of sourceProjects) {
      // T3 Code's project ids map to the project that holds the same folder here.
      const target = planned.find((project) => project.workspaceRoot === row.workspaceRoot);
      if (target === undefined || (target.status !== "present" && target.status !== "new"))
        continue;
      const value = sourceProjectSettings(source, row);
      if (Object.keys(value).length === 0) continue;
      const targetId = target.projectId;
      plain({
        key: `projectSettingsOverrides/${targetId}`,
        label: `Project settings: ${target.title}`,
        setting: "projectSettingsOverrides",
        value: { [targetId]: value },
        ownValue: (here) => Object.hasOwn(here.projectSettingsOverrides, targetId),
      });
    }

    for (const [key, label] of Object.entries(PLAIN_MAP_SETTINGS) as Array<
      [keyof typeof PLAIN_MAP_SETTINGS, string]
    >) {
      const entries = decodeEntries(source[key]);
      if (Option.isNone(entries)) continue;
      for (const [id, value] of Object.entries(entries.value))
        plain({
          key: `${key}/${id}`,
          label: `${label}: ${id}`,
          setting: key,
          value: { [id]: value },
          ownValue: (here) => Object.hasOwn(here[key], id),
        });
    }

    for (const [key, label] of Object.entries(SECRET_MAP_SETTINGS) as Array<
      [keyof typeof SECRET_MAP_SETTINGS, string]
    >) {
      const entries = decodeEntries(source[key]);
      if (Option.isNone(entries)) continue;
      for (const [id, value] of Object.entries(entries.value)) {
        const item = { key: `${key}/${id}`, label: `${label}: ${id}` };
        const ownValue = (here: ServerSettings) => Object.hasOwn(here[key], id);
        const decoded = decodePatch({ [key]: { [id]: value } });
        const single =
          Exit.isFailure(decoded) || ownValue(current)
            ? null
            : singleSecretSetting(key, decoded.value);
        if (single === null) {
          plain({ ...item, setting: key, value: { [id]: value }, ownValue });
          continue;
        }
        const secrets = yield* resolveSecrets(secretsDir, single);
        if (secrets === null) {
          result.push({
            entry: { ...item, status: "unreadable", secrets: 0, missingSecrets: 0 },
            write: null,
          });
          continue;
        }
        const { resolved } = secrets;
        const entry: T3CodeImportSetting = {
          ...item,
          status: "new",
          secrets: secrets.secrets,
          missingSecrets: secrets.missingSecrets,
        };
        if (key !== "providerInstances") {
          result.push({
            entry,
            write: {
              kind: "patch",
              patch: (stored) => (ownValue(stored) ? null : { [key]: resolved[key] }),
            },
          });
          continue;
        }
        const instanceId = decodeInstanceId(id);
        const instance = Option.isSome(instanceId)
          ? resolved.providerInstances[instanceId.value]
          : undefined;
        if (Option.isSome(instanceId) && instance !== undefined)
          result.push({
            entry,
            write: { kind: "provider", instanceId: instanceId.value, instance },
          });
      }
    }
    return result;
  });

  /** `settings: false` reads no settings or secrets, so a problem there cannot block projects. */
  const plan = Effect.fn("T3CodeImport.plan")(function* (options: { readonly settings: boolean }) {
    if (sourceHome === null || source === null)
      return {
        status: "unavailable",
        preview: { status: "unavailable", source: serverConfig.baseDir, reason: "same-data" },
      } satisfies Plan;
    const found = yield* Effect.forEach([source.settingsPath, source.dbPath], (file) =>
      fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
    );
    if (!found.some(Boolean))
      return {
        status: "unavailable",
        preview: { status: "unavailable", source: sourceHome, reason: "not-found" },
      } satisfies Plan;
    const read = yield* readSourceProjects(source.dbPath);
    const rows = Option.getOrElse(read, () => []);
    const plannedProjects = yield* planProjects(sourceHome, rows);
    return {
      status: "available",
      source: sourceHome,
      projectsReadable: Option.isSome(read),
      projects: plannedProjects,
      settings: options.settings
        ? yield* planSettings(
            source.secretsDir,
            yield* readSourceSettings(source.settingsPath),
            rows,
            plannedProjects,
          )
        : [],
    } satisfies Plan;
  });

  const preview: T3CodeImport["Service"]["preview"] = plan({ settings: true }).pipe(
    Effect.map((planned): T3CodeImportPreview =>
      planned.status === "unavailable"
        ? planned.preview
        : {
            status: "available",
            source: planned.source,
            projectsReadable: planned.projectsReadable,
            projects: planned.projects,
            settings: planned.settings.map((setting) => setting.entry),
          },
    ),
    Effect.withSpan("T3CodeImport.preview"),
  );

  /** False when this install got its own value after the plan; nothing was changed then. */
  const writeSetting = Effect.fn("T3CodeImport.writeSetting")(function* (write: SettingWrite) {
    if (write.kind === "provider") {
      // Fails rather than replaces when the instance exists by now.
      yield* settingsService.updateProviderInstance({
        operation: "create",
        instanceId: write.instanceId,
        instance: write.instance,
      });
      return true;
    }
    let added = false;
    yield* settingsService.updateSettingsWith((stored) => {
      const patch = write.patch(stored);
      added = patch !== null;
      return patch ?? {};
    });
    return added;
  });

  const apply: T3CodeImport["Service"]["apply"] = Effect.fn("T3CodeImport.apply")(
    function* (input) {
      const failed: Array<{ key: string; label: string }> = [];
      let projectsAdded = 0;
      let settingsAdded = 0;
      let secretsCopied = 0;
      if (input.projects) {
        const planned = yield* plan({ settings: false });
        for (const project of planned.status === "available" ? planned.projects : []) {
          if (project.status !== "new") continue;
          const created = yield* crypto.randomUUIDv4().pipe(
            Effect.flatMap((uuid) =>
              projects.create({
                commandId: CommandId.make(`t3code-import:${uuid}`),
                projectId: project.projectId,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
              }),
            ),
            Effect.result,
          );
          if (Result.isSuccess(created)) projectsAdded += 1;
          else failed.push({ key: `project/${project.projectId}`, label: project.title });
        }
      }
      if (input.settings) {
        // Planned after the projects above exist, so their own settings follow them.
        const planned = yield* plan({ settings: true });
        for (const setting of planned.status === "available" ? planned.settings : []) {
          if (setting.write === null || setting.entry.status !== "new") continue;
          const written = yield* Effect.result(writeSetting(setting.write));
          if (Result.isFailure(written))
            failed.push({ key: setting.entry.key, label: setting.entry.label });
          else if (written.success) {
            settingsAdded += 1;
            secretsCopied += setting.entry.secrets;
          }
        }
      }
      return { projectsAdded, settingsAdded, secretsCopied, failed };
    },
    (effect) => applying.withPermits(1)(effect),
  );

  return T3CodeImport.of({ preview, apply });
});

export const layer = Layer.effect(T3CodeImport, make);
