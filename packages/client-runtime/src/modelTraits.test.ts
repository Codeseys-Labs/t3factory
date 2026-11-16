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

  // The composer's trigger lists every option of the model, so a task's label does too.
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
      name: "Thinking off",
      options: [{ id: "thinking", value: false }],
      label: "Low · Thinking Off",
    },
    {
      name: "Ultracode on",
      options: [{ id: "ultracode", value: true }],
      label: "Low · Thinking On · Ultracode",
    },
    {
      name: "Fast on",
      options: [{ id: "fastMode", value: true }],
      label: "Low Fast · Thinking On",
    },
    {
      name: "a non-default effort",
      options: [{ id: "reasoningEffort", value: "high" }],
      label: "High · Thinking On",
    },
  ])("says what the composer's trigger says for $name", ({ options, label }) => {
    expect(describeSelectedEffort(selection(options), agentCapabilities)).toBe(label);
  });

  it("names nothing for a model whose options are unknown", () => {
    expect(
      describeSelectedEffort(selection([{ id: "reasoningEffort", value: "high" }]), null),
    ).toBeNull();
  });
});
