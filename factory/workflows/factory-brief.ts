// A knowledge task as durable work: an agent writes a brief from a frozen copy of the request, a
// critic may check it, a person accepts the exact file by its sha256, and it may go on the issue.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  FactoryTaskRunInput,
  ModelChoice,
  PackConfig,
  addNote,
  capturedKey,
  isStored,
  readAll,
  readConfig,
  resolveTarget,
  rootPool,
  taskTags,
  writeArtifact,
  writeReceipt,
} from "./lib/records.ts";

const { workflow, step, agent, ask, sleep, stop, title, tags, within, issues, store, IssueDetail } =
  T3;

const FACTORY_BRIEF = "factory-brief";
const PREFIX = "factory/v1/";
const CONFIG_KEY = `${PREFIX}config`;
const MAX_BRIEF_BYTES = 5 * 1024 * 1024;
const ISSUE_BODY_MAX = 8000;
const CITATIONS_MAX = 50;
const PREVIEW_CHARS = 2000;
const COMMENT_MAX = 60_000;
// The wire's bounds (packages/contracts), which a workflow file cannot import.
const PATH_MAX = 1024;
const REASON_MAX = 4000;
// How far a tracker's clock may trail ours when it stamps a comment.
const CLOCK_SLACK_MS = 5 * 60 * 1000;
// Fails on bytes that are not UTF-8 rather than putting U+FFFD in their place.
const UTF8 = new TextDecoder("utf-8", { fatal: true });
// Why a read of the issue leaves it open whether the brief is on it.
const UNSURE = {
  edited: "a comment with the delivery marker no longer matches the brief",
  suspect: "a comment by this account since the delivery began has no delivery marker",
  unknown: "the issue's newest comments do not reach back to when the delivery began",
} as const;

const BriefDelivery = Schema.Literals(["none", "issue-comment"]);

const BriefFields = Schema.Struct({
  critiqueModel: Schema.optionalKey(Schema.NullOr(ModelChoice)),
  briefDelivery: Schema.optionalKey(BriefDelivery),
});
const decodeBriefFields = Schema.decodeUnknownEffect(BriefFields);

const BriefConfig = Schema.Struct({
  ...PackConfig.fields,
  critiqueModel: Schema.NullOr(ModelChoice),
  briefDelivery: BriefDelivery,
});

const Frozen = Schema.Struct({ text: Schema.String, sha256: Schema.String });

const Draft = Schema.Struct({
  path: Schema.String,
  summary: Schema.String,
  citations: Schema.Array(Schema.String).check(Schema.isMaxLength(CITATIONS_MAX)),
});
type Written = typeof Draft.Type;

const Hashed = Schema.Struct({
  sha256: Schema.String,
  bytes: Schema.Number,
  preview: Schema.String,
});

const Critique = Schema.Struct({
  verdict: Schema.Literals(["pass", "revise"]),
  unsupported: Schema.Array(Schema.String).check(Schema.isMaxLength(CITATIONS_MAX)),
  notes: Schema.String,
});
type CritiqueNote = typeof Critique.Type & { readonly sha256: string };

const Body = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("ready"), text: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("changed"), reason: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("too-large") }),
]);

const Intent = Schema.Struct({
  v: Schema.Literal(1),
  intentAt: Schema.Number,
  marker: Schema.String,
});

/** Written before a post is sent, so a step run again after a crash never sends it twice. */
const SendClaim = Schema.Struct({ intentAt: Schema.Number, sha256: Schema.String });

const DeliveredReceipt = Schema.Struct({
  kind: Schema.Literal("delivered"),
  sha256: Schema.String,
});

const Posted = Schema.Literals(["delivered", "posted", "ask"]);

const BriefResult = Schema.Struct({
  outcome: Schema.Literals(["accepted", "delivered", "uncertain"]),
  sha256: Schema.String,
  path: Schema.String,
});

type Listing = Pick<typeof IssueDetail.Type, "viewer" | "comments" | "commentsCursor">;
type ListedComment = Listing["comments"][number];
type ReceiptFields = Pick<Parameters<typeof writeReceipt>[0], "sha256" | "kind" | "by" | "detail">;

/** A config row's brief fields; a row that is there and does not decode fails, naming its key. */
const readBriefFields = Effect.fn("factoryBrief.readBriefFields")(function* (key: string) {
  const found = yield* store.entry(key, Schema.Json).get;
  if (Option.isNone(found)) return {};
  return yield* decodeBriefFields(found.value).pipe(
    Effect.mapError((error) => `The Factory config at ${key} is not valid: ${error.message}`),
  );
});

