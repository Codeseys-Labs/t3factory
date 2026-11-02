// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Cleanup for standalone packaged-app smoke runners.
import * as NodeFS from "node:fs";

export function cleanupSmokeDirectory(dir: string) {
  try {
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.warn(`Could not remove smoke directory ${dir}: ${String(error)}`);
  }
}
