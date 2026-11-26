export type ReadOnlyOn = {
  readonly environment: string;
  readonly project: string;
  readonly limit: number;
};

export type Placement =
  | { readonly where: "local" }
  | { readonly where: "refused"; readonly reason: string }
  | ({ readonly where: "remote"; readonly pool: string } & ReadOnlyOn);

export const REMOTE_NEEDS_WORKTREE =
  "readOnlyOn is set for this project, but its tasks work in a plain folder, which another machine does not have. Remove readOnlyOn from the project's Factory config, then start the task again.";
export const REMOTE_NEEDS_TARGET =
  "readOnlyOn is set for this project, but the server has no usable record of where its tasks work. Start the task from the Work page, which writes that record, or remove readOnlyOn from the project's Factory config.";

export const remotePool = (environment: string) => `factory-env:${environment}`;

export const namesFolder = (value: string) =>
  value.startsWith("/") || /^[a-zA-Z]:([/\\]|$)/.test(value);

export const isFullSha = (value: string | null) =>
  value !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

export const remoteLine = (sha: string) =>
  `You are on another machine than the one this task is run from, in a worktree made at commit \`${sha}\`. No approval will be given here: use only file reads and read-only git (\`git diff\`, \`git show\`, \`git log\`, \`git rev-parse\`), and do not edit, commit, push, fetch, install, build or run tests. Report the output of \`git rev-parse HEAD\` as the commit you read.`;

export const remoteScopeLine = (baseRef: string | null) => {
  const branch = baseRef?.replace(/^(?:origin\/|refs\/heads\/)/, "") ?? "HEAD";
  return `Run \`git diff --name-only <base>...HEAD\`, where \`<base>\` is \`origin/${branch}\` as this clone has it.`;
};

export const placementFor = (
  readOnlyOn: ReadOnlyOn | undefined,
  workspace: "worktree" | "root" | "scratch" | null,
): Placement => {
  if (readOnlyOn === undefined) return { where: "local" };
  if (workspace === null) return { where: "refused", reason: REMOTE_NEEDS_TARGET };
  if (workspace !== "worktree") return { where: "refused", reason: REMOTE_NEEDS_WORKTREE };
  const { environment, project, limit } = readOnlyOn;
  return { where: "remote", environment, project, pool: remotePool(environment), limit };
};
