import { ProviderDriverKind, ProviderInstanceId, type FactoryAgentSetup } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../../providerInstances";
import { hasChosenOptions, taskTraitsInput, withModelOptions } from "./taskModelOptions.logic";

const instanceId = ProviderInstanceId.make("codex");
const effort = [{ id: "reasoningEffort", value: "high" }];
const setup = (options?: typeof effort): FactoryAgentSetup => ({
  modelSelection: { instanceId, model: "terra", ...(options ? { options } : {}) },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspace: "worktree",
});
const entries = [
  {
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    models: [
      {
        slug: "terra",
        name: "Terra",
        isCustom: false,
        capabilities: {
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
        },
      },
    ],
  },
] as unknown as ReadonlyArray<ProviderInstanceEntry>;

it("stores chosen options on the model and clears them back to the provider's default", () => {
  const chosen = withModelOptions(setup(), effort);
  expect(chosen).toEqual(setup(effort));
  expect(hasChosenOptions(chosen)).toBe(true);
  const cleared = withModelOptions(chosen, undefined);
  expect(cleared).toEqual(setup());
  expect("options" in cleared.modelSelection).toBe(false);
  expect(hasChosenOptions(withModelOptions(chosen, []))).toBe(false);
});

it("offers the model's options as the composer does, and hands a pick to the caller", () => {
  const onChange = vi.fn();
  expect(taskTraitsInput(entries, setup(), onChange)).toMatchObject({
    provider: "codex",
    model: "terra",
    // What the composer would send: Fast's implicit default shows, but nothing is stored for it.
    modelOptions: [{ id: "fastMode", value: false }],
  });
  const stored = taskTraitsInput(entries, setup(effort), onChange);
  expect(stored?.modelOptions).toEqual([...effort, { id: "fastMode", value: false }]);
  stored?.onModelOptionsChange?.(effort);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(effort);
  expect(taskTraitsInput([], setup(), onChange)).toBeNull();
});
