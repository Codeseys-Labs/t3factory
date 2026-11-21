import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import {
  FACTORY_FEED_INSTRUCTIONS_MAX_CHARS,
  type EnvironmentId,
  type FactoryFeedCandidate,
  type FactoryFeedSource,
  type FactoryRepository,
  type ModelSelection,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  countFactoryFeedText,
  isFactoryFeedAdmitEnabled,
  type FactoryFeedFailure,
} from "./factoryFeeds.logic";
import { FactoryClaimWarning } from "./FactoryClaimIndicators";
import { normalizeFactoryBaseRef } from "./factoryIssues.logic";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  type FactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import { FactoryReviewFailure, FactoryReviewSnapshot } from "./FactoryReview";

/**
 * Pins one reviewed revision of a feed item. The `candidate` it was opened with is the only thing
 * it ever submits; a refreshed list can never change what is confirmed here.
 */
export function FactoryFeedAdmitDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly candidate: FactoryFeedCandidate;
  readonly source: FactoryFeedSource;
  readonly restart: boolean;
  readonly projectTitle: string;
  readonly repository: FactoryRepository;
  readonly settings: FactoryLaunchModelSettings;
  readonly canAdmit: boolean;
  readonly pending: boolean;
  readonly failure: FactoryFeedFailure | null;
  readonly claimWarning: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (options: {
    readonly modelSelection: ModelSelection;
    readonly baseRef?: string;
    readonly instructions: string;
    readonly restartDeleted: boolean;
  }) => void;
}) {
  const { candidate, source, restart, pending } = props;
  const gt = useGT();
  const draft = useFactoryLaunchDraft(props.settings);
  const instructionsId = useId();
  const [instructions, setInstructions] = useState("");
  const changed = props.failure?.kind === "changed";
  const count = countFactoryFeedText(instructions, FACTORY_FEED_INSTRUCTIONS_MAX_CHARS);
  const { selection } = draft;
  const enabled = isFactoryFeedAdmitEnabled({
    canAdmit: props.canAdmit,
    pending,
    changed,
    selection,
    instructions,
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{restart ? gt("Start a new attempt") : gt("Admit feed item")}</DialogTitle>
          <DialogDescription>
            {restart
              ? gt(
                  "The previous task's thread was deleted. Confirming creates a new isolated worktree and a new attempt for this item.",
                )
              : gt(
                  "Creates a task in its own isolated git worktree and sends the reviewed feed item to the selected agent.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <div className="space-y-0.5">
              <p className="text-muted-foreground text-xs">
                <T>
                  <Var>{`${props.repository.host}/${props.repository.repository}`}</Var> · task
                  project <Var>{props.projectTitle}</Var>
                </T>
              </p>
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                <T>
                  Feed <Var>{factoryIssueReviewText(source.locator)}</Var> · revision{" "}
                  <Var>{candidate.ordinal}</Var>
                </T>
              </p>
            </div>
            <FactoryClaimWarning message={props.claimWarning} />
            <FactoryReviewSnapshot
              heading={gt("Full item snapshot")}
              intro={gt("Review the full title, content and link before confirming.")}
              fields={[
                {
                  label: gt("Title"),
                  text: candidate.title,
                  emptyNote: gt("The feed title is an empty string."),
                  missingNote: gt("The feed published no title. The source title is null."),
                },
                {
                  label: gt("Content"),
                  text: candidate.content,
                  emptyNote: gt("The feed content is an empty string."),
                  missingNote: gt("The feed published no content. The source content is null."),
                },
                {
                  label: gt("Link"),
                  text: candidate.link,
                  emptyNote: gt("The feed link is an empty string."),
                  missingNote: gt("The feed published no link. The source link is null."),
                },
              ]}
            />
            <div className="space-y-1.5">
              <Label htmlFor={instructionsId}>
                <T>Instructions</T>{" "}
                <span className="font-normal text-muted-foreground">
                  <T>optional</T>
                </span>
              </Label>
              <Textarea
                id={instructionsId}
                value={instructions}
                aria-invalid={count.overLimit}
                aria-describedby={`${instructionsId}-help`}
                placeholder={gt("Requirements in your own words for this task")}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex items-start justify-between gap-3">
                <p id={`${instructionsId}-help`} className="text-muted-foreground text-xs">
                  <T>
                    Your own requirements, frozen into the task and sent apart from the feed text,
                    which stays untrusted.
                  </T>
                </p>
                <span
                  className={
                    count.overLimit
                      ? "shrink-0 text-destructive text-xs"
                      : "shrink-0 text-muted-foreground text-xs"
                  }
                >
                  {count.label}
                </span>
              </div>
            </div>
            <FactoryLaunchFields
              environmentId={props.environmentId}
              disabled={pending || changed}
              draft={draft}
              untrustedText={gt("Feed text")}
            />
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <FactoryReviewFailure
            failure={props.failure}
            changed={changed}
            staleHint={gt(
              "This snapshot is no longer current. Close this dialog and review the item again before admitting new work.",
            )}
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            size="sm"
            disabled={!enabled}
            aria-busy={pending}
            onClick={() => {
              if (!enabled || selection === null) return;
              const baseRef = normalizeFactoryBaseRef(draft.baseRef);
              props.onSubmit({
                modelSelection: selection,
                instructions,
                restartDeleted: restart,
                ...(baseRef !== undefined ? { baseRef } : {}),
              });
            }}
          >
            {pending ? gt("Starting…") : restart ? gt("Start new attempt") : gt("Admit and start")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
