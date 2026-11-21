import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type FactoryTaskSummary } from "@t3tools/contracts";
import { BotIcon, MessageSquareIcon, SendIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { type KeyboardEvent, useState } from "react";

import { factoryTasks } from "../../../state/factoryTasks";
import { useEnvironmentScope } from "../../../state/session";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { TASK_PERMISSION_MESSAGE, useTaskActions, useTaskCatalog } from "../shared";
import { presentTaskSetup } from "../shared/taskAssigneeModel";
import { useTaskDetailCommands } from "./taskDetailCommands";
import { isRunLive } from "./taskRuns";

type Mode = "comment" | "agent";

/**
 * Where a person writes on a task. `Comment` is for the people on it. `Message agent` goes to the
 * live planning run's thread; a work run takes replies through its asks and Request changes.
 */
export function TaskCommentBox({
  task,
  initialMode = "comment",
}: {
  task: FactoryTaskSummary;
  initialMode?: Mode;
}) {
  const { environmentId } = task.ref;
  const actions = useTaskActions();
  const commands = useTaskDetailCommands();
  const catalog = useTaskCatalog(environmentId);
  const canComment = useAtomValue(factoryTasks.addTaskComment.permissionAtom(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [chosen, setChosen] = useState<Mode>(initialMode);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const gt = useGT();
  const messages = useMessages();
  const run = task.run;
  const ownLive =
    run !== null && isRunLive(run) && task.liveRuns.some((live) => live.threadId === run.threadId);
  const planningRun = ownLive && run.purpose === "planning" ? run : null;
  const agentReason =
    planningRun === null
      ? ownLive
        ? gt("A working run takes replies through its questions and Request changes.")
        : gt("Message agent opens while a planning run is live.")
      : canOperate
        ? null
        : messages(TASK_PERMISSION_MESSAGE);
  const mode: Mode = chosen === "agent" && agentReason === null ? "agent" : "comment";
  const agentLabel = planningRun ? presentTaskSetup(planningRun.setup, catalog).label : "agent";
  const allowed = mode === "agent" || canComment;
  const body = text.trim();

  const send = async () => {
    if (!body || sending || !allowed) return;
    setSending(true);
    const sent =
      mode === "agent" && planningRun
        ? await commands.messageAgent(task, planningRun, body)
        : (await actions.comment(task.ref, body)) !== null;
    setSending(false);
    if (sent) setText("");
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-2">
        <ToggleGroup
          aria-label={gt("Who this goes to")}
          value={[mode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "comment" || next === "agent") setChosen(next);
          }}
        >
          <Toggle value="comment">
            <MessageSquareIcon aria-hidden />
            <T>Comment</T>
          </Toggle>
          <Toggle value="agent" disabled={agentReason !== null}>
            <BotIcon aria-hidden />
            <T>Message agent</T>
          </Toggle>
        </ToggleGroup>
        <span className="text-muted-foreground text-xs">
          {mode === "agent" ? (
            <T>Goes to the agent and steers the current run</T>
          ) : (
            <T>Goes to the people on this task</T>
          )}
        </span>
      </div>
      <Textarea
        unstyled
        aria-label={
          mode === "agent"
            ? gt("Message {agent}", { agent: agentLabel })
            : gt("Comment", { $context: "noun, a comment on a task" })
        }
        placeholder={
          mode === "agent" ? gt("Message {agent}", { agent: agentLabel }) : gt("Leave a comment…")
        }
        value={text}
        maxLength={8000}
        disabled={!allowed}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={keys}
      />
      <div className="flex items-center gap-3 p-2">
        <span className="min-w-0 flex-1 text-muted-foreground text-xs">
          {!allowed ? messages(TASK_PERMISSION_MESSAGE) : mode === "comment" ? agentReason : null}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!body || sending || !allowed}
          onClick={() => void send()}
        >
          {mode === "agent" ? (
            <>
              <SendIcon aria-hidden />
              <T>Send to agent</T>
            </>
          ) : (
            <T>Comment</T>
          )}
        </Button>
      </div>
    </div>
  );
}
