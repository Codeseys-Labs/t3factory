// @effect-diagnostics nodeBuiltinImport:off - reads the list once at test setup, outside any Effect runtime.
// Fork-owned: skips upstream tests listed in windowsQuarantine.json on a Windows host only, so
// upstream test files stay unedited and the Linux lanes still run every case.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import * as HostProcess from "../HostProcess.ts";

const QuarantineEntries = Schema.Array(
  Schema.Struct({
    file: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    issue: Schema.Int,
    why: Schema.NonEmptyString,
  }),
);

// No global `URL` here: a test file that runs in a DOM environment gets the emulator's `URL`,
// which `fileURLToPath` rejects.
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const listPath = NodePath.join(here, "windowsQuarantine.json");
const repoRoot = NodePath.resolve(here, "../../../..");

const entries = Schema.decodeSync(Schema.fromJsonString(QuarantineEntries))(
  NodeFS.readFileSync(listPath, "utf8"),
);

if (HostProcess.Platform.defaultValue() === "win32") {
  const reasons = new Map(
    entries.map((entry) => [
      `${entry.file}\0${entry.name}`,
      `quarantine: #${entry.issue} ${entry.why}`,
    ]),
  );
  beforeEach((context) => {
    const file = NodePath.relative(repoRoot, context.task.file.filepath).replaceAll("\\", "/");
    const reason = reasons.get(`${file}\0${context.task.fullTestName}`);
    if (reason !== undefined) context.skip(reason);
  });
}
