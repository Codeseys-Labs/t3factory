import { useAtomValue } from "@effect/atom-react";
import type {
  ModelSelection,
  ProjectCoordinator,
  ProjectCoordinatorEnsureInput,
  RuntimeMode,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { getAntigravitySendBlockReason } from "../ChatView.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { CoordinatorFailure } from "./factoryCoordinatorPresentation";

type CoordinatorModes = Pick<
  ProjectCoordinatorEnsureInput,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;

export function FactoryOrchestratorDialog(props: {
  readonly target: SidebarProjectGroupMember;
  readonly environmentLabel: string;
  readonly coordinator: ProjectCoordinator | null;
  readonly request: ProjectCoordinatorEnsureInput | null;
  readonly canStart: boolean;
  readonly pending: boolean;
  readonly failure: CoordinatorFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (modes: CoordinatorModes) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [target] = useState(props.target);
  const [reviewedCoordinator] = useState(props.coordinator);
  const id = useId();
  const resuming = reviewedCoordinator?.status === "launching";
  const replacing = reviewedCoordinator?.status === "missing";
  const frozen = props.request !== null;
  const locked = props.pending || frozen || resuming;
  const settings = useEnvironmentSettings(target.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(target.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, target.id);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const candidate = resuming
    ? reviewedCoordinator.modelSelection
    : (picked ?? scheduledTaskDefaultModel(settings, target, entries));
  const selection =
    props.request?.modelSelection ??
    (candidate === null
      ? null
      : resuming
        ? candidate
        : resolveEffectiveDefaultModelSelection(settings, providers, candidate));
  const activeInstanceId =
    selection?.instanceId ?? entries.find((entry) => entry.enabled)?.instanceId ?? null;
  const entry = entries.find((candidateEntry) => candidateEntry.instanceId === activeInstanceId);
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    selection?.model ?? null,
  );
  const selectedRuntimeMode =
    props.request?.runtimeMode ?? (resuming ? reviewedCoordinator.runtimeMode : runtimeMode);
  // Plan mode has no picker; only a saved request or launch keeps its interaction mode.
  const selectedInteractionMode =
    props.request?.interactionMode ?? (resuming ? reviewedCoordinator.interactionMode : "default");
  const supportedModes = entry?.snapshot.supportedRuntimeModes;
  const availableModes =
    supportedModes && supportedModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedModes.includes(mode))
      : runtimeModeOptions;
  const providerBlock = getAntigravitySendBlockReason(entry?.snapshot, selection?.model ?? "");
  const modelOption =
    selection === null
      ? undefined
      : options.get(selection.instanceId)?.find((option) => option.slug === selection.model);
  const modelAvailable =
    selection !== null &&
    selection.model.trim().length > 0 &&
    entry !== undefined &&
    isProviderInstancePickerReady(entry) &&
    entry.snapshot.auth.status !== "unauthenticated" &&
    providerBlock === null &&
    modelOption?.isUnavailable !== true;
  const modeAvailable = availableModes.includes(selectedRuntimeMode);
  const mayConfirm =
    props.canStart &&
    !props.pending &&
    !props.failure?.requiresReview &&
    (frozen || (modelAvailable && modeAvailable)) &&
    (!replacing || replacementConfirmed);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!props.pending}>
        <DialogHeader>
          <DialogTitle>
            {resuming
              ? gt("Resume orchestrator start")
              : replacing
                ? gt("Replace unavailable orchestrator")
                : gt("Create and start orchestrator")}
          </DialogTitle>
          <DialogDescription>
            {resuming
              ? gt(
                  "Recover the original launch with its saved settings. This does not create another orchestrator or resend an accepted orientation.",
                )
              : gt(
                  "Creates a project thread and sends one read-only orientation request to the selected agent.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="min-w-0 space-y-4">
            <div className="min-w-0 space-y-1 rounded-lg border p-3 text-sm [overflow-wrap:anywhere]">
              <p className="font-medium">{target.title}</p>
              <p>{props.environmentLabel}</p>
              <p className="font-mono text-xs">{target.workspaceRoot}</p>
              <p className="text-muted-foreground text-xs">
                <T>Runs in this checkout, not an isolated issue worktree.</T>
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              <T>
                The agent is asked to inspect project instructions, tracker and workflows when
                accessible, then wait. It is not asked to edit files, start workers, enable
                schedules, publish, merge or spend. Project text is context, not authority. This is
                an instruction, not a read-only sandbox; the selected provider and permission modes
                still apply.
              </T>
            </p>
            <fieldset
              disabled={locked || props.failure?.requiresReview}
              className="min-w-0 space-y-4"
            >
              <div className="space-y-1.5" role="group" aria-label={gt("Orchestrator model")}>
                <Label>
                  <T>Model</T>
                </Label>
                {activeInstanceId !== null ? (
                  <ProviderModelPicker
                    environmentId={target.environmentId}
                    disabled={locked || props.failure?.requiresReview === true}
                    activeInstanceId={activeInstanceId}
                    model={selection?.model ?? ""}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={options}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={gt("Choose orchestrator provider and model")}
                    onInstanceModelChange={(instanceId, model) => setPicked({ instanceId, model })}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    <T>No provider is configured.</T>
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-runtime`}>
                  <T>Permissions</T>
                </Label>
                <Select
                  value={selectedRuntimeMode}
                  onValueChange={(value) => {
                    if (value !== null && availableModes.includes(value)) setRuntimeMode(value);
                  }}
                  disabled={locked || props.failure?.requiresReview}
                >
                  <SelectTrigger id={`${id}-runtime`} className="w-full">
                    <SelectValue>{m(runtimeModeConfig[selectedRuntimeMode].label)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {availableModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {m(runtimeModeConfig[mode].label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  <T>
                    <Var>{m(runtimeModeConfig[selectedRuntimeMode].description)}</Var> Connection
                    mode limits remain enforced by the server.
                  </T>
                </p>
              </div>
            </fieldset>
            {!frozen && (!modelAvailable || !modeAvailable) ? (
              <Alert variant="warning">
                <AlertDescription>
                  {!modelAvailable
                    ? (providerBlock ??
                      gt("Choose a ready, signed-in provider and model before starting."))
                    : gt(
                        "The selected modes are not supported by this provider. Choose supported modes before starting.",
                      )}
                </AlertDescription>
              </Alert>
            ) : null}
            {replacing ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  <T>
                    Replacing reviewed thread <Var>{reviewedCoordinator.threadId}</Var>. The server
                    will reject a stale binding.
                  </T>
                </p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={replacementConfirmed}
                    disabled={props.pending || frozen}
                    onChange={(event) => setReplacementConfirmed(event.target.checked)}
                    className="mt-1 shrink-0"
                  />
                  <span>
                    <T>
                      I confirm a new orchestrator. Replacement does not move existing workflow
                      bindings or restore workflows removed when the old thread was deleted.
                    </T>
                  </span>
                </label>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                <T>
                  Deleting an orchestrator thread also deletes workflows bound to it. Use the
                  existing thread controls to archive instead.
                </T>
              </p>
            )}
            {frozen ? (
              <p className="text-xs text-muted-foreground">
                <T>
                  Destination, model, modes and request ID are frozen. Retry recovers this same
                  request; close to review a different request.
                </T>
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <div className="shrink-0 px-6 py-3" aria-live="polite">
          {!props.canStart ? (
            <Alert variant="warning">
              <AlertDescription>
                <T>
                  The environment must be connected with orchestration operate permission before
                  confirming.
                </T>
              </AlertDescription>
            </Alert>
          ) : null}
          {props.failure ? (
            <Alert variant="error">
              <AlertTitle>{props.failure.title}</AlertTitle>
              <AlertDescription>{props.failure.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={props.pending} />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            size="sm"
            disabled={!mayConfirm}
            aria-busy={props.pending}
            onClick={() => {
              if (!mayConfirm || selection === null) return;
              props.onSubmit({
                modelSelection: selection,
                runtimeMode: selectedRuntimeMode,
                interactionMode: selectedInteractionMode,
              });
            }}
          >
            {props.pending
              ? gt("Starting…")
              : frozen
                ? gt("Retry same request")
                : resuming
                  ? gt("Resume start")
                  : replacing
                    ? gt("Replace and start")
                    : gt("Create and start")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
