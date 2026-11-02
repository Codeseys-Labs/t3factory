#!/usr/bin/env node
// An eval script, not server code: it shells out to git and reads files directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { proxyConfig } from "../shared/proxy.ts";
import { cases, type Case } from "./cases.ts";
import { grade, type Comment } from "./grade.ts";
import { createFixtures, selectCases } from "./fixtures.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    preflight: { type: "boolean", default: false },
    inspect: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    prompt: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    concurrency: { type: "string", default: "6" },
    reasoning: { type: "string", default: "low" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <id>] [--prompt <file>].");
const outDirectory = values.out;
const models = values.model ?? ["gpt-6.1-terra", "gpt-6-luna"];
const repo = NodePath.resolve(import.meta.dirname, "../..");
const checkFile =
  values.prompt ?? NodePath.join(repo, ".macroscope/check-run-agents/test-signal.md");
// Macroscope gives the model the body; the front matter only configures the run.
const instructions = NodeFS.readFileSync(checkFile, "utf8")
  .replace(/^---\n[\s\S]*?\n---\n/, "")
  .trim();
const words = instructions.split(/\s+/).length;
const promptHash = NodeCrypto.createHash("sha256").update(instructions).digest("hex").slice(0, 12);
const selected = selectCases(cases, values.case);
const { world, readAt, grepAt, preflight } = createFixtures(repo);
if (values.preflight) {
  for (const entry of selected)
    preflight(entry, NodePath.join(outDirectory, entry.id), checkFile, values.inspect);
  process.stdout.write(
    `Offline preflight complete for ${selected.length} bounded fixture(s); no model qualification.\n`,
  );
  process.exit(0);
}
if (values.inspect) throw new Error("--inspect requires --preflight.");
const fixtures = new Map(selected.map((entry) => [entry.id, world(entry)]));
const proxy = proxyConfig();

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file at the pull request head, with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "integer" },
        end_line: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "grep",
    description:
      "Search the repository at the pull request head with an extended regular expression.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    type: "function",
    name: "post_comment",
    description: "Post an inline review comment on a line of the pull request head.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, line: { type: "integer" }, body: { type: "string" } },
      required: ["path", "line", "body"],
    },
  },
];

