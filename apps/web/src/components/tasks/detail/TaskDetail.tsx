import { useAtomValue } from "@effect/atom-react";
import type {
  FactoryTaskDetail,
  FactoryTaskPlanProposal,
  FactoryTaskPlanProposalReadResult,
} from "@t3tools/contracts";
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { factoryTasks } from "../../../state/factoryTasks";
import {
  PageHeader,
  type PageHeaderCrumb,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  TaskIdText,
  TypeTag,
} from "../kit";
import { TaskBanner } from "../shared";
import { TaskPageFrame } from "../TaskPageFrame";
import { TaskActivity } from "./TaskActivity";
import { TaskDescription, TaskTitle } from "./TaskDefinition";
import { TaskPageMenu } from "./TaskPageMenu";
import { TaskPlanEditor } from "./TaskPlanEditor";
import { TaskRail } from "./TaskRail";
import { TaskResultTab } from "./TaskResultTab";
import { ProposedSubtasks, TaskSubtasks } from "./TaskSubtasks";
import { TaskThreadTab } from "./TaskThreadTab";

export type TaskDetailTab = "activity" | "thread" | "result";

const NO_PLAN: Atom.Atom<AsyncResult.AsyncResult<FactoryTaskPlanProposalReadResult, unknown>> =
  Atom.make(AsyncResult.initial(false));

/** The plan waiting on a person, read only while the task says one waits, as the banner does. */
function useWaitingPlan(detail: FactoryTaskDetail): FactoryTaskPlanProposal | null {
  const { task } = detail;
  const waits = task.attention.some(
    (entry) => entry.reason === "plan" && entry.taskId === task.ref.taskId,
  );
  const plan = useAtomValue(
    waits
      ? factoryTasks.readTaskPlanProposal({
          environmentId: task.ref.environmentId,
          input: { ref: task.ref },
        })
      : NO_PLAN,
  );
  const proposal = plan._tag === "Success" ? plan.value.proposal : null;
  return proposal?.status === "proposed" ? proposal : null;
}

/** One task's page in every state: what it is, where it stands, its sub-tasks, history and runs. */
export function TaskDetail({
  detail,
  tab,
  onTabChange,
}: {
  detail: FactoryTaskDetail;
  tab: TaskDetailTab;
  onTabChange: (tab: TaskDetailTab) => void;
}) {
  const { task } = detail;
  const { environmentId } = task.ref;
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const proposal = useWaitingPlan(detail);
  const canEditPlan = useAtomValue(
    factoryTasks.updateTaskPlanProposal.permissionAtom(environmentId),
  );
  const [editingPlan, setEditingPlan] = useState<string | null>(null);
  const editing = proposal !== null && editingPlan === proposal.id;

  const breadcrumb: PageHeaderCrumb[] = [
    { label: "Tasks", render: <Link to="/tasks" /> },
    ...detail.ancestors.map((ancestor) => ({
      label: ancestor.displayId,
      render: (
        <Link
          to="/tasks/$environmentId/$displayId"
          params={{ environmentId, displayId: ancestor.displayId }}
        />
      ),
    })),
    { label: task.displayId },
  ];
  const back = () => (canGoBack ? router.history.back() : void router.navigate({ to: "/tasks" }));

  return (
    <TaskPageFrame
      header={
        <PageHeader
          onBack={back}
          breadcrumb={breadcrumb}
          actions={<TaskPageMenu task={task} proposal={proposal} />}
        />
      }
    >
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="grid w-full grid-cols-1 gap-x-4 gap-y-8 px-6 py-6 @5xl:grid-cols-[minmax(0,50rem)_20rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <TaskIdText id={task.displayId} />
                <TypeTag type={task.type} />
              </div>
              <TaskTitle task={task} />
            </div>
            <TaskBanner
              task={task}
              detail={detail}
              {...(canEditPlan ? { onEditPlan: () => setEditingPlan(proposal?.id ?? null) } : {})}
            />
            <TaskDescription task={task} description={detail.description} />
            {proposal && editing ? (
              <TaskPlanEditor
                key={`${proposal.id}:${proposal.version}`}
                task={task}
                proposal={proposal}
                onClose={() => setEditingPlan(null)}
              />
            ) : proposal ? (
              <ProposedSubtasks task={task} proposal={proposal} />
            ) : (
              <TaskSubtasks detail={detail} />
            )}
            <Tabs value={tab} onValueChange={(value) => onTabChange(value as TaskDetailTab)}>
              <TabsList>
                <TabsTab value="activity">Activity</TabsTab>
                <TabsTab value="thread">Thread</TabsTab>
                <TabsTab value="result">Result</TabsTab>
              </TabsList>
              <TabsPanel value="activity" className="mt-3">
                <TaskActivity detail={detail} />
              </TabsPanel>
              <TabsPanel value="thread" className="mt-3">
                <TaskThreadTab task={task} />
              </TabsPanel>
              <TabsPanel value="result" className="mt-3">
                <TaskResultTab task={task} />
              </TabsPanel>
            </Tabs>
          </div>
          <TaskRail detail={detail} />
        </div>
      </div>
    </TaskPageFrame>
  );
}
