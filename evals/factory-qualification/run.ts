// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import {
  allocation,
  exportReplay,
  included,
  readCases,
  select,
  target,
  validate,
} from "./dataset.ts";
import { splits } from "./schema.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    split: { type: "string", default: "development" },
    "include-holdout": { type: "boolean", default: false },
    "export-replay": { type: "boolean", default: false },
  },
});
const split = splits.find((split) => split === values.split);
if (!split) throw new Error("Unknown split");
const cases = readCases();
const errors = validate(cases);
if (errors.length) throw new Error(errors.join("\n"));
const selected = select(cases, split, values["include-holdout"]);
process.stdout.write(
  values["export-replay"]
    ? `${exportReplay(selected)}\n`
    : `${JSON.stringify(
        {
          version: "1.0.0",
          target,
          included,
          allocation,
          selected: selected.map(({ id, route, execution }) => ({
            id,
            route,
            readiness: execution.readiness,
          })),
        },
        null,
        2,
      )}\n`,
);
