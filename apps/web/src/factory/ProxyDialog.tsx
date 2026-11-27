import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  EnvironmentAuthorizationError,
  FactoryProxyError,
  type FactoryProxyInstallInput,
  type FactoryProxyStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { msg, T, useMessages, Var } from "gt-react";
import { useContext, useEffect, useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useAtomCommand } from "../state/use-atom-command";
import {
  consoleNote,
  installInput,
  isOutdated,
  keyProblem,
  type ProxyAction,
  type ProxyActionAvailability,
  proxyActions,
  stateLine,
} from "./proxy.logic";
import {
  factoryProxyChange,
  factoryProxyStatusLive,
  installFactoryProxy,
  startFactoryProxy,
  stopFactoryProxy,
  uninstallFactoryProxy,
} from "./state";

type ProxyRefusal = FactoryProxyError["reason"];
type Removal = Extract<ProxyAction, "uninstall" | "forget-sign-ins">;

const REFUSALS: Record<ProxyRefusal, string> = {
  unavailable: msg("The model proxy is not available on this server."),
  busy: msg("The model proxy is busy with another change. Try again when it has finished."),
  "invalid-key": msg("A management key is 16 to 64 printable characters with no spaces."),
  "not-installed": msg("The model proxy is not installed on this server."),
  "already-installed": msg("The model proxy is already installed on this server."),
  "no-checkout": msg(
    "This server does not run from a Factory checkout, so it has no pinned manifest.",
  ),
  manifest: msg("The pinned manifest is missing or invalid, so nothing was fetched."),
  "unsupported-platform": msg("The pin has no build of the proxy for this machine."),
  "no-free-port": msg("No port from 8317 to 8327 is free on this machine."),
  "earlier-run": msg(
    "An earlier proxy may still be running. On the selected machine, identify the process listening on the proxy port before stopping anything, then try again.",
  ),
  "remove-refused": msg(
    "The proxy's hub could not be removed from this server's settings. Nothing was uninstalled. Try again.",
  ),
  "config-unreadable": msg(
    "The model proxy's settings file cannot be read. Uninstall, keeping sign-ins, then install again.",
  ),
};

const PROBLEMS: Record<NonNullable<FactoryProxyStatus["problem"]>, string> = {
  download: msg("A pinned file could not be downloaded. Nothing was installed."),
  verify: msg("A downloaded file did not match its pinned size or SHA-256. Nothing was installed."),
  archive: msg(
    "The proxy's archive did not hold exactly the five expected files. Nothing was installed.",
  ),
  write: msg("The proxy's files could not be written. Nothing was installed."),
  interrupted: msg(
    "An install or uninstall was interrupted. Uninstall to clean up, then install again.",
  ),
  leftover: msg("Some of the proxy's files or its hub could not be removed. Uninstall again."),
  damaged: msg(
    "The proxy's installed files or its key are missing, unreadable or changed. Uninstall, keeping sign-ins, and install again.",
  ),
  "config-unreadable": msg(
    "The proxy's settings file cannot be read, so the proxy was not started. Uninstall, keeping sign-ins, and install again.",
  ),
  spawn: msg("The proxy's program could not be started."),
  exited: msg("The proxy stopped five times in a row and was not started again."),
  unhealthy: msg(
    "The proxy started five times without answering its management API and was not started again.",
  ),
};

const HUB_LINES: Record<FactoryProxyStatus["hub"], string> = {
  connected: msg("Usage reads this proxy as the hub named Factory proxy."),
  disconnected: msg("Usage is not connected to this proxy."),
  "enable-refused": msg(
    "The proxy is running, but its hub could not be saved in this server's settings.",
  ),
  "disable-refused": msg("The proxy's hub could not be turned off in this server's settings."),
  "remove-refused": REFUSALS["remove-refused"],
};

const ACTION_LABELS: Record<ProxyAction, string> = {
  install: msg("Install"),
  start: msg("Start"),
  stop: msg("Stop"),
  uninstall: msg("Uninstall"),
  "forget-sign-ins": msg("Remove kept sign-ins"),
  "retry-hub": msg("Try again"),
};

