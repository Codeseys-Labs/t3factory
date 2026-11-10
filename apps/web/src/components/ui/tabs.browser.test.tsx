import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Tabs, TabsList, TabsPanel, TabsTab } from "./tabs";

it("selects the next tab with the arrow keys and wraps at the end", async () => {
  const onValueChange = vi.fn();
  await using screen = await render(
    <Tabs defaultValue="activity" onValueChange={onValueChange}>
      <TabsList>
        <TabsTab value="activity">Activity</TabsTab>
        <TabsTab value="thread">Thread</TabsTab>
        <TabsTab value="result">Result</TabsTab>
      </TabsList>
      <TabsPanel value="activity">Activity panel</TabsPanel>
      <TabsPanel value="thread">Thread panel</TabsPanel>
      <TabsPanel value="result">Result panel</TabsPanel>
    </Tabs>,
  );
  await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(screen.getByRole("tab", { name: "Thread" })).toHaveFocus();
  await expect
    .element(screen.getByRole("tab", { name: "Thread" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByText("Thread panel")).toBeVisible();
  expect(onValueChange).toHaveBeenLastCalledWith("thread", expect.anything());

  await userEvent.keyboard("{End}");
  await expect.element(screen.getByText("Result panel")).toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(screen.getByRole("tab", { name: "Activity" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByText("Activity panel")).toBeVisible();
});
