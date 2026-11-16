import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

const REASONING_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  ...REASONING_EFFORT_OPTION_IDS,
  "thinking",
]);

/** The model's reasoning control: a known effort id, or a select its agent marked as reasoning. */
export function isReasoningControl(descriptor: ProviderOptionDescriptor): boolean {
  return (
    (descriptor.type === "select" && descriptor.role === "reasoning") ||
    REASONING_DESCRIPTOR_IDS.has(descriptor.id)
  );
}

export function isReasoningSelect(
  descriptor: ProviderOptionDescriptor,
): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> {
  return descriptor.type === "select" && isReasoningControl(descriptor);
}

export function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return typeof value === "string" ? value : null;
}

// Prompt-injected levels such as Ultrathink still work when typed, but pickers do not offer them.
export function selectableProviderOptionChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  return descriptor.options.filter(
    (option) => !descriptor.promptInjectedValues?.includes(option.id),
  );
}

export function getPromptControlledTraits(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  prompt: string,
  allowPromptInjectedEffort = true,
) {
  const primarySelectDescriptor =
    descriptors.find((descriptor) => descriptor.type === "select") ?? null;
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  return { primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText };
}

export function getTraitSelectChange(
  selected: ReturnType<typeof getPromptControlledTraits> & {
    descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  },
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  prompt: string,
  value: string,
) {
  if (!value || descriptor.promptInjectedValues?.includes(value)) return null;
  const isPrimary = descriptor.id === selected.primarySelectDescriptor?.id;
  if (isPrimary && selected.ultrathinkInBodyText) return null;
  return {
    prompt:
      isPrimary && selected.ultrathinkPromptControlled
        ? prompt.replace(/^Ultrathink:\s*/i, "")
        : prompt,
    modelOptions: buildProviderOptionSelectionsFromDescriptors(
      replaceDescriptorCurrentValue(selected.descriptors, descriptor.id, value),
    ),
  };
}

export function buildTraitsTriggerDisplay(input: {
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
  modelSelection?: ModelSelection | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
}): {
  label: string;
  /** "Fast" or "Ultrafast" when a speed option is on. */
  speedLabel: string | null;
  ultracode: boolean;
} {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  let ultracodeLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    if (descriptor.id === "ultracode" && descriptor.type === "boolean") {
      if (descriptor.currentValue === true) {
        ultracodeLabelIndex = labels.length;
        labels.push(descriptor.label);
      }
      continue;
    }
    if (descriptor.id === "serviceTier" && descriptor.type === "select") {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
      if (
        ((fastTier || ultrafastTier) && currentValue === "default") ||
        (fastTier && currentValue === fastTier.id) ||
        (ultrafastTier && currentValue === ultrafastTier.id)
      ) {
        speedLabel =
          ultrafastTier && currentValue === ultrafastTier.id
            ? "Ultrafast"
            : fastTier && currentValue === fastTier.id
              ? "Fast"
              : null;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal";
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
          : (getProviderOptionCurrentLabel(
              descriptor,
              input.modelSelection,
              input.reportedModelSelection,
            ) ?? (descriptor.id === "thinking" ? descriptor.label : null));
    if (typeof label === "string" && label.length > 0) {
      if (reasoningLabelIndex === -1 && isReasoningSelect(descriptor)) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  const ultracode = ultracodeLabelIndex >= 0;
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return { label: fastModeFallbackLabel, speedLabel, ultracode };
  }
  if (speedLabel) {
    if (reasoningLabelIndex >= 0) {
      labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    } else {
      labels.push(speedLabel);
    }
  }
  return { label: labels.join(" · "), speedLabel, ultracode };
}

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, and Ultracode sit in the footer, not the column. */
export function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

export type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning levels under the header that names it. Other options,
 * such as an agent's session mode, sit below as one row each.
 */
export function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

// Older servers offer Ultracode as a level. It changes the workflow, so it keeps its name.
// Max is named too, so the full scale stops short of it.
const NAMED_LEVELS = new Set(["ultracode", "max"]);
const OFF_LEVELS = new Set(["off", "none"]);
// More bars than this no longer fit the glyph's height in whole pixels.
const MAX_BARS = 7;

/**
 * Maps a reasoning select to bars: one per ordinary level, filled up to the current one, with an
 * off level as none filled. Max, prompt-injected and workflow levels are named instead of drawn.
 */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || levels.length > MAX_BARS || current === null) return null;
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id);
  const count = startsAtOff ? levels.length - 1 : levels.length;
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return { count, filled: count, special: label, label };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return {
    count,
    filled: startsAtOff ? index : index + 1,
    special: null,
    label: levels[index]!.label,
  };
}

