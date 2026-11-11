import type { FactoryTaskPlanProposal, FactoryTaskSummary } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Textarea } from "../../ui/textarea";
import { AssigneeChip, SectionHeader, TaskIdText } from "../kit";
import { TaskAssigneePicker } from "../shared";
import { useTaskDetailCommands } from "./taskDetailCommands";
import { type PlanDraftItem, planForSave, planOrderNote, planProblem } from "./taskPlanModel";
import { useProposalChips } from "./TaskSubtasks";

/**
 * The proposed sub-tasks as an editable list: titles, descriptions, assignees and what each comes
 * after. A plan that cannot run (a loop, a removed item, a missing title) cannot be saved.
 */
export function TaskPlanEditor({
  task,
  proposal,
  onClose,
}: {
  task: FactoryTaskSummary;
  proposal: FactoryTaskPlanProposal;
  onClose: () => void;
}) {
  const commands = useTaskDetailCommands();
  const chipFor = useProposalChips(task);
  const [items, setItems] = useState<PlanDraftItem[]>(() => [...proposal.items]);
  const [saving, setSaving] = useState(false);
  const problem = planProblem(items);
  const change = (key: string, patch: Partial<PlanDraftItem>) =>
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  const remove = (key: string) => setItems((current) => current.filter((item) => item.key !== key));
  const add = () =>
    setItems((current) => [
      ...current,
      {
        key: `item-${randomUUID()}`,
        title: "",
        description: "",
        assignment: { mode: "auto" },
        after: [],
      },
    ]);
  const save = async () => {
    if (problem !== null || saving) return;
    setSaving(true);
    const saved = await commands.savePlan(task, proposal, planForSave(items));
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <section aria-label="Edit the plan" className="flex flex-col gap-2">
      <SectionHeader title="Sub-tasks" meta="Editing the plan" />
      <ol className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li
            key={item.key}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-lg border border-border bg-card p-3"
          >
            <span className="pt-1.5">
              <TaskIdText id={String(index + 1)} />
            </span>
            <div className="flex min-w-0 flex-col gap-2">
              <Input
                aria-label={`Title of sub-task ${index + 1}`}
                placeholder="Title"
                value={item.title}
                maxLength={512}
                onChange={(event) => change(item.key, { title: event.currentTarget.value })}
              />
              <Textarea
                aria-label={`Description of sub-task ${index + 1}`}
                placeholder="Description"
                size="sm"
                value={item.description}
                maxLength={8000}
                onChange={(event) => change(item.key, { description: event.currentTarget.value })}
              />
              <div className="flex flex-wrap items-center gap-2">
                <TaskAssigneePicker
                  environmentId={task.ref.environmentId}
                  projectId={task.ref.projectId}
                  type={task.type}
                  value={item.assignment}
                  onChange={(assignment) => change(item.key, { assignment })}
                  trigger={
                    <AssigneeChip
                      assignee={chipFor(item.assignment)}
                      aria-label={`Assignee of sub-task ${index + 1}`}
                      render={<button type="button" />}
                    />
                  }
                  parent={{ ref: task.ref, displayId: task.displayId, assignee: task.assignee }}
                />
                <AfterPicker
                  item={item}
                  number={index + 1}
                  items={items}
                  onChange={(after) => change(item.key, { after })}
                />
              </div>
            </div>
            <Button
              variant="ghost-destructive"
              size="icon-xs"
              aria-label={`Remove sub-task ${index + 1}`}
              onClick={() => remove(item.key)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost-muted" size="sm" onClick={add} disabled={items.length >= 32}>
          <PlusIcon aria-hidden />
          Add sub-task
        </Button>
        <span className="flex-1" />
        {problem ? (
          <p role="alert" className="text-destructive-foreground text-sm">
            {problem}
          </p>
        ) : null}
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={problem !== null || saving} onClick={() => void save()}>
          Save plan
        </Button>
      </div>
    </section>
  );
}

/** What one sub-task comes after: any of the others, plus any it still names that was removed. */
function AfterPicker({
  item,
  number,
  items,
  onChange,
}: {
  item: PlanDraftItem;
  number: number;
  items: readonly PlanDraftItem[];
  onChange: (after: string[]) => void;
}) {
  const others = items.flatMap((candidate, index) =>
    candidate.key === item.key ? [] : [{ key: candidate.key, number: index + 1, candidate }],
  );
  const removed = item.after.filter((key) => !items.some((candidate) => candidate.key === key));
  const toggle = (key: string, checked: boolean) =>
    onChange(checked ? [...item.after, key] : item.after.filter((entry) => entry !== key));
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="outline" size="xs" aria-label={`What sub-task ${number} comes after`} />
        }
      >
        {planOrderNote(item, items)}
      </MenuTrigger>
      <MenuPopup align="start">
        {others.length === 0 && removed.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-sm">Add another sub-task first.</p>
        ) : null}
        {others.map(({ key, number: otherNumber, candidate }) => (
          <MenuCheckboxItem
            key={key}
            checked={item.after.includes(key)}
            onCheckedChange={(checked) => toggle(key, checked)}
          >
            {otherNumber}. {candidate.title.trim() || "Untitled"}
          </MenuCheckboxItem>
        ))}
        {removed.map((key) => (
          <MenuCheckboxItem key={key} checked onCheckedChange={(checked) => toggle(key, checked)}>
            A removed sub-task
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
