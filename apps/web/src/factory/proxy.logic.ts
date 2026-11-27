import {
  FACTORY_PROXY_KEY_PATTERN,
  type FactoryProxyInstallInput,
  type FactoryProxyStatus,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

type ProxyCommand = "install" | "start" | "stop" | "uninstall";
export type ProxyAction = ProxyCommand | "forget-sign-ins" | "retry-hub";

export interface ProxyActionAvailability {
  readonly action: ProxyAction;
  readonly enabled: boolean;
}

export function proxyActions(
  status: Pick<
    FactoryProxyStatus,
    "state" | "supported" | "pinned" | "credentials" | "hub" | "problem" | "installed"
  >,
  allowed: Readonly<Record<ProxyCommand, boolean>>,
  connected: boolean,
): ReadonlyArray<ProxyActionAvailability> {
  const offer = (action: ProxyAction, command: ProxyCommand) => ({
    action,
    enabled: connected && allowed[command],
  });

  switch (status.state) {
    case "not-installed":
      return [
        ...(status.supported && status.pinned !== null ? [offer("install", "install")] : []),
        ...(status.credentials ? [offer("forget-sign-ins", "uninstall")] : []),
      ];
    case "installing":
      return [];
    case "stopped":
      return [
        offer("start", "start"),
        offer("uninstall", "uninstall"),
        ...(status.hub === "disable-refused" ? [offer("retry-hub", "stop")] : []),
      ];
    case "starting":
      return [offer("stop", "stop"), offer("uninstall", "uninstall")];
    case "running":
      return [
        offer("stop", "stop"),
        offer("uninstall", "uninstall"),
        ...(status.hub !== "connected" ? [offer("retry-hub", "start")] : []),
      ];
    case "failed":
      return [
        ...(status.problem === "interrupted" ||
        status.problem === "config-unreadable" ||
        (status.problem === "damaged" && status.installed === null)
          ? []
          : [offer("start", "start")]),
        offer("stop", "stop"),
        offer("uninstall", "uninstall"),
      ];
    case "port-in-use":
      return [offer("start", "start"), offer("stop", "stop"), offer("uninstall", "uninstall")];
  }
}

export function keyProblem(text: string): boolean {
  const key = text.trim();
  return key !== "" && !FACTORY_PROXY_KEY_PATTERN.test(key);
}

export function installInput(text: string): FactoryProxyInstallInput {
  const key = text.trim();
  return key === "" ? {} : { managementKey: Redacted.make(key) };
}

export function isOutdated({
  pinned,
  installed,
}: Pick<FactoryProxyStatus, "pinned" | "installed">): boolean {
  return (
    pinned !== null &&
    installed !== null &&
    (pinned.proxy !== installed.proxy || pinned.console !== installed.console)
  );
}

export function consoleNote({
  installed,
  consoleKey,
}: Pick<FactoryProxyStatus, "installed" | "consoleKey">): FactoryProxyStatus["consoleKey"] {
  return installed === null ? null : consoleKey;
}

export function stateLine(
  status: Pick<FactoryProxyStatus, "state" | "pinned" | "supported" | "restarts" | "pid">,
):
  | Exclude<FactoryProxyStatus["state"], "port-in-use">
  | "no-manifest"
  | "unsupported"
  | "starting-again"
  | "port-held-by"
  | "port-held" {
  switch (status.state) {
    case "not-installed":
      return status.pinned === null
        ? "no-manifest"
        : status.supported
          ? "not-installed"
          : "unsupported";
    case "starting":
      return status.restarts > 0 ? "starting-again" : "starting";
    case "port-in-use":
      return status.pid === null ? "port-held" : "port-held-by";
    default:
      return status.state;
  }
}
