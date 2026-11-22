// Fork-owned: windowsQuarantine.ts for projects that run in a browser, which cannot read the list
// with node:fs. Vite bundles the list instead, and Chromium's user agent names the host platform.
import { beforeEach } from "vite-plus/test";

import entries from "./windowsQuarantine.json" with { type: "json" };

if (navigator.userAgent.includes("Windows")) {
  const byName = new Map<string, Array<{ readonly file: string; readonly reason: string }>>();
  for (const entry of entries) {
    const listed = byName.get(entry.name) ?? [];
    listed.push({ file: entry.file, reason: `quarantine: #${entry.issue} ${entry.why}` });
    byName.set(entry.name, listed);
  }
  beforeEach((context) => {
    const path = context.task.file.filepath.replaceAll("\\", "/");
    const listed = byName.get(context.task.fullTestName);
    const hit = listed?.find((candidate) => path.endsWith(`/${candidate.file}`));
    if (hit !== undefined) context.skip(hit.reason);
  });
}