const system = (body: string) =>
  [
    "You are a Macroscope Check Run Agent reviewing a GitHub pull request.",
    "Follow the check instructions below. Read the repository at the pull request head with read_file and grep.",
    "Leave inline review comments with post_comment. Then give your final response.",
    "",
    "<check_instructions>",
    body,
    "</check_instructions>",
  ].join("\n");

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
    }),
  ),
);
const decodeArguments = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const post = Effect.fn("evaluateTestSignal.post")(function* (body: unknown) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/responses`).pipe(
    HttpClientRequest.setHeaders(proxy.headers),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});

const runSample = Effect.fn("evaluateTestSignal.sample")(function* (entry: Case, model: string) {
  const { diff, files, targets } = fixtures.get(entry.id)!;
  const comments: Array<Comment> = [];
  const input: Array<unknown> = [
    {
      role: "user",
      content: `Pull request diff for the files this check includes:\n\n\`\`\`diff\n${diff}\`\`\``,
    },
  ];
  let final = "";
  let tokens = 0;
  for (let step = 0; step < 16; step++) {
    const response = yield* post({
      model,
      instructions: system(instructions),
      input,
      tools,
      reasoning: { effort: values.reasoning },
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    tokens += response.usage?.total_tokens ?? 0;
    input.push(...response.output);
    const calls = response.output.filter((item) => item.type === "function_call");
    final = response.output
      .filter((item) => item.type === "message")
      .flatMap((item) => (item.content as Array<{ text?: string }>).map((part) => part.text ?? ""))
      .join("");
    if (calls.length === 0) break;
    for (const call of calls) {
      const args = decodeArguments(String(call.arguments));
      let output: string;
      if (call.name === "post_comment") {
        comments.push({
          path: String(args.path),
          line: Number(args.line),
          body: String(args.body),
        });
        output = "Posted.";
      } else if (call.name === "read_file") {
        const text = readAt(entry, files, String(args.path));
        const lines = text?.split("\n") ?? [];
        const start = Math.max(1, Number(args.start_line ?? 1));
        const end = Math.min(lines.length, Number(args.end_line ?? start + 399));
        output =
          text === undefined
            ? "File not found."
            : lines
                .slice(start - 1, end)
                .map((line, index) => `${start + index}: ${line}`)
                .join("\n");
      } else {
        output = grepAt(entry, files, String(args.pattern), String(args.path ?? ""));
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
  }
  return { ...grade({ kind: entry.kind, targets, comments, final }), comments, final, tokens };
});

const sampleSafely = (entry: Case, model: string, sample: number) =>
  runSample(entry, model).pipe(
    Effect.map((result) => ({ case: entry.id, kind: entry.kind, model, sample, ...result })),
    Effect.catchCause((cause) =>
      Effect.succeed({ case: entry.id, kind: entry.kind, model, sample, error: String(cause) }),
    ),
  );

type Row = Effect.Success<ReturnType<typeof sampleSafely>>;
const isGraded = (row: Row) => "pass" in row;
const passed = (row: Row) => "pass" in row && row.pass;

const summary = await Effect.runPromise(
  Effect.gen(function* () {
    NodeFS.mkdirSync(outDirectory, { recursive: true });
    const samples = Number(values.samples);
    const pairs = models.flatMap((model) => selected.map((entry) => ({ model, entry })));
    const rows: Array<Row> = (yield* Effect.forEach(
      pairs.flatMap(({ model, entry }) =>
        Array.from({ length: samples }, (_, n) => ({ model, entry, n })),
      ),
      ({ model, entry, n }) => sampleSafely(entry, model, n),
      { concurrency: Number(values.concurrency) },
    )).slice();
    // A third sample settles a split.
    const splits = pairs.filter(({ model, entry }) => {
      const own = rows.filter((row) => row.model === model && row.case === entry.id);
      return own.length === 2 && own.some(passed) && !own.every(passed);
    });
    rows.push(
      ...(yield* Effect.forEach(splits, ({ model, entry }) => sampleSafely(entry, model, samples), {
        concurrency: Number(values.concurrency),
      })),
    );
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.ndjson"),
      rows.map((row) => encodeRow(row)).join("\n") + "\n",
    );

    const lines = [`prompt ${promptHash}, ${words} words, ${checkFile}`, ""];
    lines.push("| model | bad caught | guards clean | errors | tokens |", "|---|---|---|---|---|");
    for (const model of models) {
      const verdicts = selected.map((entry) => {
        const own = rows.filter((row) => row.model === model && row.case === entry.id);
        // A run error counts as a failed sample, so one pass and one error is not a majority.
        const graded = own.filter(isGraded);
        const passes = own.filter(passed).length;
        return {
          entry,
          pass: passes > own.length / 2,
          errors: own.length - graded.length,
        };
      });
      const count = (kind: Case["kind"]) => {
        const own = verdicts.filter((verdict) => verdict.entry.kind === kind);
        return `${own.filter((verdict) => verdict.pass).length}/${own.length}`;
      };
      const tokens = rows
        .filter((row) => row.model === model && "tokens" in row)
        .reduce((sum, row) => sum + ("tokens" in row ? row.tokens : 0), 0);
      const errors = verdicts.reduce((sum, verdict) => sum + verdict.errors, 0);
      lines.push(`| ${model} | ${count("bad")} | ${count("guard")} | ${errors} | ${tokens} |`);
      const failed = verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.entry.id);
      if (failed.length > 0) lines.push(`|  failed: ${failed.join(", ")} | | | | |`);
    }
    const report = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
    return report;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(summary);
