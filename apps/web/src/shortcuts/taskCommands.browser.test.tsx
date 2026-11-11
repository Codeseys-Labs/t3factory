import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useTaskDialogStore } from "../components/tasks/taskDialogs";
import { installChatRouteCommands } from "./chatRouteCommands";

const state = vi.hoisted(() => ({
  single: null as { environmentId: string; projectId: string } | null,
}));
vi.mock(import("../components/tasks/shared/taskScope"), () => ({
  readTaskScope: (() => ({ single: state.single })) as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) };
});

describe("New task command", () => {
  it("reads the current scope at keypress time and leaves typing and terminal input alone", async () => {
    useTaskDialogStore.getState().close();
    state.single = null;
    await using screen = await render(
      <>
        <input aria-label="Title" />
        <div data-terminal-owner="drawer">
          <button type="button">Terminal</button>
        </div>
      </>,
    );
    using commands = new DisposableStack();
    commands.defer(
      installChatRouteCommands({
        state: { matches: [{ routeId: "/_chat", pathname: "/tasks", params: {} }] },
      } as unknown as AnyRouter),
    );
    commands.defer(() => useTaskDialogStore.getState().close());
    state.single = {
      environmentId: EnvironmentId.make("local"),
      projectId: ProjectId.make("factory"),
    };

    await userEvent.keyboard("c");
    expect(useTaskDialogStore.getState().dialog).toEqual({ kind: "new-task", ...state.single });
    useTaskDialogStore.getState().close();
    await screen.getByRole("textbox").click();
    await userEvent.keyboard("c");
    expect(useTaskDialogStore.getState().dialog).toBeNull();
    await screen.getByText("Terminal").click();
    await userEvent.keyboard("c");
    expect(useTaskDialogStore.getState().dialog).toBeNull();
  });
});
