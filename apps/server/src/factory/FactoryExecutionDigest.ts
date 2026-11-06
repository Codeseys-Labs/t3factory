// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

export function canonicalExecutionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalExecutionJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalExecutionJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function executionDigest(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalExecutionJson(value)).digest("hex");
}
export function executionBytesDigest(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
