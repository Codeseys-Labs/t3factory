// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Repository audit CLI over the workflow files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseDocument } from "yaml";

import { CHECK_JOB_NAMES, SHARDED_CHECK_LANES } from "./factory-build.ts";
import { CHECK_LANES, isRecord as isNode } from "./factory-check.ts";

type WorkflowRole =
  | "factory-check"
  | "factory-build"
  | "neutralized"
  | "reusable-delivery"
  | "housekeeping"
  | "manual-tooling";

interface InventoryEntry {
  readonly role: WorkflowRole;
  /** Exact triggers for workflows that may still start; changing them needs a deliberate review. */
  readonly triggers?: ReadonlyArray<string>;
}

/**
 * Every workflow file in the repository, by role. Inherited delivery workflows keep their
 * upstream bodies but are reusable-only with no active caller. Housekeeping and manual tooling
 * are inventoried separately: they are not CI or delivery, and they do still start.
 */
export const WORKFLOW_INVENTORY: Readonly<Record<string, InventoryEntry>> = {
  "factory-check.yml": { role: "factory-check" },
  "factory-build.yml": { role: "factory-build" },
  "agent-context-budget.yml": { role: "neutralized" },
  "ci.yml": { role: "neutralized" },
  "deploy-relay.yml": { role: "neutralized" },
  "desktop-macos-preview.yml": { role: "neutralized" },
  "desktop-macos-preview-publish.yml": { role: "neutralized" },
  "mobile-android-apk.yml": { role: "neutralized" },
  "mobile-eas-preview.yml": { role: "neutralized" },
  "mobile-eas-preview-fork.yml": { role: "neutralized" },
  "mobile-eas-production.yml": { role: "neutralized" },
  "mobile-fingerprint-check.yml": { role: "neutralized" },
  "mobile-fingerprint-label.yml": { role: "neutralized" },
  "relay-preview.yml": { role: "neutralized" },
  "relay-preview-cleanup.yml": { role: "neutralized" },
  "release.yml": { role: "neutralized" },
  "thread-transfer-report.yml": { role: "neutralized" },
  "web-preview.yml": { role: "neutralized" },
  "windows-tests.yml": { role: "neutralized" },
  "issue-vouch.yml": { role: "neutralized" },
  "mobile-dev-client.yml": { role: "neutralized" },
  "pr-limits.yml": { role: "neutralized" },
  "publish-aur.yml": { role: "reusable-delivery" },
  "release-desktop.yml": { role: "reusable-delivery" },
  "issue-labels.yml": { role: "housekeeping", triggers: ["push", "workflow_dispatch"] },
  "pr-size.yml": { role: "housekeeping", triggers: ["pull_request_target"] },
  "pr-vouch.yml": {
    role: "housekeeping",
    triggers: ["issue_comment", "pull_request_target", "push"],
  },
  "stale-needs-more-info.yml": {
    role: "housekeeping",
    triggers: ["schedule", "workflow_dispatch"],
  },
  "mobile-showcase-screenshots.yml": { role: "manual-tooling", triggers: ["workflow_dispatch"] },
};

export const FACTORY_CHECK_RUNNERS = ["ubuntu-24.04", "windows-2025"];
const LOCAL_WORKFLOW_PREFIX = "./.github/workflows/";

type Node = Record<string, unknown>;

function triggersOf(workflow: Node): string[] {
  const on = workflow.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String).toSorted();
  return isNode(on) ? Object.keys(on).toSorted() : [];
}

function jobsOf(workflow: Node): Array<[string, Node]> {
  return isNode(workflow.jobs)
    ? Object.entries(workflow.jobs).filter((entry): entry is [string, Node] => isNode(entry[1]))
    : [];
}

function stepsOf(job: Node): Node[] {
  return Array.isArray(job.steps) ? job.steps.filter(isNode) : [];
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return isNode(value)
    ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
    : [];
}

function permissionGrants(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value === "read-all" || value === "{}" ? [] : [value];
  if (!isNode(value)) return ["unrecognized permissions"];
  return Object.entries(value)
    .filter(([, level]) => level !== "read" && level !== "none")
    .map(([scope, level]) => `${scope}: ${String(level)}`);
}

