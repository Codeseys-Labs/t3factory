import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { AssigneeChip } from "./atoms";
import { AssigneePicker } from "./AssigneePicker";

async function openPicker() {
  const onSelect = vi.fn();
  const onPin = vi.fn();
  const screen = await render(
    <AssigneePicker
      trigger={
        <AssigneeChip
          assignee={{ kind: "auto", label: "Claude · Opus" }}
          render={<button type="button" />}
        />
      }
      auto={{ detail: "Picks Claude · Opus for this project" }}
      profiles={[
        { id: "impl", name: "Implementer", mono: "Cx", detail: "Codex · Sol" },
        { id: "scout", name: "Scout", mono: "Cx", detail: "Codex · Luna" },
        { id: "writer", name: "Writer", mono: "Gm", detail: "Gemini · Flash" },
      ]}
      person={{ label: "You", initials: "BB", detail: "Person" }}
      selected={{ kind: "auto" }}
      onSelect={onSelect}
      onPin={onPin}
    />,
  );
  await using stack = new AsyncDisposableStack();
  stack.use(screen);
  await userEvent.click(screen.getByRole("button", { name: "Auto → Claude · Opus" }));
  await expect.element(page.getByRole("option", { name: /Implementer/ })).toBeVisible();
  return { screen: stack.move(), onSelect, onPin };
}

it("narrows the options to the search", async () => {
  const { screen } = await openPicker();
  await using _screen = screen;
  await userEvent.keyboard("luna");
  await expect.element(page.getByRole("option", { name: /Scout/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Implementer/ })).not.toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: /Auto/ })).not.toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: /Pin a harness/ })).toBeVisible();
});

it("moves with the arrows and selects with Enter", async () => {
  const { screen, onSelect } = await openPicker();
  await using _screen = screen;
  await expect
    .element(page.getByRole("option", { name: /Auto/ }))
    .toHaveAttribute("data-highlighted");
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("option", { name: /Implementer/ }))
    .toHaveAttribute("data-highlighted");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: "profile", profileId: "impl" });
  await expect.element(page.getByRole("option", { name: /Implementer/ })).not.toBeInTheDocument();
});

it("closes on Escape without choosing", async () => {
  const { screen, onSelect } = await openPicker();
  await using _screen = screen;
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: /Implementer/ })).not.toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});

it("hands the pin entry to its callback", async () => {
  const { screen, onSelect, onPin } = await openPicker();
  await using _screen = screen;
  await userEvent.click(page.getByRole("option", { name: /Pin a harness and model/ }));
  expect(onPin).toHaveBeenCalledOnce();
  expect(onSelect).not.toHaveBeenCalled();
  await expect.element(page.getByRole("option", { name: /Implementer/ })).not.toBeInTheDocument();
});