/** The pack's config with the brief's own fields, from the same rows and in the same order. */
const readBriefConfig = Effect.fn("factoryBrief.readBriefConfig")(function* (
  projectId: string | null,
) {
  const pack = yield* readConfig(projectId);
  const global = yield* readBriefFields(CONFIG_KEY);
  const project = projectId === null ? {} : yield* readBriefFields(`${CONFIG_KEY}/${projectId}`);
  const config: typeof BriefConfig.Type = {
    critiqueModel: null,
    briefDelivery: "none",
    ...global,
    ...project,
    ...pack,
  };
  return config;
});

/** The request as this attempt answers it, stored inline so later edits to the task leave it. */
const freeze = Effect.fn("factoryBrief.freeze")(function* (
  input: FactoryTaskRunInput,
  project: string,
  runId: string,
) {
  const issueUrl = input.issueUrl;
  const issue =
    issueUrl === null
      ? []
      : [
          "",
          `Issue ${issueUrl}:`,
          "",
          (yield* issues.read({ project, url: issueUrl })).body.slice(0, ISSUE_BODY_MAX),
        ];
  const text = [
    `# ${input.title}`,
    ...(input.description.trim() === "" ? [] : ["", input.description]),
    ...issue,
  ].join("\n");
  const sha256 = NodeCrypto.createHash("sha256").update(text).digest("hex");
  yield* writeArtifact({
    taskId: input.taskId,
    attempt: input.attempt,
    sha256,
    kind: "brief",
    location: { _tag: "inline", text },
    bytes: Buffer.byteLength(text),
    label: `T-${input.number} request`,
    step: "freeze",
    runId,
  });
  return { text, sha256 };
});

/**
 * The regular file at the absolute `filePath` as UTF-8 text of at most `MAX_BRIEF_BYTES`, with the
 * sha256 and size of those same bytes, so what is hashed is what is shown and posted.
 */