function auditFactoryCheck(workflow: Node): string[] {
  const at = "factory-check.yml";
  const errors: string[] = [];
  const secrets = strings(workflow).filter((value) => /\bsecrets\b/.test(value));
  if (secrets.length > 0) errors.push(`${at} must not reference secrets: ${secrets.join(", ")}`);
  const workflowPermissions = workflow.permissions;
  if (
    !isNode(workflowPermissions) ||
    Object.keys(workflowPermissions).length !== 1 ||
    workflowPermissions.contents !== "read"
  ) {
    errors.push(`${at} workflow permissions must be exactly contents: read`);
  }
  const inputs =
    isNode(workflow.on) && isNode(workflow.on.workflow_dispatch)
      ? workflow.on.workflow_dispatch.inputs
      : undefined;
  for (const name of [
    "candidate_sha",
    "base_sha",
    "candidate_ref",
    "local_receipt_sha256",
    "local_receipt_b64",
  ]) {
    const input = isNode(inputs) ? inputs[name] : undefined;
    if (!isNode(input) || input.required !== true)
      errors.push(`${at} needs required input ${name}`);
  }
  for (const lane of CHECK_LANES) {
    const input = isNode(inputs) ? inputs[`lane_${lane}`] : undefined;
    if (!isNode(input) || input.type !== "boolean")
      errors.push(`${at} needs boolean input lane_${lane}`);
  }

  const jobs = new Map(jobsOf(workflow));
  const expectedJobs = ["resolve", ...CHECK_LANES, "check"] as const;
  for (const name of jobs.keys()) {
    if (!(expectedJobs as ReadonlyArray<string>).includes(name)) {
      errors.push(`${at} job ${name} is not a known lane`);
    }
  }
  // factory-build matches the jobs the API reports to lanes by these names.
  for (const name of expectedJobs) {
    const job = jobs.get(name);
    const sharded = (SHARDED_CHECK_LANES as ReadonlyArray<string>).includes(name);
    const expected = `${CHECK_JOB_NAMES[name]}${sharded ? " ${{ matrix.shard }}" : ""}`;
    if (job && job.name !== expected) errors.push(`${at} job ${name} must be named ${expected}`);
  }
  for (const [name, job] of jobs) {
    if (typeof job.uses === "string")
      errors.push(`${at} job ${name} calls reusable workflow ${job.uses}`);
    if (!FACTORY_CHECK_RUNNERS.includes(job["runs-on"] as string)) {
      errors.push(
        `${at} job ${name} runs on ${JSON.stringify(job["runs-on"])}, not a hosted runner`,
      );
    }
    for (const grant of permissionGrants(job.permissions)) {
      errors.push(`${at} job ${name} grants ${grant}`);
    }
    for (const step of stepsOf(job)) {
      const uses = typeof step.uses === "string" ? step.uses : "";
      const options = isNode(step.with) ? step.with : {};
      if (uses.startsWith("actions/checkout@") && options["persist-credentials"] !== false) {
        errors.push(`${at} job ${name} checks out without persist-credentials: false`);
      }
      if (uses.startsWith("./")) errors.push(`${at} job ${name} uses repository action ${uses}`);
      if ("token" in options || "github-token" in options) {
        errors.push(`${at} job ${name} passes a token to ${uses}`);
      }
    }
  }
  for (const lane of CHECK_LANES) {
    const job = jobs.get(lane);
    if (!job) {
      errors.push(`${at} has no ${lane} lane job`);
      continue;
    }
    if (job.needs !== "resolve" && !(Array.isArray(job.needs) && job.needs.includes("resolve"))) {
      errors.push(`${at} lane ${lane} must need resolve`);
    }
    if (job.if !== `\${{ inputs.lane_${lane} }}`) {
      errors.push(`${at} lane ${lane} must run exactly when lane_${lane} is requested`);
    }
  }
  const check = jobs.get("check");
  const needs = Array.isArray(check?.needs) ? check.needs.map(String).toSorted() : [];
  if (JSON.stringify(needs) !== JSON.stringify(["resolve", ...CHECK_LANES].toSorted())) {
    errors.push(`${at} check must need resolve and every lane`);
  }
  if (typeof check?.if !== "string" || !check.if.includes("always()")) {
    errors.push(`${at} check must run always() so cancelled and skipped lanes fail it`);
  }
  return errors;
}

const FACTORY_BUILD_JOBS = ["manifest", "package", "verify"];
const FACTORY_BUILD_ACTIONS = [
  "actions/checkout@",
  "actions/upload-artifact@",
  "actions/download-artifact@",
  "voidzero-dev/setup-vp@",
  "dtolnay/rust-toolchain@",
];
// Publication is separate (issue 75): the build only uploads run artifacts.
const FACTORY_BUILD_FORBIDDEN_RUN =
  /\bgh\s|\bcurl\b|\bwget\b|\/dispatches\b|\bpublish\b|--signed\b|--skip-build\b/i;
const REUSE_MONITOR = "T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR";

