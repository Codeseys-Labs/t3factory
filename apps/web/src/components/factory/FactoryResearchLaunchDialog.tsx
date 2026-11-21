import {
  FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS,
  type EnvironmentId,
  type FactoryRepository,
  type FactoryResearchProtocol,
  type FactoryResearchRunLaunchInput,
  type ModelSelection,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
import { Alert, AlertDescription } from "../ui/alert";
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
import { countFactoryFeedText } from "./factoryFeeds.logic";
import {
  isFactoryResearchSubmitEnabled,
  type FactoryResearchFailure,
} from "./factoryResearch.logic";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  type FactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import {
  FactoryReviewFailure,
  FactoryReviewSnapshot,
  type FactoryReviewField,
} from "./FactoryReview";

/** The sealed protocol in full, so what a run is launched under is exactly what the server holds. */
function factoryProtocolReviewFields(
  protocol: FactoryResearchProtocol,
  resolve: MessageResolver = m,
): ReadonlyArray<FactoryReviewField> {
  const { metric, budget } = protocol;
  return [
    {
      label: resolve(msg("Hypothesis")),
      text: protocol.hypothesis,
      emptyNote: resolve(msg("The hypothesis is empty.")),
    },
    {
      label: resolve(msg("Run command")),
      text: protocol.runCommand,
      emptyNote: resolve(msg("The run command is empty.")),
    },
    {
      label: resolve(msg("Evaluators (path, blob)")),
      text: protocol.evaluators.map(({ path, blobOid }) => `${path}  ${blobOid}`).join("\n"),
      emptyNote: resolve(msg("No evaluators were sealed.")),
    },
    {
      label: resolve(msg("Metric")),
      text: [
        metric.name,
        resolve(msg("line prefix: {prefix}", { prefix: metric.linePrefix })),
        metric.direction === "lower"
          ? resolve(msg("lower is better"))
          : resolve(msg("higher is better")),
        metric.minimumEffect === null
          ? resolve(msg("minimum effect: none declared"))
          : resolve(msg("minimum effect: {value}", { value: String(metric.minimumEffect) })),
      ].join("\n"),
      emptyNote: resolve(msg("The metric is empty.")),
    },
    {
      label: resolve(msg("Budget")),
      text: [
        resolve(msg("{count} runs", { count: budget.maxRuns })),
        resolve(msg("{minutes} minutes per run", { minutes: budget.maxRunMinutes })),
        resolve(msg("window closes {when}", { when: budget.expiresAt })),
      ].join("\n"),
      emptyNote: resolve(msg("The budget is empty.")),
    },
    {
      label: resolve(msg("Base commit")),
      text: protocol.baseCommit,
      emptyNote: resolve(msg("The base commit is empty.")),
    },
  ];
}

/**
 * Pins one reviewed protocol revision. The `protocol` it was opened with is the only thing it ever
 * submits; a refreshed page can never change what is confirmed here.
 */
export function FactoryResearchLaunchDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly role: FactoryResearchRunLaunchInput["role"];
  readonly protocol: FactoryResearchProtocol;
  /** The candidate commit a verification is pinned to; null for an explore run. */
  readonly targetCommit: string | null;
  readonly projectTitle: string;
  readonly repository: FactoryRepository;
  readonly settings: FactoryLaunchModelSettings;
  readonly canLaunch: boolean;
  readonly pending: boolean;
  readonly failure: FactoryResearchFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (options: {
    readonly modelSelection: ModelSelection;
    readonly instructions: string;
  }) => void;
}) {
  const { role, protocol, pending } = props;
  const gt = useGT();
  const m = useMessages();
  const draft = useFactoryLaunchDraft(props.settings);
  const instructionsId = useId();
  const [instructions, setInstructions] = useState("");
  const changed = props.failure?.kind === "changed";
  const count = countFactoryFeedText(instructions, FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS);
  const { selection } = draft;
  const enabled = isFactoryResearchSubmitEnabled({
    allowed: props.canLaunch,
    pending,
    changed,
    selection,
    instructions,
  });
  const verify = role === "verify";
  const fields: ReadonlyArray<FactoryReviewField> = [
    ...factoryProtocolReviewFields(protocol, m),
    ...(verify && props.targetCommit !== null
      ? [
          {
            label: gt("Candidate commit under test"),
            text: props.targetCommit,
            emptyNote: gt("The candidate commit is empty."),
          },
        ]
      : []),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {verify ? gt("Launch verification run") : gt("Launch explore run")}
          </DialogTitle>
          <DialogDescription>
            {verify
              ? gt(
                  "Starts a separate thread in its own isolated worktree, pinned to the candidate commit. It must measure the same metric under the same protocol and record its own evidence.",
                )
              : gt(
                  "Starts a thread in its own isolated worktree at the sealed base commit. The run records its own evidence; the server reads the lines it cites.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <div className="space-y-0.5">
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                <T>
                  <Var>{`${props.repository.host}/${props.repository.repository}`}</Var> · task
                  project <Var>{props.projectTitle}</Var>
                </T>
              </p>
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                <T>
                  Protocol revision <Var>{protocol.revision}</Var>
                </T>
              </p>
            </div>
            <FactoryReviewSnapshot
              heading={gt("Sealed protocol")}
              intro={gt("Review the full protocol this run is launched under.")}
              fields={fields}
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
                placeholder={gt("Guidance for this run in your own words")}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <div className="flex items-start justify-between gap-3">
                <p id={`${instructionsId}-help`} className="text-muted-foreground text-xs">
                  <T>
                    Your own guidance, frozen into the run and sent apart from the sealed protocol.
                    It cannot change the protocol.
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
              untrustedText={gt("Run output")}
              showBaseRef={false}
            />
            {verify ? (
              <Alert variant="info">
                <AlertDescription>
                  <T>
                    Verification is launched here, by you, never by an agent. A verification
                    launched by the thread that produced the result is refused as not independent.
                  </T>
                </AlertDescription>
              </Alert>
            ) : null}
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <FactoryReviewFailure
            failure={props.failure}
            changed={changed}
            staleHint={gt(
              "This protocol is no longer current. Close this dialog and review the protocol again before launching.",
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
              props.onSubmit({ modelSelection: selection, instructions });
            }}
          >
            {pending
              ? gt("Starting…")
              : verify
                ? gt("Launch verification")
                : gt("Launch explore run")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
