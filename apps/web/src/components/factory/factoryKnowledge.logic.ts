import {
  FACTORY_KNOWLEDGE_ARTIFACT_MAX_BYTES,
  FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS,
  FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH,
  FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS,
  FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS,
  FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS,
  FACTORY_KNOWLEDGE_MAX_INPUTS,
  FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS,
  FACTORY_KNOWLEDGE_TITLE_MAX_CHARS,
  FactoryKnowledgeError,
  type FactoryKnowledgeBriefCreateInput,
  type FactoryKnowledgeTaskReadResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { describeFactoryFailure } from "./factoryIssues.logic";

export const KNOWLEDGE_LIMITS = {
  title: FACTORY_KNOWLEDGE_TITLE_MAX_CHARS,
  question: FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS,
  acceptanceCriteria: FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS,
  inputLabel: FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS,
  inputContent: FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS,
  inputs: FACTORY_KNOWLEDGE_MAX_INPUTS,
  instructions: FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS,
} as const;

const FAILURE_MESSAGES: Record<FactoryKnowledgeError["reason"], string> = {
  "unknown-brief": msg("This brief is no longer available. Refresh the brief list."),
  "revision-mismatch": msg(
    "The brief revision changed. Close this dialog, refresh and review again.",
  ),
  "already-started": msg("This brief already has a task. Refresh to open its thread."),
  "unknown-task": msg("This brief has no task available. Refresh the brief list."),
  "folder-unavailable": msg(
    "The task folder is unavailable. Starting a knowledge task needs a server data directory outside any git repository; an existing folder must be restored before accepting.",
  ),
  "artifact-missing": msg("No artifact was found. Open the thread and refresh when it is ready."),
  "artifact-changed": msg(
    "The artifact changed while you were reviewing. Refresh and review it again.",
  ),
  "already-accepted": msg(
    "An artifact is already accepted. Refresh and use Re-accept if it changed.",
  ),
  "invalid-path": msg("Use a relative file path without parent traversal or a .git directory."),
  "persistence-failure": msg(
    "The environment could not save the change. Refresh before trying again.",
  ),
};

const isKnowledgeError = Schema.is(FactoryKnowledgeError);

export function factoryKnowledgeFailureMessage(
  error: unknown,
  fallbackMessage?: string,
  resolve: MessageResolver = m,
): string {
  return isKnowledgeError(error)
    ? resolve(FAILURE_MESSAGES[error.reason])
    : describeFactoryFailure(error, fallbackMessage).message;
}

export type FactoryKnowledgeArtifactState = "none" | "current" | "changed" | "unverifiable";

export function factoryKnowledgeArtifactIssueMessage(
  issue: FactoryKnowledgeTaskReadResult["artifactIssue"],
  path: string,
  resolve: MessageResolver = m,
): string | null {
  switch (issue) {
    case "missing":
      return resolve(msg("No artifact yet at {path}", { path }));
    case "too-large":
      return resolve(
        msg("The artifact is larger than {size} MiB and cannot be read or accepted.", {
          size: FACTORY_KNOWLEDGE_ARTIFACT_MAX_BYTES / (1024 * 1024),
        }),
      );
    case "unreadable":
      return resolve(msg("The artifact exists but cannot be read."));
    case null:
      return null;
  }
}

export function factoryKnowledgeArtifactState(
  result: Pick<
    FactoryKnowledgeTaskReadResult,
    "artifact" | "artifactIssue" | "acceptance" | "current"
  > | null,
): FactoryKnowledgeArtifactState {
  if (result === null) return "unverifiable";
  if (result.acceptance === null) return "none";
  if (result.artifactIssue !== null || result.artifact === null) return "unverifiable";
  return result.current ? "current" : "changed";
}

export type FactoryKnowledgeDraft = Pick<
  FactoryKnowledgeBriefCreateInput,
  "title" | "question" | "acceptanceCriteria"
> & {
  readonly deliverablePath: string;
  readonly inputs: ReadonlyArray<{
    readonly key?: string;
    readonly label: string;
    readonly content: string;
  }>;
};

export const EMPTY_KNOWLEDGE_DRAFT: FactoryKnowledgeDraft = {
  title: "",
  question: "",
  deliverablePath: FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH,
  inputs: [],
  acceptanceCriteria: "",
};

export function isFactoryKnowledgeDeliverablePath(value: string): boolean {
  const path = value.trim().replaceAll("\\", "/");
  const parts = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !/^[a-z]:/i.test(path) &&
    !path.includes("\0") &&
    parts.every(
      (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
    )
  );
}

export function validateFactoryKnowledgeDraft(
  draft: FactoryKnowledgeDraft,
  resolve: MessageResolver = m,
): string | null {
  if (draft.title.trim().length === 0) return resolve(msg("Enter a brief title."));
  if (draft.title.length > KNOWLEDGE_LIMITS.title)
    return resolve(msg("Keep the title to 200 characters."));
  if (draft.question.length > KNOWLEDGE_LIMITS.question)
    return resolve(msg("Keep the question to 8,000 characters."));
  if (draft.acceptanceCriteria.length > KNOWLEDGE_LIMITS.acceptanceCriteria) {
    return resolve(msg("Keep acceptance criteria to 4,000 characters."));
  }
  if (!isFactoryKnowledgeDeliverablePath(draft.deliverablePath)) {
    return resolve(FAILURE_MESSAGES["invalid-path"]);
  }
  if (draft.inputs.length > KNOWLEDGE_LIMITS.inputs)
    return resolve(msg("Use no more than 8 inputs."));
  for (const [index, input] of draft.inputs.entries()) {
    if (input.label.trim().length === 0)
      return resolve(msg("Enter a label for input {index}.", { index: index + 1 }));
    if (input.label.length > KNOWLEDGE_LIMITS.inputLabel) {
      return resolve(msg("Keep input {index}''s label to 120 characters.", { index: index + 1 }));
    }
    if (input.content.length > KNOWLEDGE_LIMITS.inputContent) {
      return resolve(
        msg("Keep input {index}''s content to 64,000 characters.", { index: index + 1 }),
      );
    }
  }
  return null;
}