function auditFactoryBuild(workflow: Node): string[] {
  const at = "factory-build.yml";
  const errors: string[] = [];
  const secrets = strings(workflow).filter((value) => /\bsecrets\b/.test(value));
  if (secrets.length > 0) errors.push(`${at} must not reference secrets: ${secrets.join(", ")}`);
  const workflowPermissions = workflow.permissions;
  if (
    !isNode(workflowPermissions) ||
    Object.keys(workflowPermissions).length !== 1 ||
    workflowPermissions.contents !== "read"
  ) {
    errors.push(`${at} workflow permissions must be exactly contents: read`);
  }
  const inputs =
    isNode(workflow.on) && isNode(workflow.on.workflow_dispatch)
      ? workflow.on.workflow_dispatch.inputs
      : undefined;
  for (const name of [
    "candidate_sha",
    "base_sha",
    "candidate_ref",
    "validation_run_id",
    "validation_run_attempt",
    "validation_control_sha",
    "validation_manifest_sha256",
    "package_receipt_sha256",
    "package_receipt_b64",
  ]) {
    const input = isNode(inputs) ? inputs[name] : undefined;
    if (!isNode(input) || input.required !== true) {
      errors.push(`${at} needs required input ${name}`);
    }
  }
  if (isNode(workflow.env) && REUSE_MONITOR in workflow.env) {
    errors.push(`${at} must not set ${REUSE_MONITOR} for every job`);
  }

  const jobs = new Map(jobsOf(workflow));
  if (JSON.stringify([...jobs.keys()].toSorted()) !== JSON.stringify(FACTORY_BUILD_JOBS)) {
    errors.push(`${at} jobs must be exactly ${FACTORY_BUILD_JOBS.join(", ")}`);
  }
  for (const [name, job] of jobs) {
    if (typeof job.uses === "string") {
      errors.push(`${at} job ${name} calls reusable workflow ${job.uses}`);
    }
    if (!FACTORY_CHECK_RUNNERS.includes(job["runs-on"] as string)) {
      errors.push(
        `${at} job ${name} runs on ${JSON.stringify(job["runs-on"])}, not a hosted runner`,
      );
    }
    // Only verify reads the API; the candidate build never gets more than the checkout token.
    const expected = name === "verify" ? { contents: "read", actions: "read" } : undefined;
    if (JSON.stringify(job.permissions) !== JSON.stringify(expected)) {
      errors.push(
        `${at} job ${name} permissions must be ${expected ? "exactly contents: read, actions: read" : "the workflow's contents: read"}`,
      );
    }
    if (name !== "verify" && strings(job).some((value) => /\bgithub\.token\b/.test(value))) {
      errors.push(`${at} job ${name} must not read github.token`);
    }
    const envs = [job.env, ...stepsOf(job).map((step) => step.env)].filter(isNode);
    if (envs.some((env) => REUSE_MONITOR in env && env[REUSE_MONITOR] !== "false")) {
      errors.push(`${at} job ${name} must build the resource monitor, not reuse one`);
    }
    for (const step of stepsOf(job)) {
      const uses = typeof step.uses === "string" ? step.uses : "";
      const options = isNode(step.with) ? step.with : {};
      if (uses && !FACTORY_BUILD_ACTIONS.some((prefix) => uses.startsWith(prefix))) {
        errors.push(`${at} job ${name} uses ${uses}, which is not an allowed build action`);
      }
      if (uses.startsWith("actions/checkout@") && options["persist-credentials"] !== false) {
        errors.push(`${at} job ${name} checks out without persist-credentials: false`);
      }
      if ("token" in options || "github-token" in options) {
        errors.push(`${at} job ${name} passes a token to ${uses}`);
      }
      if (typeof step.run === "string" && FACTORY_BUILD_FORBIDDEN_RUN.test(step.run)) {
        errors.push(`${at} job ${name} runs a dispatch, download, signing or publishing command`);
      }
    }
  }
  const packageJob = jobs.get("package");
  if (packageJob?.needs !== "verify") errors.push(`${at} package must need verify`);
  if (packageJob?.["runs-on"] !== "windows-2025") {
    errors.push(`${at} package must run on windows-2025`);
  }
  const manifest = jobs.get("manifest");
  const needs = Array.isArray(manifest?.needs) ? manifest.needs.map(String).toSorted() : [];
  if (JSON.stringify(needs) !== JSON.stringify(["package", "verify"])) {
    errors.push(`${at} manifest must need verify and package`);
  }
  if (typeof manifest?.if !== "string" || !manifest.if.includes("always()")) {
    errors.push(`${at} manifest must run always() so a failed or skipped job fails it`);
  }
  return errors;
}