const readBrief = Effect.fn("factoryBrief.readBrief")(function* (filePath: string) {
  if (!NodePath.isAbsolute(filePath) || filePath.length > PATH_MAX) {
    return yield* Effect.fail(
      `${filePath} is not an absolute path of at most ${PATH_MAX} characters.`,
    );
  }
  const unreadable = (cause: unknown) =>
    `${filePath} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  const info = yield* Effect.tryPromise({ try: () => NodeFSP.stat(filePath), catch: unreadable });
  if (!info.isFile()) return yield* Effect.fail(`${filePath} is not a regular file.`);
  const tooLarge = `${filePath} is larger than ${MAX_BRIEF_BYTES} bytes.`;
  if (info.size > MAX_BRIEF_BYTES) return yield* Effect.fail(tooLarge);
  const content = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(filePath),
    catch: unreadable,
  });
  // It may have grown since the `stat`.
  if (content.byteLength > MAX_BRIEF_BYTES) return yield* Effect.fail(tooLarge);
  const text = yield* Effect.try({
    try: () => UTF8.decode(content),
    catch: () => `${filePath} is not UTF-8 text.`,
  });
  return {
    sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    text,
  };
});

/** The file recorded as the deliverable: its sha256, its size and the start of its text. */
const recordDeliverable = Effect.fn("factoryBrief.recordDeliverable")(function* (
  input: FactoryTaskRunInput,
  filePath: string,
  at: string,
  runId: string,
) {
  const { sha256, bytes, text } = yield* readBrief(filePath);
  yield* writeArtifact({
    taskId: input.taskId,
    attempt: input.attempt,
    sha256,
    kind: "deliverable",
    location: { _tag: "file", path: filePath },
    bytes,
    label: `T-${input.number} brief`,
    step: at,
    runId,
  });
  return { sha256, bytes, preview: text.slice(0, PREVIEW_CHARS) };
});

/**
 * The delivery's intent, written once so its time never moves on replay, or null when a receipt
 * already says this content was delivered on the task's issue.
 */
const recordIntent = Effect.fn("factoryBrief.recordIntent")(function* (
  taskId: string,
  sha256: string,
  marker: string,
) {
  return yield* store.transaction(
    Effect.gen(function* () {
      const receipts = yield* readAll(`${PREFIX}receipt/${taskId}/`, DeliveredReceipt);
      if (receipts.some((row) => row.value.sha256 === sha256)) return null;
      const entry = store.entry(`${PREFIX}delivery/${taskId}/${sha256}`, Intent);
      const stored = yield* entry.get;
      if (Option.isSome(stored)) return stored.value;
      const intentAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const intent = { v: 1, intentAt, marker } as const;
      yield* entry.set(intent);
      return intent;
    }),
  );
});

/**
 * The comment carrying `marker` that still reads as `expected`, or whether every one carrying it
 * was edited: an edited comment is no proof that the brief is on the issue.
 */
const posted = (listing: Listing, marker: string, expected: string) => {
  const want = expected.replaceAll("\r\n", "\n").trim();
  const marked = listing.comments.filter((comment) => comment.body.includes(marker));
  const intact = marked.find((comment) => comment.body.replaceAll("\r\n", "\n").trim() === want);
  if (intact !== undefined) return { kind: "found", comment: intact } as const;
  return { kind: marked.length === 0 ? "none" : "edited" } as const;
};

/**
 * What the issue's newest comments say about the post. Only a listing that reaches back past the
 * intent, less the clock slack, shows that nothing was posted.
 */
const classify = (listing: Listing, marker: string, expected: string, intentAt: number) => {
  const seen = posted(listing, marker, expected);
  if (seen.kind !== "none") return seen;
  const since = intentAt - CLOCK_SLACK_MS;
  const viewer = listing.viewer;
  if (
    viewer !== null &&
    listing.comments.some(
      (comment) => comment.author?.login === viewer && Date.parse(comment.createdAt) >= since,
    )
  ) {
    return { kind: "suspect" } as const;
  }
  const oldest = listing.comments.reduce(
    (earliest, comment) => Math.min(earliest, Date.parse(comment.createdAt)),
    Number.POSITIVE_INFINITY,
  );
  return {
    kind: listing.commentsCursor === null || oldest < since ? "absent" : "unknown",
  } as const;
};

export default workflow(
  FACTORY_BRIEF,
  {
    version: 1,
    payload: FactoryTaskRunInput,
    returns: BriefResult,
    asks: { accept: "Accept the brief?", deliver: "Check brief delivery?" },
  },
  Effect.fn(function* (input, run) {
    yield* title(`T-${input.number} ${input.title}`);
    yield* tags(taskTags(input.taskId, input.projectId, "planning"));
    const config = yield* step(
      "config",
      { returns: BriefConfig },
      readBriefConfig(input.projectId),
    );
    const target = yield* resolveTarget(input.projectId);
    if ("problem" in target) return yield* stop(target.problem);
    const project = target.projectId;
    const rooted = target.workspace === "root";
    // A folder agents work in directly is shared by every task on its project.
    const held = <A, E, R>(body: Parameters<typeof within<A, E, R>>[2]) =>
      rooted ? within(rootPool(project), { limit: 1 }, body) : body;
    const frozen = yield* step("freeze", { returns: Frozen }, freeze(input, project, run.id));
    const deliverTo = config.briefDelivery === "issue-comment" ? input.issueUrl : null;
    const receipt = (fields: ReceiptFields) =>
      writeReceipt({ taskId: input.taskId, attempt: input.attempt, runId: run.id, ...fields });
    const rules = [
      "Do not commit, push, create branches or open pull requests.",
      ...(deliverTo === null
        ? []
        : [
            `It will be posted as a comment on ${deliverTo}, so keep it under ${COMMENT_MAX} characters.`,
          ]),
      `Return the file's absolute \`path\`, a short \`summary\` of the brief, and \`citations\`: at most ${CITATIONS_MAX} sources (URLs or absolute file paths) it relies on.`,
    ];
    const where =
      target.workspace === "worktree"
        ? "this worktree"
        : target.workspace === "root"
          ? "this project's folder"
          : "this folder";
    const workerModel = config.workerModel ?? input.model;

    yield* tags(taskTags(input.taskId, input.projectId, "doing"));
    const draft = yield* held(
      agent("draft", {
        project,
        title: `T-${input.number} brief: ${input.title}`,
        brief: [
          `Write the brief that task T-${input.number} asks for: ${input.title}`,
          "",
          `The request, frozen for this attempt (sha256 ${frozen.sha256}):`,
          "",
          frozen.text,
          "",
          `Write the brief as one UTF-8 Markdown file in ${where}, at most 5 MiB, and back every claim with a source you cite.`,
          ...rules,
        ].join("\n"),
        workspace: rooted
          ? ({ type: "root" } as const)
          : ({ type: "worktree", baseRef: config.baseRef ?? "HEAD" } as const),
        runtimeMode: "full-access",
        ...(workerModel === null ? {} : { model: workerModel }),
        timeout: config.stepTimeout,
        returns: Draft,
      }),
    );
    const continueDraft = (name: string, why: string) =>
      held(
        agent(name, {
          thread: draft.thread,
          brief: [why, "", ...rules].join("\n"),
          timeout: config.stepTimeout,
          returns: Draft,
        }),
      );
    const recorded = Effect.fnUntraced(function* (label: string, written: Written) {
      const at = `hash/${label}`;
      const first = yield* step.try(
        at,
        { returns: Hashed },
        recordDeliverable(input, written.path, at, run.id),
      );
      if (first.outcome === "done") return { written, file: first.value };
      const fixed = yield* continueDraft(
        `draft/fix-${label}`,
        `The brief you returned could not be recorded: ${first.reason}\n\nMake sure it is one regular UTF-8 text file of at most 5 MiB.`,
      );
      const again = `${at}/fixed`;
      const second = yield* step.try(
        again,
        { returns: Hashed },
        recordDeliverable(input, fixed.value.path, again, run.id),
      );
      if (second.outcome === "failed") {
        return yield* stop(`brief could not be recorded: ${second.reason}`);
      }
      return { written: fixed.value, file: second.value };
    });

    let brief = yield* recorded("0", draft.value);
    let critique: CritiqueNote | null = null;
    const critiqueModel = config.critiqueModel;
    if (critiqueModel !== null) {
      for (let r = 0; ; r++) {
        const { path, citations } = brief.written;
        const { sha256 } = brief.file;
        const review = yield* agent(`critique/${r}`, {
          project,
          title: `T-${input.number} brief critique: ${input.title}`,
          brief: [
            `Review the brief at ${path} (sha256 ${sha256}), written for task T-${input.number}: ${input.title}`,
            "",
            `The request it answers (sha256 ${frozen.sha256}):`,
            "",
            frozen.text,
            ...(citations.length === 0
              ? []
              : ["", "The sources it cites:", ...citations.map((source) => `- ${source}`)]),
            "",
            "Change nothing. Read the file and check that it answers the request and that a cited source backs each claim.",
            `Return \`verdict: "pass"\` when it can be accepted as it is, or \`verdict: "revise"\` with \`notes\` on what must change. List each unsupported claim in \`unsupported\` (at most ${CITATIONS_MAX}).`,
          ].join("\n"),
          interactionMode: "plan",
          model: critiqueModel,
          timeout: config.stepTimeout,
          returns: Critique,
        });
        const { verdict, unsupported, notes } = review.value;
        const unchanged = yield* step(
          `recheck/${r}`,
          { returns: Schema.Boolean },
          Effect.gen(function* () {
            const again = yield* Effect.option(readBrief(path));
            if (Option.isNone(again) || again.value.sha256 !== sha256) return false;
            yield* receipt({
              sha256,
              kind: "critiqued",
              by: "agent",
              detail: { reason: `${verdict}: ${notes}`.slice(0, REASON_MAX) },
            });
            return true;
          }),
        );
        critique = { ...review.value, sha256 };
        if (unchanged && verdict === "pass") break;
        if (r >= config.fixRounds) {
          if (!unchanged) brief = yield* recorded(`${r + 1}`, brief.written);
          break;
        }
        const revised = yield* continueDraft(
          `revise/${r}`,
          [
            `Revise your brief for task T-${input.number} at ${path}.`,
            "",
            ...(unchanged
              ? []
              : [
                  "The file changed while it was being reviewed, so the review below may not match it.",
                  "",
                ]),
            "A review asked for changes:",
            "",
            notes,
            ...(unsupported.length === 0
              ? []
              : ["", "Claims it found unsupported:", ...unsupported.map((claim) => `- ${claim}`)]),
          ].join("\n"),
        );
        brief = yield* recorded(`${r + 1}`, revised.value);
      }
    }

    yield* tags(taskTags(input.taskId, input.projectId, "review"));
    // Only an answer given in the app accepts with `mergeNeedsPerson`, or before a post on the issue.
    const needsPerson = config.mergeNeedsPerson || deliverTo !== null;
    const decide = Effect.fnUntraced(function* (name: string) {
      const question = {
        title: `Accept the brief for T-${input.number} ${input.title}?`,
        kind: "accept",
        choices: ["Accept", { value: "Revise", requireReason: true }, "Drop"] as const,
        data: {
          path: brief.written.path,
          sha256: brief.file.sha256,
          bytes: brief.file.bytes,
          summary: brief.written.summary,
          critique,
          preview: brief.file.preview,
        },
      };
      const answer = yield* ask(name, question);
      if (Option.isNone(answer)) return undefined;
      if (
        answer.value.choice !== "Accept" ||
        !needsPerson ||
        answer.value.answeredBySession !== undefined
      ) {
        return answer.value;
      }
      const person = yield* ask(`${name}/person`, question);
      if (Option.isNone(person)) return undefined;
      if (person.value.choice === "Accept" && person.value.answeredBySession === undefined) {
        return undefined;
      }
      return person.value;
    });
    for (let n = 1; ; n++) {
      const name = n === 1 ? "accept" : `accept/x${n - 1}`;
      const answer = yield* decide(name);
      if (answer === undefined || answer.choice === "Drop") {
        return yield* stop("brief not accepted");
      }
      const { path } = brief.written;
      const { sha256 } = brief.file;
      if (answer.choice === "Revise") {
        const revised = yield* continueDraft(
          `revise/x${n}`,
          `Revise your brief for task T-${input.number} at ${path}.\n\nA person asked for changes:\n\n${answer.reason ?? ""}`,
        );
        brief = yield* recorded(`x${n}`, revised.value);
        continue;
      }
      const by = answer.answeredBySession === undefined ? "agent" : "person";
      const kept = yield* step(
        `${name}/check`,
        { returns: Schema.Boolean },
        Effect.gen(function* () {
          const again = yield* Effect.option(readBrief(path));
          if (Option.isSome(again) && again.value.sha256 === sha256) {
            yield* receipt({ sha256, kind: "accepted", by });
            return true;
          }
          yield* receipt({
            sha256,
            kind: "rejected",
            by: "pack",
            detail: { reason: "changed after review" },
          });
          return false;
        }),
      );
      if (kept) break;
      brief = yield* recorded(`x${n}`, brief.written);
    }

    const accepted = { path: brief.written.path, sha256: brief.file.sha256 };
    const deliver = (issueUrl: string) =>
      Effect.gen(function* () {
        const { path, sha256 } = accepted;
        const issue = { project, url: issueUrl };
        const body = yield* step(
          "deliver/body",
          { returns: Body },
          Effect.gen(function* () {
            const read = yield* Effect.match(readBrief(path), {
              onFailure: (reason) => ({ outcome: "changed", reason }) as const,
              onSuccess: (file) =>
                file.sha256 === sha256
                  ? ({ outcome: "ready", text: file.text } as const)
                  : ({
                      outcome: "changed",
                      reason: `${path} changed after it was accepted.`,
                    } as const),
            });
            if (read.outcome === "changed") {
              yield* receipt({
                sha256,
                kind: "rejected",
                by: "pack",
                detail: { reason: read.reason.slice(0, REASON_MAX) },
              });
              return read;
            }
            if (read.text.length > COMMENT_MAX) {
              yield* receipt({
                sha256,
                kind: "uncertain",
                by: "pack",
                detail: { reason: "too large" },
              });
              return { outcome: "too-large" } as const;
            }
            return read;
          }),
        );
        if (body.outcome === "changed")
          return yield* stop(`brief cannot be posted: ${body.reason}`);
        if (body.outcome === "too-large") return "uncertain" as const;
        const intent = yield* step(
          "deliver/intent",
          { returns: Schema.NullOr(Intent) },
          recordIntent(
            input.taskId,
            sha256,
            `<!-- t3factory:delivery task=${input.taskId} attempt=${input.attempt} sha256=${sha256} -->`,
          ),
        );
        if (intent === null) return "delivered" as const;
        const comment = `${body.text.trimEnd()}\n\n${intent.marker}`;
        const delivered = (found: ListedComment) =>
          receipt({
            sha256,
            kind: "delivered",
            by: "pack",
            detail: { commentId: found.id, ...(found.url === null ? {} : { url: found.url }) },
          });
        const sendKey = (slot: string) =>
          `${PREFIX}brief-send/${input.taskId}/${String(input.attempt).padStart(4, "0")}/${slot}`;
        // The claim is stored before the post, so a step run again after a crash never posts twice.
        const send = Effect.fnUntraced(function* (slot: string) {
          yield* store.entry(sendKey(slot), SendClaim).set({ intentAt: intent.intentAt, sha256 });
          yield* issues.comment(issue, comment);
        });
        const first = yield* step.try(
          "deliver/post",
          { returns: Posted },
          Effect.gen(function* () {
            const listing = yield* issues.read(issue);
            const seen = classify(listing, intent.marker, comment, intent.intentAt);
            if (seen.kind === "found") {
              yield* delivered(seen.comment);
              return "delivered" as const;
            }
            if (yield* isStored(sendKey("0"))) return "posted" as const;
            if (seen.kind !== "absent") {
              yield* receipt({
                sha256,
                kind: "uncertain",
                by: "pack",
                detail: { reason: UNSURE[seen.kind] },
              });
              return "ask" as const;
            }
            yield* send("0");
            return "posted" as const;
          }),
        );
        let sent: typeof Posted.Type = first.outcome === "done" ? first.value : "posted";
        let missing =
          first.outcome === "done"
            ? "posted, but the comment is not on the issue"
            : `the post may have failed: ${first.reason}`;
        const verify = (name: string, last: boolean) =>
          step(
            name,
            { returns: Schema.Boolean },
            Effect.gen(function* () {
              const seen = posted(yield* issues.read(issue), intent.marker, comment);
              if (seen.kind === "found") {
                yield* delivered(seen.comment);
                return true;
              }
              if (last) {
                yield* receipt({
                  sha256,
                  kind: "uncertain",
                  by: "pack",
                  detail: {
                    reason: (seen.kind === "edited" ? UNSURE.edited : missing).slice(0, REASON_MAX),
                  },
                });
              }
              return false;
            }),
          );
        // A tracker may list a new comment late, so a miss is read once more.
        const confirmed = Effect.fnUntraced(function* (suffix: string) {
          if (yield* verify(`deliver/verify${suffix}`, false)) return true;
          yield* sleep(`deliver/sleep${suffix}`, "30 seconds");
          return yield* verify(`deliver/verify-again${suffix}`, true);
        });

        for (let n = 1; ; n++) {
          const suffix = n === 1 ? "" : `/x${n - 1}`;
          if (sent === "delivered") return "delivered" as const;
          if (sent === "posted" && (yield* confirmed(suffix))) {
            return "delivered" as const;
          }
          const check = yield* ask(`deliver-check${suffix}`, {
            title: `Is the brief for T-${input.number} posted on ${issueUrl}?`,
            kind: "deliver",
            choices: ["Post again", "It is posted", "Skip"],
            data: { issueUrl, path, sha256, marker: intent.marker },
          });
          if (Option.isNone(check) || check.value.choice === "Skip") return "uncertain" as const;
          if (check.value.choice === "It is posted") {
            const by = check.value.answeredBySession === undefined ? "agent" : "person";
            yield* step(
              `deliver/confirmed${suffix}`,
              { returns: Schema.Void },
              receipt({ sha256, kind: "delivered", by }),
            );
            return "delivered" as const;
          }
          const again = yield* step.try(
            `deliver/again/x${n}`,
            { returns: Posted },
            Effect.gen(function* () {
              const seen = posted(yield* issues.read(issue), intent.marker, comment);
              if (seen.kind === "found") {
                yield* delivered(seen.comment);
                return "delivered" as const;
              }
              if (!(yield* isStored(sendKey(`${n}`)))) yield* send(`${n}`);
              return "posted" as const;
            }),
          );
          sent = again.outcome === "done" ? again.value : "posted";
          missing =
            again.outcome === "done"
              ? "posted again, but the comment is not on the issue"
              : `the post may have failed: ${again.reason}`;
        }
      });
    const outcome =
      deliverTo === null
        ? ("accepted" as const)
        : yield* within(`factory-deliver:${input.taskId}`, { limit: 1 }, deliver(deliverTo));

    const ending =
      outcome === "delivered"
        ? ` and posted on ${deliverTo ?? ""}`
        : outcome === "uncertain"
          ? `, but it may not be posted on ${deliverTo ?? ""}`
          : "";
    yield* step(
      "finish",
      { returns: Schema.Void },
      addNote(
        input.taskId,
        `Attempt ${input.attempt} ended: brief accepted${ending}.\n${accepted.path} (sha256 ${accepted.sha256})`,
        FACTORY_BRIEF,
        capturedKey(run.id, "finish"),
      ),
    );
    yield* tags(taskTags(input.taskId, input.projectId, "done"));
    return { outcome, ...accepted };
  }),
);