/**
 * What the composer's model trigger shows after the model name: the first reasoning control (as
 * bars, or its word per `effortDisplay`), a bolt for Fast, an icon for Ultracode and the context
 * window. `detail` is the expanded description of every option, for an accessible label.
 */
export function describeTriggerTraits(input: {
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  ultrathinkPromptControlled: boolean;
  effortDisplay: EffortDisplay;
  modelSelection?: ModelSelection | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
}) {
  const { descriptors, modelSelection, reportedModelSelection } = input;
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is BooleanDescriptor => descriptor.type === "boolean",
  );
  const primary = selectDescriptors[0] ?? null;
  const display = buildTraitsTriggerDisplay({
    descriptors,
    primarySelectDescriptorId: primary?.id ?? null,
    ultrathinkPromptControlled: input.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection,
  });
  // The same reasoning control the column lists, wherever the agent put it among its options.
  const reasoning =
    columnControls(selectDescriptors, booleanDescriptors).effort?.descriptor ?? null;
  const ultrathink = input.ultrathinkPromptControlled && reasoning === primary;
  const glyph =
    reasoning?.type === "select"
      ? resolveEffortGlyph(
          reasoning,
          ultrathink
            ? "ultrathink"
            : getDescriptorStringValue(reasoning, modelSelection, reportedModelSelection),
        )
      : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (input.effortDisplay === "label" ? glyph.label : null))
    : !reasoning
      ? null
      : reasoning.type === "boolean"
        ? `${reasoning.label} ${reasoning.currentValue === true ? "On" : "Off"}`
        : ultrathink
          ? "Ultrathink"
          : (getProviderOptionCurrentLabel(reasoning, modelSelection, reportedModelSelection) ??
            (reasoning.id === "thinking" ? reasoning.label : null));
  // Agent options such as modes live in the picker; the trigger adds only the context window.
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const contextWindow =
    (contextWindowDescriptor &&
      getProviderOptionCurrentLabel(
        contextWindowDescriptor,
        modelSelection,
        reportedModelSelection,
      )) ||
    null;
  return {
    detail: display.label,
    glyph,
    word,
    speedLabel: display.speedLabel,
    fast: display.speedLabel === "Fast" || display.speedLabel === "Ultrafast",
    ultracode: display.ultracode,
    contextWindow,
  };
}

/**
 * What the composer's trigger visibly shows for a selection, as words: `High`, `High Fast`,
 * `Low · Ultracode · 1M`. Null when the selection carries no options, so the provider's default
 * applies, when its model's options are unknown, or when the trigger shows nothing.
 */
export function describeSelectedEffort(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null | undefined,
): string | null {
  if (!selection.options?.length || !capabilities) return null;
  const trigger = describeTriggerTraits({
    descriptors: getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
    ultrathinkPromptControlled: false,
    effortDisplay: "label",
    modelSelection: selection,
  });
  const effort = [trigger.word, trigger.fast ? trigger.speedLabel : null].filter(Boolean).join(" ");
  const label = [effort, trigger.ultracode ? "Ultracode" : null, trigger.contextWindow]
    .filter(Boolean)
    .join(" · ");
  return label || null;
}
