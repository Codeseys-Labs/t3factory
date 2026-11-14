import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
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
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

// Keyed by T3 Code's project id; they follow their project to the id it has here.
const PROJECT_SETTINGS = {
  projectSettingsOverrides: "Project settings",
  projectScriptOverrides: "Project scripts",
  projectAutoPullOverrides: "Auto-pull",
  projectAgentBrowserAccessOverrides: "Agent browser access",
} as const satisfies Partial<Record<keyof ServerSettings & keyof ServerSettingsPatch, string>>;

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
const decodeScripts = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelection = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);
const ProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  scripts: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(Schema.String),
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

const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

interface PlannedProject {
  readonly entry: T3CodeImportProject;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly defaultModelSelection: ModelSelection | null | undefined;
}

type SettingWrite =
  | { readonly kind: "patch"; readonly patch: ServerSettingsPatch }
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
      readonly projects: ReadonlyArray<PlannedProject>;
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
      // Only columns every T3 Code version since projects moved to this table has.
      const rows = yield* sql`
        SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot",
          scripts_json AS "scripts", default_model_selection_json AS "defaultModelSelection"
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

  const readSourceSettings = Effect.fn("T3CodeImport.readSourceSettings")(function* (
    settingsPath: string,
  ) {
    if (!(yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false))))
      return Option.some({});
    const raw = yield* fs
      .readFileString(settingsPath)
      .pipe(
        Effect.mapError((cause) => new T3CodeImportError({ operation: "read-settings", cause })),
      );
    const decoded = decodeRawSettings(raw);
    return Exit.isSuccess(decoded) ? Option.some(decoded.value) : Option.none();
  });

  /** Swaps T3 Code's secret placeholders for the values in its secret store. */
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
      const bytes = yield* fs.readFile(path.join(secretsDir, secretFileName(name))).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeedNone
            : Effect.fail(new T3CodeImportError({ operation: "read-secret", cause })),
        ),
      );
      if (Option.isSome(bytes)) values.set(name, new TextDecoder().decode(bytes.value));
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
    const planned: PlannedProject[] = [];
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
      const scripts = row.scripts === null ? Option.none() : decodeScripts(row.scripts);
      const model =
        row.defaultModelSelection === null
          ? Option.none()
          : decodeModelSelection(row.defaultModelSelection);
      planned.push({
        entry: {
          projectId: Option.isSome(atRoot) ? atRoot.value.id : row.projectId,
          title: row.title,
          workspaceRoot: row.workspaceRoot,
          status,
        },
        scripts: Option.getOrUndefined(scripts),
        defaultModelSelection: Option.getOrUndefined(model),
      });
    }
    return planned;
  });

  const planSettings = Effect.fn("T3CodeImport.planSettings")(function* (
    secretsDir: string,
    raw: Option.Option<Readonly<Record<string, unknown>>>,
    sourceProjects: ReadonlyArray<typeof ProjectRow.Type>,
    planned: ReadonlyArray<PlannedProject>,
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
      Effect.mapError((cause) => new T3CodeImportError({ operation: "read-settings", cause })),
    );
    const result: PlannedSetting[] = [];
    const plain = (key: string, label: string, fragment: unknown, present: boolean) => {
      const patch = decodePatch(fragment);
      result.push({
        entry: {
          key,
          label,
          status: present ? "present" : Exit.isSuccess(patch) ? "new" : "unreadable",
          secrets: 0,
          missingSecrets: 0,
        },
        write: !present && Exit.isSuccess(patch) ? { kind: "patch", patch: patch.value } : null,
      });
    };

    for (const key of SCALAR_SETTINGS) {
      if (!(key in source)) continue;
      const present = canonical(current[key]) !== canonical(DEFAULT_SERVER_SETTINGS[key]);
      plain(key, humanize(key), { [key]: source[key] }, present);
    }

    // T3 Code's project ids map to the project that holds the same folder here.
    const targetIds = new Map<string, ProjectId>();
    for (const project of planned) {
      if (project.entry.status !== "present" && project.entry.status !== "new") continue;
      const sourceRow = sourceProjects.find(
        (row) => row.workspaceRoot === project.entry.workspaceRoot,
      );
      if (sourceRow !== undefined) targetIds.set(sourceRow.projectId, project.entry.projectId);
    }
    for (const [key, label] of Object.entries(PROJECT_SETTINGS) as Array<
      [keyof typeof PROJECT_SETTINGS, string]
    >) {
      const entries = decodeEntries(source[key]);
      if (Option.isNone(entries)) continue;
      for (const [sourceId, value] of Object.entries(entries.value)) {
        const targetId = targetIds.get(sourceId);
        const project = planned.find((entry) => entry.entry.projectId === targetId);
        if (targetId === undefined || project === undefined) continue;
        plain(
          `${key}/${targetId}`,
          `${label}: ${project.entry.title}`,
          { [key]: { [targetId]: value } },
          Object.hasOwn(current[key], targetId),
        );
      }
    }

    for (const [key, label] of Object.entries(PLAIN_MAP_SETTINGS) as Array<
      [keyof typeof PLAIN_MAP_SETTINGS, string]
    >) {
      const entries = decodeEntries(source[key]);
      if (Option.isNone(entries)) continue;
      for (const [id, value] of Object.entries(entries.value))
        plain(
          `${key}/${id}`,
          `${label}: ${id}`,
          { [key]: { [id]: value } },
          Object.hasOwn(current[key], id),
        );
    }

    for (const [key, label] of Object.entries(SECRET_MAP_SETTINGS) as Array<
      [keyof typeof SECRET_MAP_SETTINGS, string]
    >) {
      const entries = decodeEntries(source[key]);
      if (Option.isNone(entries)) continue;
      for (const [id, value] of Object.entries(entries.value)) {
        const itemKey = `${key}/${id}`;
        const itemLabel = `${label}: ${id}`;
        const fragment = { [key]: { [id]: value } };
        const decoded = decodePatch(fragment);
        const single =
          Exit.isFailure(decoded) || Object.hasOwn(current[key], id)
            ? null
            : singleSecretSetting(key, decoded.value);
        if (single === null) {
          plain(itemKey, itemLabel, fragment, Object.hasOwn(current[key], id));
          continue;
        }
        const { resolved, secrets, missingSecrets } = yield* resolveSecrets(secretsDir, single);
        const entry: T3CodeImportSetting = {
          key: itemKey,
          label: itemLabel,
          status: "new",
          secrets,
          missingSecrets,
        };
        if (key !== "providerInstances") {
          result.push({ entry, write: { kind: "patch", patch: { [key]: resolved[key] } } });
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

  const plan = Effect.gen(function* () {
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
    const raw = yield* readSourceSettings(source.settingsPath);
    const plannedSettings = yield* planSettings(source.secretsDir, raw, rows, plannedProjects);
    return {
      status: "available",
      source: sourceHome,
      projectsReadable: Option.isSome(read),
      projects: plannedProjects,
      settings: plannedSettings,
    } satisfies Plan;
  }).pipe(Effect.withSpan("T3CodeImport.plan"));

  const preview: T3CodeImport["Service"]["preview"] = plan.pipe(
    Effect.map((planned): T3CodeImportPreview =>
      planned.status === "unavailable"
        ? planned.preview
        : {
            status: "available",
            source: planned.source,
            projectsReadable: planned.projectsReadable,
            projects: planned.projects.map((project) => project.entry),
            settings: planned.settings.map((setting) => setting.entry),
          },
    ),
    Effect.withSpan("T3CodeImport.preview"),
  );

  const apply: T3CodeImport["Service"]["apply"] = Effect.fn("T3CodeImport.apply")(
    function* (input) {
      const failed: Array<{ key: string; label: string }> = [];
      let projectsAdded = 0;
      let settingsAdded = 0;
      let secretsCopied = 0;
      const first = yield* plan;
      if (first.status === "unavailable")
        return { projectsAdded, settingsAdded, secretsCopied, failed };
      if (input.projects) {
        for (const project of first.projects) {
          if (project.entry.status !== "new") continue;
          const created = yield* crypto.randomUUIDv4().pipe(
            Effect.flatMap((uuid) =>
              projects.create({
                commandId: CommandId.make(`t3code-import:${uuid}`),
                projectId: project.entry.projectId,
                title: project.entry.title,
                workspaceRoot: project.entry.workspaceRoot,
                ...(project.scripts === undefined ? {} : { scripts: project.scripts }),
                ...(project.defaultModelSelection === undefined
                  ? {}
                  : { defaultModelSelection: project.defaultModelSelection }),
              }),
            ),
            Effect.result,
          );
          if (created._tag === "Success") projectsAdded += 1;
          else
            failed.push({ key: `project/${project.entry.projectId}`, label: project.entry.title });
        }
      }
      if (input.settings) {
        // Planned again so settings of projects added above follow them.
        const second = input.projects ? yield* plan : first;
        if (second.status === "available") {
          for (const setting of second.settings) {
            if (setting.write === null || setting.entry.status !== "new") continue;
            const { write } = setting;
            const written = yield* (
              write.kind === "provider"
                ? settingsService.updateProviderInstance({
                    operation: "create",
                    instanceId: write.instanceId,
                    instance: write.instance,
                  })
                : settingsService.updateSettings(write.patch)
            ).pipe(Effect.result);
            if (written._tag === "Success") {
              settingsAdded += 1;
              secretsCopied += setting.entry.secrets;
            } else failed.push({ key: setting.entry.key, label: setting.entry.label });
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
