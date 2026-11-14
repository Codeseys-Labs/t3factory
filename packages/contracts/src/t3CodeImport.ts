import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * What a separate T3 install (T3 Factory) can bring over from T3 Code's data on the same machine.
 * Import only fills gaps: it never changes or removes anything this install already has.
 */
export const T3CodeImportProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  /**
   * `present`: a project here already uses the folder. `removed-here`: imported before and then
   * removed here, so it stays removed. `missing-folder`: the folder is gone from disk.
   */
  status: Schema.Literals(["new", "present", "removed-here", "missing-folder"]),
});
export type T3CodeImportProject = typeof T3CodeImportProject.Type;

export const T3CodeImportSetting = Schema.Struct({
  /** Stable identity of one importable value, such as `providerInstances/codex`. */
  key: Schema.String,
  label: Schema.String,
  /** `present`: this install already has its own value. `unreadable`: T3 Code's value no longer decodes here. */
  status: Schema.Literals(["new", "present", "unreadable"]),
  /** Saved keys and tokens that come with the value; read from T3 Code's secret store. */
  secrets: NonNegativeInt,
  /** Keys T3 Code's settings refer to but its secret store no longer holds. */
  missingSecrets: NonNegativeInt,
});
export type T3CodeImportSetting = typeof T3CodeImportSetting.Type;

export const T3CodeImportPreview = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    source: Schema.String,
    /** False when T3 Code's database is from a version whose project list this one cannot read. */
    projectsReadable: Schema.Boolean,
    projects: Schema.Array(T3CodeImportProject),
    settings: Schema.Array(T3CodeImportSetting),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    source: Schema.String,
    /** `same-data`: this server already stores its data in T3 Code's folder. */
    reason: Schema.Literals(["not-found", "same-data"]),
  }),
]);
export type T3CodeImportPreview = typeof T3CodeImportPreview.Type;

export const T3CodeImportInput = Schema.Struct({
  projects: Schema.Boolean,
  settings: Schema.Boolean,
});
export type T3CodeImportInput = typeof T3CodeImportInput.Type;

export const T3CodeImportResult = Schema.Struct({
  projectsAdded: NonNegativeInt,
  settingsAdded: NonNegativeInt,
  secretsCopied: NonNegativeInt,
  /** Items that were new in the preview but could not be added; importing again retries them. */
  failed: Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String })),
});
export type T3CodeImportResult = typeof T3CodeImportResult.Type;

export class T3CodeImportError extends Schema.TaggedError<T3CodeImportError>()(
  "T3CodeImportError",
  {
    operation: Schema.Literals(["read-settings", "read-secret"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not import from T3 Code (${this.operation}).`;
  }
}
