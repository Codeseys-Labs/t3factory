import type { EnvironmentId, T3CodeImportPreview, T3CodeImportResult } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { msg, T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";

/** Shown only on a server that keeps its data apart from T3 Code's on the same machine. */
export function T3CodeImportSection() {
  const { scope, environment } = useSettingsScope();
  if (
    !environment ||
    scope.environmentIds.length !== 1 ||
    environment.serverConfig?.environment.capabilities.t3CodeImport !== true
  )
    return null;
  return (
    <SettingsSection id="t3code-import" title="T3 Code">
      <T3CodeImportRow environmentId={environment.environmentId} />
    </SettingsSection>
  );
}

type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly preview: T3CodeImportPreview };

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : m(msg("Something went wrong."));
}

function T3CodeImportRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const runPreview = useAtomCommand(serverEnvironment.previewT3CodeImport, {
    reportFailure: false,
  });
  const runImport = useAtomCommand(serverEnvironment.importFromT3Code);
  const allowed = useAtomValue(serverEnvironment.importFromT3Code.permissionAtom(environmentId));
  const canReview = useAtomValue(
    serverEnvironment.previewT3CodeImport.permissionAtom(environmentId),
  );
  const [open, setOpen] = useState(false);
  const searchableSetting = useSearchableSetting();
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [includeProjects, setIncludeProjects] = useState(true);
  const [includeSettings, setIncludeSettings] = useState(true);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<T3CodeImportResult | null>(null);

  const load = async () => {
    setState({ kind: "loading" });
    const loaded = await runPreview({ environmentId, input: {} });
    if (loaded._tag === "Success") setState({ kind: "ready", preview: loaded.value });
    else if (!isAtomCommandInterrupted(loaded))
      setState({ kind: "failed", message: failureMessage(loaded) });
  };
  const openDialog = () => {
    setResult(null);
    setOpen(true);
    void load();
  };
  const importNow = async () => {
    setImporting(true);
    const imported = await runImport({
      environmentId,
      input: { projects: includeProjects, settings: includeSettings },
    });
    setImporting(false);
    if (imported._tag !== "Success") return;
    setResult(imported.value);
    await load();
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("import-from-t3code")}
        description={
          canReview
            ? gt(
                "Bring projects, provider setups and settings over from {product} on this machine. Run it again whenever you like: it only adds what is missing here and never changes or removes anything.",
                { product: "T3 Code" },
              )
            : gt(
                "Reviewing what {product} has on this machine needs permission to change settings on this environment.",
                { product: "T3 Code" },
              )
        }
        control={
          <Button size="sm" variant="outline" disabled={!canReview} onClick={openDialog}>
            <T>Review import</T>
          </Button>
        }
      />
      {open ? (
        <T3CodeImportDialog
          state={state}
          result={result}
          allowed={allowed}
          importing={importing}
          includeProjects={includeProjects}
          includeSettings={includeSettings}
          onIncludeProjects={setIncludeProjects}
          onIncludeSettings={setIncludeSettings}
          onImport={() => void importNow()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function T3CodeImportDialog({
  state,
  result,
  allowed,
  importing,
  includeProjects,
  includeSettings,
  onIncludeProjects,
  onIncludeSettings,
  onImport,
  onClose,
}: {
  readonly state: PreviewState;
  readonly result: T3CodeImportResult | null;
  readonly allowed: boolean;
  readonly importing: boolean;
  readonly includeProjects: boolean;
  readonly includeSettings: boolean;
  readonly onIncludeProjects: (include: boolean) => void;
  readonly onIncludeSettings: (include: boolean) => void;
  readonly onImport: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const preview =
    state.kind === "ready" && state.preview.status === "available" ? state.preview : null;
  const newProjects = preview?.projects.filter((project) => project.status === "new") ?? [];
  const newSettings = preview?.settings.filter((setting) => setting.status === "new") ?? [];
  const canImport =
    allowed &&
    !importing &&
    ((includeProjects && newProjects.length > 0) || (includeSettings && newSettings.length > 0));

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{gt("Import from {product}", { product: "T3 Code" })}</DialogTitle>
          <DialogDescription>
            {gt("Adds what {product} has that this app does not. Threads stay in {product}.", {
              product: "T3 Code",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4 text-sm">
            {result ? <ImportResult result={result} /> : null}
            {state.kind === "loading" ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner size="md" />
                {gt("Reading {product}''s data", { product: "T3 Code" })}
              </p>
            ) : state.kind === "failed" ? (
              <p className="text-destructive">{state.message}</p>
            ) : state.preview.status === "unavailable" ? (
              <p className="text-muted-foreground">
                {state.preview.reason === "same-data"
                  ? gt(
                      "This app already stores its data in {product}''s folder, so there is nothing to import.",
                      { product: "T3 Code" },
                    )
                  : gt("No {product} data was found in {source}.", {
                      product: "T3 Code",
                      source: state.preview.source,
                    })}
              </p>
            ) : (
              <>
                <ImportGroup
                  title={gt("Projects")}
                  checked={includeProjects}
                  onCheckedChange={onIncludeProjects}
                  items={newProjects.map((project) => ({
                    key: project.projectId,
                    label: project.title,
                    detail: project.workspaceRoot,
                  }))}
                  notes={[
                    ...(state.preview.projectsReadable
                      ? []
                      : [
                          "T3 Code's project list is from a newer version this app cannot read yet",
                        ]),
                    ...countNote(state.preview.projects, "present", "already here"),
                    ...countNote(
                      state.preview.projects,
                      "removed-here",
                      "removed here, not added again",
                    ),
                    ...countNote(
                      state.preview.projects,
                      "missing-folder",
                      "folder no longer exists",
                    ),
                  ]}
                />
                <ImportGroup
                  title={gt("Settings")}
                  checked={includeSettings}
                  onCheckedChange={onIncludeSettings}
                  items={newSettings.map((setting) => ({
                    key: setting.key,
                    label: setting.label,
                    detail:
                      setting.missingSecrets > 0
                        ? gt(
                            "{count, plural, one {{count} saved key} other {{count} saved keys}} missing in {product}; enter it here afterwards",
                            { count: setting.missingSecrets, product: "T3 Code" },
                          )
                        : setting.secrets > 0
                          ? gt(
                              "Includes {count, plural, one {{count} saved key} other {{count} saved keys}}",
                              { count: setting.secrets },
                            )
                          : null,
                  }))}
                  notes={[
                    ...countNote(state.preview.settings, "present", "already set here"),
                    ...countNote(state.preview.settings, "unreadable", "could not be read"),
                  ]}
                />
              </>
            )}
            {!allowed ? (
              <p className="text-muted-foreground">
                <T>
                  Importing needs permission to change settings, providers and projects on this
                  environment.
                </T>
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Close</T>
          </Button>
          <Button onClick={onImport} disabled={!canImport}>
            {importing ? <Spinner size="md" /> : null}
            <T>Import</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function countNote(
  items: ReadonlyArray<{ readonly status: string }>,
  status: string,
  text: string,
): ReadonlyArray<string> {
  const count = items.filter((item) => item.status === status).length;
  return count === 0 ? [] : [`${count} ${text}`];
}

function ImportGroup({
  title,
  checked,
  onCheckedChange,
  items,
  notes,
}: {
  readonly title: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly detail: string | null;
  }>;
  readonly notes: ReadonlyArray<string>;
}) {
  const gt = useGT();
  return (
    <section className="grid gap-2">
      <label className="flex cursor-pointer items-center gap-2 font-medium">
        <Checkbox
          checked={checked && items.length > 0}
          disabled={items.length === 0}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        {title}
        <span className="font-normal text-muted-foreground">
          {items.length === 0 ? gt("nothing new") : gt("{count} new", { count: items.length })}
        </span>
      </label>
      {items.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
          {items.map((item) => (
            <li key={item.key} className="px-3 py-2">
              <span className="block text-xs font-medium text-foreground">{item.label}</span>
              {item.detail ? (
                <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {notes.length > 0 ? (
        <p className="text-xs text-muted-foreground">{notes.join(" · ")}</p>
      ) : null}
    </section>
  );
}

function ImportResult({ result }: { readonly result: T3CodeImportResult }) {
  const gt = useGT();
  return (
    <div className="rounded-lg border border-input bg-muted/25 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">
        {gt(
          "Added {projects, plural, one {{projects} project} other {{projects} projects}} and {settings, plural, one {{settings} setting} other {{settings} settings}}{secrets, plural, =0 {} other {, with {secrets, plural, one {{secrets} saved key} other {{secrets} saved keys}}}}.",
          {
            projects: result.projectsAdded,
            settings: result.settingsAdded,
            secrets: result.secretsCopied,
          },
        )}
      </p>
      {result.failed.length > 0 ? (
        <p className="mt-1 text-destructive">
          {gt("Could not add {names}. Importing again retries them.", {
            names: result.failed.map((item) => item.label).join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}