const PERMISSION = msg(
  "Changing the proxy needs a device paired with permission to manage providers on this environment.",
);
const NO_ACTIONS: ReadonlyArray<ProxyActionAvailability> = [];
const QUIET_COMMAND = { reportFailure: false, reportDefect: false };
const isFactoryProxyError = Schema.is(FactoryProxyError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function refusalCode(error: unknown): ProxyRefusal | "permission" {
  if (isFactoryProxyError(error)) return error.reason;
  return isEnvironmentAuthorizationError(error) ? "permission" : "unavailable";
}

function ProcessLine({ status }: { readonly status: FactoryProxyStatus }) {
  switch (stateLine(status)) {
    case "not-installed":
      return <T>Not installed.</T>;
    case "no-manifest":
      return (
        <T>
          This server has no readable pinned manifest. The proxy can be installed only by a server
          that runs from a Factory checkout.
        </T>
      );
    case "unsupported":
      return (
        <T>
          The pin has no build for this machine (
          <Var>
            <bdi>{status.platform}</bdi>
          </Var>
          ).
        </T>
      );
    case "installing":
      return <T>Installing…</T>;
    case "stopped":
      return <T>Installed and stopped.</T>;
    case "starting":
      return <T>Starting…</T>;
    case "starting-again":
      return (
        <T>
          Starting again after it stopped, attempt{" "}
          <Var>
            <bdi>{status.restarts}</bdi>
          </Var>{" "}
          of 5…
        </T>
      );
    case "running":
      return (
        <T>
          Running on port{" "}
          <Var>
            <bdi>{status.port}</bdi>
          </Var>
          .
        </T>
      );
    case "failed":
      return <T>Failed.</T>;
    case "port-held-by":
      return (
        <T>
          Port{" "}
          <Var>
            <bdi>{status.port}</bdi>
          </Var>{" "}
          is in use. The last recorded proxy process ID was{" "}
          <Var>
            <bdi>{status.pid}</bdi>
          </Var>
          .
        </T>
      );
    case "port-held":
      return (
        <T>
          Port{" "}
          <Var>
            <bdi>{status.port}</bdi>
          </Var>{" "}
          is in use by another program.
        </T>
      );
  }
}

function ProxyStatusDetails({ status }: { readonly status: FactoryProxyStatus }) {
  const m = useMessages();
  const note = consoleNote(status);
  const { pinned, installed, port, state } = status;
  const showHub = state === "stopped" || state === "running" || status.hub !== "disconnected";

  return (
    <div className="space-y-2 text-sm">
      <p role="status" className="font-medium">
        <ProcessLine status={status} />
        {state === "stopped" && port !== null ? (
          <>
            {" "}
            <code>
              <bdi>{port}</bdi>
            </code>
          </>
        ) : null}
      </p>
      {status.problem !== null && state !== "installing" ? (
        <p>{m(PROBLEMS[status.problem])}</p>
      ) : null}
      {state === "failed" && status.exitCode !== null ? (
        <p>
          <T>
            Its last exit code was{" "}
            <Var>
              <bdi>{status.exitCode}</bdi>
            </Var>
            .
          </T>
        </p>
      ) : null}
      {state === "port-in-use" ? (
        <p>
          <T>
            On the selected machine, identify the process listening on this port before stopping
            anything. Once the port is free, choose Start.
          </T>
        </p>
      ) : null}
      {state !== "installing" && pinned !== null ? (
        <p className="wrap-anywhere">
          <T>
            Pinned: CLIProxyAPI{" "}
            <Var>
              <bdi>{pinned.proxy}</bdi>
            </Var>
            , console{" "}
            <Var>
              <bdi>{pinned.console}</bdi>
            </Var>
            .
          </T>
        </p>
      ) : null}
      {state !== "installing" && installed !== null ? (
        <p className="wrap-anywhere">
          <T>
            Installed: CLIProxyAPI{" "}
            <Var>
              <bdi>{installed.proxy}</bdi>
            </Var>
            , console{" "}
            <Var>
              <bdi>{installed.console}</bdi>
            </Var>
            .
          </T>
        </p>
      ) : null}
      {pinned !== null && isOutdated(status) ? (
        <p className="wrap-anywhere">
          <T>
            The pin has moved to CLIProxyAPI{" "}
            <Var>
              <bdi>{pinned.proxy}</bdi>
            </Var>
            , console{" "}
            <Var>
              <bdi>{pinned.console}</bdi>
            </Var>
            . Uninstall, keeping sign-ins, then install to move to it.
          </T>
        </p>
      ) : null}
      {showHub && state !== "installing" ? <p role="status">{m(HUB_LINES[status.hub])}</p> : null}
      {state === "running" && status.consoleUrl !== null ? (
        <p className="wrap-anywhere">
          <T>Console:</T>{" "}
          <code>
            <bdi>{status.consoleUrl}</bdi>
          </code>
        </p>
      ) : null}
      {state === "running" && note === "typed" ? (
        <>
          <p>
            <T>Open it in a browser on that machine.</T>
          </p>
          <p>
            <T>Sign in with the management key you typed when installing.</T>
          </p>
          <p>
            <T>
              What you save in the console is kept. The server sets the address, the port, the
              management key and the sign-in folder again each time the proxy starts, and plugins
              and network discovery are not available for it.
            </T>
          </p>
        </>
      ) : null}
      {(state === "stopped" || state === "running") && note === "generated" ? (
        <p>
          <T>
            This install generates its key, which is never shown, so the console cannot be used. To
            use it, uninstall, keeping sign-ins, then install with a key you type.
          </T>
        </p>
      ) : null}
      {state === "not-installed" && status.credentials ? (
        <p>
          <T>Sign-ins from an earlier install are kept on this machine.</T>
        </p>
      ) : null}
    </div>
  );
}

function InstallForm({
  offered,
  enabled,
  value,
  onChange,
  onInstall,
}: {
  readonly offered: boolean;
  readonly enabled: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onInstall: (input: FactoryProxyInstallInput) => Promise<void>;
}) {
  const m = useMessages();
  const id = useId();
  const invalid = keyProblem(value);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!enabled || invalid) return;
        void onInstall(installInput(value));
      }}
    >
      <Label htmlFor={id}>
        <T>Management key (optional)</T>
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        size="default"
        disabled={!enabled}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
      />
      <p id={hintId} className="text-sm text-muted-foreground">
        <T>
          Type one if you want to sign in to the proxy's console. Leave it empty and the server
          generates a key that is never shown. 16 to 64 characters, no spaces.
        </T>
      </p>
      {invalid ? (
        <p id={errorId} className="text-sm text-destructive-foreground">
          {m(REFUSALS["invalid-key"])}
        </p>
      ) : null}
      {offered ? (
        <Button
          type="submit"
          size="sm-multiline"
          data-proxy-action="install"
          disabled={!enabled || invalid}
        >
          {m(ACTION_LABELS.install)}
        </Button>
      ) : null}
    </form>
  );
}