/** Audits workflow file contents keyed by file name. Returns every violation found. */
export function auditWorkflows(
  files: ReadonlyMap<string, string>,
  inventory: Readonly<Record<string, InventoryEntry>> = WORKFLOW_INVENTORY,
): string[] {
  const errors: string[] = [];
  const workflows = new Map<string, Node>();
  for (const [file, text] of files) {
    const document = parseDocument(text);
    if (document.errors.length > 0 || !isNode(document.toJS())) {
      errors.push(
        `${file} is not a valid YAML mapping: ${document.errors.map((error) => error.message).join("; ")}`,
      );
      continue;
    }
    workflows.set(file, document.toJS() as Node);
    if (!inventory[file]) errors.push(`${file} is not in the factory workflow inventory`);
  }
  for (const file of Object.keys(inventory)) {
    if (!files.has(file)) errors.push(`inventoried workflow ${file} does not exist`);
  }

  const calls = new Map<string, string[]>();
  for (const [file, workflow] of workflows) {
    const entry = inventory[file];
    const triggers = triggersOf(workflow);
    if (triggers.includes("workflow_run")) {
      errors.push(`${file} chains on workflow_run, which no factory workflow may do`);
    }
    if (entry?.role === "neutralized" || entry?.role === "reusable-delivery") {
      if (JSON.stringify(triggers) !== JSON.stringify(["workflow_call"])) {
        errors.push(
          `${file} is inherited delivery; its only trigger must be workflow_call, found ${triggers.join(", ")}`,
        );
      }
    } else if (entry?.role === "factory-check" || entry?.role === "factory-build") {
      if (JSON.stringify(triggers) !== JSON.stringify(["workflow_dispatch"])) {
        errors.push(`${file} must be dispatch-only, found ${triggers.join(", ")}`);
      }
      errors.push(
        ...(entry.role === "factory-check"
          ? auditFactoryCheck(workflow)
          : auditFactoryBuild(workflow)),
      );
    } else if (entry?.triggers) {
      if (JSON.stringify(triggers) !== JSON.stringify(entry.triggers.toSorted())) {
        errors.push(
          `${file} triggers changed to ${triggers.join(", ")}; re-inventory ${entry.triggers.join(", ")} deliberately`,
        );
      }
      const secrets = strings(workflow).filter(
        (value) =>
          /\bsecrets\b/.test(value) && !/^\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}$/.test(value),
      );
      if (secrets.length > 0)
        errors.push(`${file} references secrets beyond GITHUB_TOKEN: ${secrets.join(", ")}`);
      const grants = [workflow, ...jobsOf(workflow).map(([, job]) => job)].flatMap((node) =>
        permissionGrants(node.permissions),
      );
      if (grants.includes("id-token: write")) errors.push(`${file} grants id-token: write`);
    }
    calls.set(
      file,
      jobsOf(workflow).flatMap(([job, node]) => {
        if (typeof node.uses !== "string") return [];
        if (!node.uses.startsWith(LOCAL_WORKFLOW_PREFIX)) {
          errors.push(`${file} job ${job} calls a workflow outside this repository: ${node.uses}`);
          return [];
        }
        const target = node.uses.slice(LOCAL_WORKFLOW_PREFIX.length).split("@")[0]!;
        if (!files.has(target)) errors.push(`${file} job ${job} calls missing workflow ${target}`);
        return [target];
      }),
    );
  }

  // Anything an entry point can start must be neither neutralized nor a delivery body.
  for (const [file, workflow] of workflows) {
    if (JSON.stringify(triggersOf(workflow)) === JSON.stringify(["workflow_call"])) continue;
    const seen = new Set<string>();
    const pending = [...(calls.get(file) ?? [])];
    while (pending.length > 0) {
      const target = pending.pop()!;
      if (seen.has(target)) continue;
      seen.add(target);
      const role = inventory[target]?.role;
      if (role === "neutralized" || role === "reusable-delivery") {
        errors.push(`${file} can start ${role} workflow ${target}`);
      }
      pending.push(...(calls.get(target) ?? []));
    }
  }
  return errors;
}

export function readWorkflowFiles(dir: string): Map<string, string> {
  return new Map(
    NodeFS.readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .toSorted()
      .map((name) => [name, NodeFS.readFileSync(NodePath.join(dir, name), "utf8")]),
  );
}

if (import.meta.main) {
  const dir = NodePath.resolve(import.meta.dirname, "..", ".github", "workflows");
  const errors = auditWorkflows(readWorkflowFiles(dir));
  for (const error of errors) console.error(`- ${error}`);
  if (errors.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `Workflow audit passed for ${Object.keys(WORKFLOW_INVENTORY).length} inventoried workflows.`,
    );
  }
}
