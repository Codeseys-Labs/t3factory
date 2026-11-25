import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";
import { createFileRoute } from "@tanstack/react-router";

import { WorkPage, type WorkSearch } from "../factory/WorkPage";

/** An id from the address, trimmed and bounded; blank or not a string is no id. */
const idParam = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const bounded = trimmed.slice(0, splitsSurrogatePair(trimmed, 200) ? 199 : 200).trim();
  return bounded === "" ? undefined : bounded;
};

export const Route = createFileRoute("/_chat/work")({
  validateSearch: (raw: Record<string, unknown>): WorkSearch => {
    const env = idParam(raw.env);
    const project = idParam(raw.project);
    const task = idParam(raw.task);
    return {
      ...(env === undefined ? {} : { env }),
      ...(raw.view === "board" || raw.view === "list" || raw.view === "graph"
        ? { view: raw.view }
        : {}),
      ...(project === undefined ? {} : { project }),
      ...(task === undefined ? {} : { task }),
    };
  },
  component: WorkPage,
});
