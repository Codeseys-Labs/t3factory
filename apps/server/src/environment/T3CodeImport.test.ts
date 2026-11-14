import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3CodeImport from "./T3CodeImport.ts";

const codex = ProviderInstanceId.make("codex");
const at = (minute: number) => `2026-11-01T00:0${minute}:00.000Z`;

const layerFor = (input: {
  readonly home: string;
  readonly baseDir: string | { readonly prefix: string };
}) =>
  T3CodeImport.layer.pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
    ),
    Layer.provideMerge(
      Layer.merge(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          invalidate: () => Effect.void,
          resolvePath: () => Effect.succeed(null),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      ServerSettings.layerTest({
        branchNamePrefix: "factory",
        providerInstances: { [codex]: { driver: ProviderDriverKind.make("codex") } },
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, input.home)),
    Layer.provideMerge(NodeCrypto.layer),
  );

/** T3 Code's data as its own server leaves it: sparse settings, a secret file and its database. */
const writeT3Code = Effect.fn("test.writeT3Code")(function* (
  home: string,
  input: {
    readonly settings: unknown;
    readonly secrets: Readonly<Record<string, string>>;
    readonly projects: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly root: string;
      readonly scripts?: unknown;
    }>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userdata = path.join(home, ".t3", "userdata");
  yield* fs.makeDirectory(path.join(userdata, "secrets"), { recursive: true });
  yield* fs.writeFileString(path.join(userdata, "settings.json"), JSON.stringify(input.settings));
  for (const [name, value] of Object.entries(input.secrets))
    yield* fs.writeFileString(path.join(userdata, "secrets", `${name}.bin`), value);
  yield* Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    for (const [index, project] of input.projects.entries())
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root,
        default_model_selection_json, default_thread_env_mode, auto_pull, favicon_path,
        project_icon_json, scripts_json, created_at, updated_at, deleted_at)
        VALUES (${project.id}, ${project.title}, ${project.root}, NULL, NULL, 0, NULL, NULL,
          ${JSON.stringify(project.scripts ?? [])}, ${at(index)}, ${at(index)}, NULL)`;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: path.join(userdata, "statev2.sqlite") })),
  );
});

const envSecretName = (instanceId: string, variable: string) =>
  `provider-env-${Buffer.from(instanceId).toString("base64url")}-${Buffer.from(variable).toString("base64url")}`;

it.effect(
  "imports only what is missing here, carries saved keys, and a second run adds nothing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-import-home-" });
      const folder = (name: string) => path.join(home, "code", name);
      for (const name of ["alpha", "beta", "delta"])
        yield* fs.makeDirectory(folder(name), { recursive: true });
      const scratch = path.join(home, ".t3", "scratch", "notes");
      yield* fs.makeDirectory(scratch, { recursive: true });
      const script = {
        id: "test",
        name: "Test",
        command: "vp test",
        icon: "test",
        runOnWorktreeCreate: false,
      };
      yield* writeT3Code(home, {
        settings: {
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
          branchNamePrefix: "t3",
          // Points at T3 Code's own worktrees; never imported.
          worktreesDirectory: path.join(home, ".t3", "worktrees"),
          providerInstances: {
            codex: { driver: "codex", enabled: false },
            omp: {
              driver: "acpRegistry",
              environment: [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
            },
          },
          projectSettingsOverrides: {
            alpha: { defaultRuntimeMode: "approval-required" },
            beta: { defaultRuntimeMode: "auto" },
            gamma: { defaultRuntimeMode: "auto" },
          },
        },
        secrets: { [envSecretName("omp", "API_KEY")]: "sk-imported" },
        projects: [
          { id: "alpha", title: "Alpha", root: folder("alpha"), scripts: [script] },
          { id: "beta", title: "Beta", root: folder("beta") },
          { id: "gamma", title: "Gamma", root: folder("gamma") },
          { id: "delta", title: "Delta", root: folder("delta") },
          { id: "scratch", title: "Notes", root: scratch },
        ],
      });

      yield* Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const service = yield* T3CodeImport.T3CodeImport;
        // This install already has Beta under another id, and imported then removed Delta.
        yield* projects.create({
          commandId: CommandId.make("create-beta"),
          projectId: ProjectId.make("beta-here"),
          title: "Beta here",
          workspaceRoot: folder("beta"),
        });
        yield* projects.create({
          commandId: CommandId.make("create-delta"),
          projectId: ProjectId.make("delta"),
          title: "Delta",
          workspaceRoot: folder("delta"),
        });
        yield* projects.delete({
          commandId: CommandId.make("delete-delta"),
          projectId: ProjectId.make("delta"),
        });

        const preview = yield* service.preview;
        assert.equal(preview.status, "available");
        if (preview.status !== "available") return;
        assert.deepEqual(
          preview.projects.map((project) => [project.projectId, project.status]),
          [
            ["alpha", "new"],
            ["beta-here", "present"],
            ["gamma", "missing-folder"],
            ["delta", "removed-here"],
          ],
        );
        assert.deepEqual(
          preview.settings.map((setting) => [setting.key, setting.status, setting.secrets]),
          [
            ["defaultModelSelection", "new", 0],
            ["branchNamePrefix", "present", 0],
            ["projectSettingsOverrides/alpha", "new", 0],
            ["projectSettingsOverrides/beta-here", "new", 0],
            ["providerInstances/codex", "present", 0],
            ["providerInstances/omp", "new", 1],
          ],
        );

        const result = yield* service.apply({ projects: true, settings: true });
        assert.deepEqual(result, {
          projectsAdded: 1,
          settingsAdded: 4,
          secretsCopied: 1,
          failed: [],
        });
        const alpha = Option.getOrThrow(yield* projects.getById(ProjectId.make("alpha")));
        assert.deepEqual(
          [alpha.title, alpha.workspaceRoot, alpha.scripts],
          ["Alpha", folder("alpha"), [script]],
        );
        const after = yield* settings.getSettings;
        assert.deepEqual(after.defaultModelSelection, { instanceId: codex, model: "gpt-5.4" });
        assert.equal(after.branchNamePrefix, "factory");
        assert.equal(after.worktreesDirectory, DEFAULT_SERVER_SETTINGS.worktreesDirectory);
        assert.equal(after.providerInstances[codex]?.enabled, undefined);
        assert.deepEqual(after.providerInstances[ProviderInstanceId.make("omp")]?.environment, [
          { name: "API_KEY", value: "sk-imported", sensitive: true },
        ]);
        assert.deepEqual(
          [
            after.projectSettingsOverrides[ProjectId.make("alpha")]?.defaultRuntimeMode,
            after.projectSettingsOverrides[ProjectId.make("beta-here")]?.defaultRuntimeMode,
          ],
          ["approval-required", "auto"],
        );

        const again = yield* service.preview;
        assert.deepEqual(
          again.status === "available"
            ? [...again.projects, ...again.settings].filter((item) => item.status === "new")
            : null,
          [],
        );
        assert.deepEqual(yield* service.apply({ projects: true, settings: true }), {
          projectsAdded: 0,
          settingsAdded: 0,
          secretsCopied: 0,
          failed: [],
        });
      }).pipe(Effect.provide(layerFor({ home, baseDir: { prefix: "t3code-import-factory-" } })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "offers nothing when this server keeps its data in T3 Code's folder or T3 Code has none",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-import-home-" });
      const preview = (baseDir: string | { readonly prefix: string }) =>
        Effect.flatMap(T3CodeImport.T3CodeImport, (service) => service.preview).pipe(
          Effect.provide(layerFor({ home, baseDir })),
        );
      assert.deepEqual(yield* preview({ prefix: "t3code-import-factory-" }), {
        status: "unavailable",
        source: path.join(home, ".t3"),
        reason: "not-found",
      });
      const shared = path.join(home, ".t3");
      assert.deepEqual(yield* preview(shared), {
        status: "unavailable",
        source: shared,
        reason: "same-data",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