export function ProxyDialog({
  environmentId,
  environmentLabel,
  connected,
  finalFocus,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly finalFocus: () => HTMLElement | null;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const m = useMessages();
  const changeAtom = factoryProxyChange(environmentId);
  const change = useAtomValue(changeAtom);
  const answer = useAtomValue(factoryProxyStatusLive({ environmentId, input: {} }));
  const canInstall = useAtomValue(installFactoryProxy.permissionAtom(environmentId));
  const canStart = useAtomValue(startFactoryProxy.permissionAtom(environmentId));
  const canStop = useAtomValue(stopFactoryProxy.permissionAtom(environmentId));
  const canUninstall = useAtomValue(uninstallFactoryProxy.permissionAtom(environmentId));
  const install = useAtomCommand(installFactoryProxy, QUIET_COMMAND);
  const start = useAtomCommand(startFactoryProxy, QUIET_COMMAND);
  const stop = useAtomCommand(stopFactoryProxy, QUIET_COMMAND);
  const uninstall = useAtomCommand(uninstallFactoryProxy, QUIET_COMMAND);
  const [managementKey, setManagementKey] = useState("");
  const [confirmation, setConfirmation] = useState<Removal | null>(null);
  const [removeCredentials, setRemoveCredentials] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const cancelRemoval = useRef<HTMLButtonElement>(null);
  const removalTrigger = useRef<HTMLButtonElement>(null);

  const busy = change?.kind === "pending";
  const previous = answer._tag === "Failure" ? Option.getOrNull(answer.previousSuccess) : null;
  const status =
    change?.kind === "answered"
      ? change.status
      : answer._tag === "Success"
        ? answer.value
        : (previous?.value ?? null);
  const queryRefusal =
    connected && answer._tag === "Failure"
      ? refusalCode(Option.getOrNull(Cause.findErrorOption(answer.cause)))
      : null;
  const notice = change?.kind === "refused" ? change.reason : queryRefusal;
  const noPermission = !canInstall && !canStart && !canStop && !canUninstall;
  const actions =
    status === null
      ? NO_ACTIONS
      : proxyActions(
          status,
          { install: canInstall, start: canStart, stop: canStop, uninstall: canUninstall },
          connected && queryRefusal === null,
        );
  const installAction = actions.find(({ action }) => action === "install");
  const removal = actions.find(({ action }) => action === confirmation);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps DOM focus inside the dialog when a polled status or permission removes or disables the focused control
  useEffect(() => {
    const active = document.activeElement;
    const action = active instanceof HTMLElement ? active.dataset.proxyAction : undefined;
    if (
      active === null ||
      active === document.body ||
      active.matches(":disabled") ||
      (action !== undefined &&
        (busy || !actions.some((entry) => entry.action === action && entry.enabled)))
    ) {
      (confirmation === null ? cancel : cancelRemoval).current?.focus();
    }
  }, [actions, busy, confirmation]);

  const run = async (command: () => Promise<AtomCommandResult<FactoryProxyStatus, unknown>>) => {
    // The scheduler joins calls sharing a key; a different action must not join the active one.
    if (!connected || registry.get(changeAtom)?.kind === "pending") return false;
    registry.set(changeAtom, { kind: "pending" });
    const result = await command();
    if (result._tag === "Success") return true;
    registry.set(
      changeAtom,
      isAtomCommandInterrupted(result)
        ? null
        : {
            kind: "refused",
            reason: refusalCode(Option.getOrNull(Cause.findErrorOption(result.cause))),
          },
    );
    return false;
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup showCloseButton={false} initialFocus={cancel} finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>
            <T>
              Model proxy on{" "}
              <Var>
                <bdi>{environmentLabel}</bdi>
              </Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Installs the pinned CLIProxyAPI on this environment's machine, runs it beside the
              server and connects Usage to it. It listens on that machine only.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!connected ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              <T>
                <Var>
                  <bdi>{environmentLabel}</bdi>
                </Var>{" "}
                is not connected
              </T>
            </p>
          ) : null}
          {noPermission || notice === "permission" ? (
            <p role={notice === "permission" ? "alert" : "status"} className="text-sm">
              {m(PERMISSION)}
            </p>
          ) : null}
          {notice !== null && notice !== "permission" ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {m(REFUSALS[notice])}
            </p>
          ) : null}
          <div aria-busy={status === null && answer.waiting}>
            {status === null ? null : <ProxyStatusDetails status={status} />}
          </div>
          {status?.state === "not-installed" ? (
            <InstallForm
              offered={installAction !== undefined}
              enabled={!busy && installAction?.enabled === true}
              value={managementKey}
              onChange={setManagementKey}
              onInstall={async (input) => {
                if (await run(() => install({ environmentId, input }))) setManagementKey("");
              }}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {actions.map(({ action, enabled }) => {
              if (action === "install") return null;
              const isRemoval = action === "uninstall" || action === "forget-sign-ins";
              return (
                <Button
                  key={action}
                  size="sm-multiline"
                  variant={
                    isRemoval ? "destructive-outline" : action === "start" ? "default" : "outline"
                  }
                  data-proxy-action={action}
                  disabled={busy || !enabled}
                  aria-haspopup={isRemoval ? "dialog" : undefined}
                  onClick={(event) => {
                    if (isRemoval) {
                      removalTrigger.current = event.currentTarget;
                      setRemoveCredentials(false);
                      setConfirmation(action);
                    } else if (
                      action === "start" ||
                      (action === "retry-hub" && status?.state === "running")
                    ) {
                      void run(() => start({ environmentId, input: {} }));
                    } else {
                      void run(() => stop({ environmentId, input: {} }));
                    }
                  }}
                >
                  {m(ACTION_LABELS[action])}
                </Button>
              );
            })}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" ref={cancel} />}>
            <T>Cancel</T>
          </DialogClose>
        </DialogFooter>
        <AlertDialog
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmation(null);
          }}
        >
          <AlertDialogPopup
            initialFocus={cancelRemoval}
            finalFocus={() => {
              const trigger = removalTrigger.current;
              return trigger?.isConnected && !trigger.disabled ? trigger : cancel.current;
            }}
          >
            {confirmation !== null ? (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {confirmation === "uninstall" ? (
                      <T>Uninstall the model proxy?</T>
                    ) : (
                      m(ACTION_LABELS[confirmation])
                    )}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {confirmation === "uninstall" ? (
                      <T>
                        The proxy is stopped, its program, settings and keys are deleted from{" "}
                        <Var>
                          <bdi>{environmentLabel}</bdi>
                        </Var>
                        , and its hub is removed from Usage.
                      </T>
                    ) : (
                      <T>Sign-ins from an earlier install are kept on this machine.</T>
                    )}
                  </AlertDialogDescription>
                  {confirmation === "uninstall" ? (
                    <div className="space-y-2 text-start">
                      <Label>
                        <Checkbox
                          variant="default"
                          checked={removeCredentials}
                          onCheckedChange={(value) => setRemoveCredentials(value)}
                        />
                        <T>Also remove the sign-ins it holds</T>
                      </Label>
                      {!removeCredentials ? (
                        <p className="text-sm text-muted-foreground">
                          <T>Sign-ins are kept and used again by the next install.</T>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" ref={cancelRemoval} />}>
                    <T>Cancel</T>
                  </AlertDialogClose>
                  <Button
                    variant="destructive"
                    size="multiline"
                    data-proxy-action={confirmation}
                    disabled={busy || removal?.enabled !== true}
                    onClick={() => {
                      const input =
                        confirmation === "forget-sign-ins"
                          ? { removeCredentials: true, onlyCredentials: true }
                          : { removeCredentials };
                      setConfirmation(null);
                      void run(() => uninstall({ environmentId, input }));
                    }}
                  >
                    {m(ACTION_LABELS[confirmation])}
                  </Button>
                </AlertDialogFooter>
              </>
            ) : null}
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}
