import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  describeSelectedEffort,
  getDescriptorStringValue,
  resolveEffortGlyph,
} from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });
});

describe("describeSelectedEffort", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      { id: "fastMode", label: "Fast mode", type: "boolean" },
    ],
  };
  const selection = (options?: ModelSelection["options"]): ModelSelection => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: "terra",
    ...(options ? { options } : {}),
  });

  it.each([
    { name: "no options keeps the provider's default unnamed", options: undefined, label: null },
    { name: "an effort", options: [{ id: "reasoningEffort", value: "high" }], label: "High" },
    {
      name: "an effort with Fast on",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
      label: "High Fast",
    },
    {
      name: "Fast off beside an effort",
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: false },
      ],
      label: "Low",
    },
  ])("names $name", ({ options, label }) => {
    expect(describeSelectedEffort(selection(options), capabilities)).toBe(label);
  });

  // The label is what the composer's trigger shows: the first reasoning control, speed, Ultracode
  // and the context window. Other traits, such as Thinking beside an effort, stay in the picker.
  const agentCapabilities: ModelCapabilities = {
    optionDescriptors: [
      ...capabilities.optionDescriptors!.slice(0, 1),
      { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
      { id: "ultracode", label: "Ultracode", type: "boolean" },
      ...capabilities.optionDescriptors!.slice(1),
    ],
  };
  it.each([
    {
      name: "a non-default effort, Thinking at its default",
      options: [{ id: "reasoningEffort", value: "high" }],
      label: "High",
    },
    {
      name: "Thinking off beside an effort",
      options: [{ id: "thinking", value: false }],
      label: "Low",
    },
    {
      name: "Ultracode on",
      options: [{ id: "ultracode", value: true }],
      label: "Low · Ultracode",
    },
    { name: "Fast on", options: [{ id: "fastMode", value: true }], label: "Low Fast" },
  ])("says what the composer's trigger shows for $name", ({ options, label }) => {
    expect(describeSelectedEffort(selection(options), agentCapabilities)).toBe(label);
  });

  it.each([
    { options: [{ id: "contextWindow", value: "1m" }], label: "Low · 1M" },
    // The trigger prints the window even at the model's default.
    { options: [{ id: "reasoningEffort", value: "low" }], label: "Low · 200K" },
  ])("names the context window the trigger prints: $label", ({ options, label }) => {
    const withWindow: ModelCapabilities = {
      optionDescriptors: [
        ...capabilities.optionDescriptors!,
        {
          id: "contextWindow",
          label: "Context window",
          type: "select",
          options: [
            { id: "200k", label: "200K", isDefault: true },
            { id: "1m", label: "1M" },
          ],
        },
      ],
    };
    expect(describeSelectedEffort(selection(options), withWindow)).toBe(label);
  });

  it("names Thinking when it is the model's only reasoning control", () => {
    const thinkingOnly: ModelCapabilities = {
      optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
    };
    expect(
      describeSelectedEffort(selection([{ id: "thinking", value: false }]), thinkingOnly),
    ).toBe("Thinking Off");
  });

  it("names nothing for a model whose options are unknown", () => {
    expect(
      describeSelectedEffort(selection([{ id: "reasoningEffort", value: "high" }]), null),
    ).toBeNull();
  });
});

const effortSelect = (
  ids: ReadonlyArray<string>,
  promptInjectedValues?: ReadonlyArray<string>,
) => ({
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: ids.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })),
  ...(promptInjectedValues ? { promptInjectedValues } : {}),
});

describe("resolveEffortGlyph", () => {
  const claude = effortSelect(
    ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
    ["ultrathink"],
  );

  it("fills bars up to the current level and leaves max and workflow levels off the scale", () => {
    expect(resolveEffortGlyph(claude, "xhigh")).toEqual({
      count: 4,
      filled: 4,
      special: null,
      label: "Xhigh",
    });
  });

  it("names max instead of drawing it", () => {
    expect(resolveEffortGlyph(claude, "max")?.special).toBe("Max");
  });

  it("names Ultracode and Ultrathink instead of drawing a level", () => {
    expect(resolveEffortGlyph(claude, "ultracode")?.special).toBe("Ultracode");
    expect(resolveEffortGlyph(claude, "ultrathink")?.special).toBe("Ultrathink");
  });

  it("draws the lowest level as one bar, and an off level as none", () => {
    expect(resolveEffortGlyph(claude, "low")).toMatchObject({ count: 4, filled: 1 });
    expect(resolveEffortGlyph(claude, "medium")).toMatchObject({ count: 4, filled: 2 });
    expect(resolveEffortGlyph(effortSelect(["off", "low", "high"]), "off")).toEqual({
      count: 2,
      filled: 0,
      special: null,
      label: "Off",
    });
  });

  it("falls back to the word when the value is unknown or the scale is too short or long", () => {
    expect(resolveEffortGlyph(claude, "unknown")).toBeNull();
    expect(resolveEffortGlyph(effortSelect(["high"]), "high")).toBeNull();
    const levels = Array.from({ length: 8 }, (_, index) => `level${index}`);
    expect(resolveEffortGlyph(effortSelect(levels), "level0")).toBeNull();
  });
});
