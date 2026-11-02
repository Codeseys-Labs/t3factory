import * as Schema from "effect/Schema";

export const roles = ["triage", "evidence", "coordination", "implementation", "review"] as const;
export const splits = ["development", "calibration", "holdout"] as const;
export const QualificationCase = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(roles),
  family: Schema.String,
  repositoryExample: Schema.String,
  severity: Schema.Literals(["critical", "major", "minor"]),
  difficulty: Schema.Literals(["routine", "difficult"]),
  split: Schema.Literals(splits),
  route: Schema.Literals(["mcp-replay", "test-signal", "decision-spec", "native-spec"]),
  source: Schema.Struct({
    origin: Schema.String,
    path: Schema.String,
    anchor: Schema.String,
    sha256: Schema.String,
  }),
  scenario: Schema.String,
  expectedActions: Schema.Array(Schema.String),
  forbiddenActions: Schema.Array(Schema.String),
  transitions: Schema.Array(Schema.String),
  execution: Schema.Struct({
    readiness: Schema.Literals(["ready", "blocked-fixture", "unrunnable-driver"]),
    driver: Schema.NullOr(Schema.String),
    reason: Schema.String,
    proves: Schema.String,
  }),
  reference: Schema.optional(Schema.Struct({ path: Schema.String, id: Schema.String })),
  specification: Schema.optional(
    Schema.Struct({
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
      task: Schema.String,
      acceptance: Schema.Array(
        Schema.Struct({
          gate: Schema.optional(
            Schema.Literals([
              "checkpoint",
              "native-identity",
              "behavior",
              "test-evidence",
              "ownership",
              "result-tree",
              "lifecycle",
              "preservation",
              "review",
              "decision",
            ]),
          ),
          artifact: Schema.String,
          assertion: Schema.String,
        }),
      ),
      missing: Schema.Array(Schema.String),
    }),
  ),
});
export type QualificationCase = typeof QualificationCase.Type;
