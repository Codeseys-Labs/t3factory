import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { FactoryIssue, FactoryIssueListInput, FactoryIssueStartInput } from "./factory.ts";
import { FactoryOriginKey } from "./factoryClaims.ts";
import {
  FactoryArtifactDeliveryGrantInput,
  FactoryArtifactDeliveryIntent,
  FactoryCommitDeliveryIntent,
  FactoryDeliveryReadResult,
} from "./factoryDelivery.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

const input = {
  commandId: CommandId.make("start"),
  projectId: ProjectId.make("project"),
  issueNumber: 1,
  expectedRepositoryKey: "github.com/owner/factory",
  expectedIssueRevision: "reviewed-revision",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
} satisfies FactoryIssueStartInput;
const decodeStartInput = Schema.decodeUnknownSync(FactoryIssueStartInput);
const decodeListInput = Schema.decodeUnknownSync(FactoryIssueListInput);
const decodeIssue = Schema.decodeUnknownSync(FactoryIssue);

describe("factory wire contract", () => {
  it("rejects invalid issue numbers and pages at the boundary", () => {
    for (const value of [0, 1.5]) {
      expect(() => decodeStartInput({ ...input, issueNumber: value })).toThrow();
      expect(() => decodeListInput({ projectId: input.projectId, page: value })).toThrow();
    }
  });

  it("has no start shape that skips the reviewed issue revision", () => {
    const { expectedIssueRevision: _reviewed, ...unreviewed } = input;
    expect(() => decodeStartInput(unreviewed)).toThrow();
    for (const value of [null, "", "   "]) {
      expect(() => decodeStartInput({ ...input, expectedIssueRevision: value })).toThrow();
    }
  });

  it("accepts native keys and legacy numbers without ambiguous addressing", () => {
    expect(decodeStartInput(input).issueNumber).toBe(1);
    const { issueNumber: _number, ...withoutNumber } = input;
    expect(decodeStartInput({ ...withoutNumber, key: "ENG-123" }).key).toBe("ENG-123");
    expect(() => decodeStartInput(withoutNumber)).toThrow();
    expect(() => decodeStartInput({ ...input, key: "ENG-123" })).toThrow();
    const oldReply = {
      number: 12,
      title: "Task",
      body: null,
      state: "open",
      url: "https://example.test/12",
      labels: [],
      updatedAt: "2026-10-23T00:00:00.000Z",
      revision: "reviewed",
      task: null,
    };
    expect(decodeIssue(oldReply)).toEqual(oldReply);
    expect(
      decodeIssue({
        ...oldReply,
        number: null,
        key: "ENG-123",
        displayKey: "ENG-123",
      }).key,
    ).toBe("ENG-123");
  });

  it("requires a UUID v4 artifact attempt rather than caller-injected marker lines", () => {
    const decode = Schema.decodeUnknownSync(FactoryArtifactDeliveryGrantInput);
    const grant = {
      projectId: input.projectId,
      threadId: ThreadId.make("knowledge-thread"),
      kind: "publish-artifact",
      commandId: "grant",
      expectedArtifactSha256: "a".repeat(64),
      expectedPayloadDigest: "b".repeat(64),
      payload: { issueNumber: 7 },
      attempt: "a1dd4aae-d332-49a7-b29d-f35ddaf2f19b",
    };
    expect(decode(grant).attempt).toBe(grant.attempt);
    for (const attempt of [
      "arbitrary-token",
      `${grant.attempt}\n<!-- t3-factory-delivery attempt=other -->`,
      `${grant.attempt} -->\n\nInjected text`,
      "",
    ]) {
      expect(() => decode({ ...grant, attempt })).toThrow();
    }
  });

  it("keeps a delivery reply without comment keys decodable by clients that predate them", () => {
    // The read reply as shipped clients decode it (47ddccebbc): only the comment id differs.
    const decodeShipped = Schema.decodeUnknownSync(
      Schema.Struct({
        intents: Schema.Array(
          Schema.Union([
            FactoryCommitDeliveryIntent,
            FactoryArtifactDeliveryIntent.mapFields((fields) => ({
              ...fields,
              remote: Schema.NullOr(Schema.Struct({ commentId: Schema.Int, url: Schema.String })),
            })),
          ]),
        ),
      }),
    );
    const encode = Schema.encodeSync(FactoryDeliveryReadResult);
    const url = "https://github.com/owner/repo/issues/7#issuecomment-91";
    const intent = {
      id: "delivery:artifact:1",
      originKey: FactoryOriginKey.make("knowledge:brief"),
      threadId: ThreadId.make("knowledge-thread"),
      projectId: input.projectId,
      acceptanceId: "acceptance",
      payloadDigest: "b".repeat(64),
      grantedBy: EnvironmentId.make("person"),
      grantedAt: "2026-10-28T00:00:00.000Z",
      requestCommandId: "grant",
      status: "confirmed",
      failure: null,
      updatedAt: "2026-10-28T00:00:01.000Z",
      kind: "publish-artifact",
      briefId: "brief",
      artifactPath: "DELIVERABLE.md",
      artifactSha256: "a".repeat(64),
      artifactBytes: 10,
      repository: {
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: "owner/repo",
        canonicalKey: "github.com/owner/repo",
        url: "https://github.com/owner/repo",
      },
      destinationKey: "comment:github:github.com/owner/repo#7",
      payload: { issueNumber: 7 },
      body: "# Findings",
      remote: { commentId: 91, url },
    } satisfies FactoryArtifactDeliveryIntent;
    expect(decodeShipped(encode({ intents: [intent] }))).toEqual({ intents: [intent] });
    const keyed = { ...intent, remote: { commentId: "IC_kwDOabc", url } };
    expect(() => decodeShipped(encode({ intents: [keyed] }))).toThrow();
    const decodeShippedInput = Schema.decodeUnknownSync(
      Schema.Struct({ projectId: ProjectId, threadId: ThreadId }),
    );
    expect(
      decodeShippedInput({
        projectId: intent.projectId,
        threadId: intent.threadId,
        commentKeys: true,
      }),
    ).toEqual({ projectId: intent.projectId, threadId: intent.threadId });
  });
});
