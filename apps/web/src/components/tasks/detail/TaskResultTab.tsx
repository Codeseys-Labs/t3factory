import { presentFactoryTaskChecks } from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import { FileIcon } from "lucide-react";

import { useFactoryTaskResult } from "../../../state/factoryTasks";
import { ResultCard, SectionHeader, TruncatedText } from "../kit";
import { useTaskPullRequestChecks } from "../shared";

/** What the task produced. Accept and Request changes sit in the banner right above. */
export function TaskResultTab({ task }: { task: FactoryTaskSummary }) {
  if (task.result === null)
    return <p className="py-2 text-muted-foreground text-sm">No result yet.</p>;
  return <TaskResult task={task} />;
}

function TaskResult({ task }: { task: FactoryTaskSummary }) {
  const read = useFactoryTaskResult(task.ref);
  const checks = useTaskPullRequestChecks(task);
  if (read._tag === "Failure")
    return (
      <p role="alert" className="text-destructive-foreground text-sm">
        Couldn't load the result. Check the machine's connection and reload.
      </p>
    );
  if (read._tag !== "Success")
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading the result…
      </p>
    );
  const { result, files, filesOmitted, text } = read.value;
  const pullRequest = result.pullRequest ?? null;
  const accepted = result.state === "accepted";
  const fileCount = files.length + filesOmitted;
  return (
    <div className="flex flex-col gap-4">
      <ResultCard
        kind={pullRequest ? "pull-request" : result.kind}
        title={pullRequest ? `PR #${pullRequest.number} · ${task.title}` : task.title}
        meta={[
          result.summary,
          pullRequest?.state === "merged"
            ? "merged"
            : pullRequest && checks
              ? presentFactoryTaskChecks(checks)
              : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        review={accepted ? "accepted" : "pending"}
        revisionLabel={`rev ${accepted ? (result.acceptedRevision ?? result.revision) : result.revision}`}
        showActions={false}
      />
      {result.kind === "code" && fileCount > 0 ? (
        <section aria-label="Changed files" className="flex flex-col">
          <SectionHeader
            title="Changed files"
            meta={`${fileCount} ${fileCount === 1 ? "file" : "files"}`}
          />
          <ul className="flex flex-col">
            {files.map((file) => (
              <li
                key={file.path}
                className="flex h-8 min-w-0 items-center gap-2 border-b border-border px-2 text-xs"
              >
                <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <TruncatedText text={file.path} className="flex-1 font-mono" />
                <span className="w-10 shrink-0 text-end text-success-foreground tabular-nums">
                  +{file.additions}
                </span>
                <span className="w-10 shrink-0 text-end text-destructive-foreground tabular-nums">
                  −{file.deletions}
                </span>
              </li>
            ))}
          </ul>
          {filesOmitted > 0 ? (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">
              And {filesOmitted} more {filesOmitted === 1 ? "file" : "files"}.
            </p>
          ) : null}
        </section>
      ) : null}
      {result.kind === "document" && text ? (
        <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-card px-4 py-3 text-sm">
          {text}
        </div>
      ) : null}
    </div>
  );
}
