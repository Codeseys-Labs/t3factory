// @effect-diagnostics nodeBuiltinImport:off - Audits the repository's workflow files on disk.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse, stringify } from "yaml";

import { auditWorkflows, readWorkflowFiles } from "./factory-workflow-audit.ts";

const workflows = readWorkflowFiles(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows"),
);

type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs: Record<
    string,
    Record<string, unknown> & {
      steps?: Array<Record<string, unknown> & { with?: Record<string, unknown> }>;
    }
  >;
};

function withWorkflow(file: string, change: (workflow: Workflow) => void) {
  const workflow = parse(workflows.get(file)!) as Workflow;
  change(workflow);
  return new Map(workflows).set(file, stringify(workflow));
}

describe("auditWorkflows", () => {
  it("accepts the repository's workflows", () => {
    expect(auditWorkflows(workflows)).toEqual([]);
  });

  it.each([
    [
      "an inherited workflow regains an automatic trigger",
      withWorkflow("ci.yml", (workflow) => {
        workflow.on.push = { branches: ["main"] };
      }),
      "ci.yml is inherited delivery; its only trigger must be workflow_call",
    ],
    [
      "a reusable publisher regains manual dispatch",
      withWorkflow("publish-aur.yml", (workflow) => {
        workflow.on.workflow_dispatch = {};
      }),
      "publish-aur.yml is inherited delivery",
    ],
    [
      "an unknown workflow appears",
      new Map(workflows).set("nightly.yml", "on: schedule\njobs: {}\n"),
      "nightly.yml is not in the factory workflow inventory",
    ],
    [
      "housekeeping calls a release body",
      withWorkflow("pr-size.yml", (workflow) => {
        workflow.jobs.release = { uses: "./.github/workflows/release.yml" };
      }),
      "pr-size.yml can start neutralized workflow release.yml",
    ],
    [
      "housekeeping reaches a publisher through a neutralized caller",
      withWorkflow("pr-vouch.yml", (workflow) => {
        workflow.jobs.release = { uses: "./.github/workflows/release.yml" };
      }),
      "pr-vouch.yml can start reusable-delivery workflow publish-aur.yml",
    ],
    [
      "housekeeping chains on another workflow",
      withWorkflow("stale-needs-more-info.yml", (workflow) => {
        workflow.on.workflow_run = { workflows: ["Factory Check"], types: ["completed"] };
      }),
      "stale-needs-more-info.yml chains on workflow_run",
    ],
    [
      "factory-check gains an automatic trigger",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.on.push = {};
      }),
      "factory-check.yml must be dispatch-only",
    ],
    [
      "factory-check uses an unavailable runner",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.jobs.lint!["runs-on"] = "blacksmith-8vcpu-ubuntu-2404";
      }),
      'job lint runs on "blacksmith-8vcpu-ubuntu-2404", not a hosted runner',
    ],
    [
      "factory-check reads a secret",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.jobs.build!.env = { TOKEN: "${{ secrets.T3_TASK_CACHE_READ_TOKEN }}" };
      }),
      "factory-check.yml must not reference secrets",
    ],
    [
      "factory-check grants OIDC",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.jobs.test!.permissions = { contents: "read", "id-token": "write" };
      }),
      "job test grants id-token: write",
    ],
    [
      "factory-check persists the checkout token",
      withWorkflow("factory-check.yml", (workflow) => {
        delete workflow.jobs.rust!.steps![1]!.with;
      }),
      "job rust checks out without persist-credentials: false",
    ],
    [
      "a lane runs although it was not requested",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.jobs.windows!.if = "${{ always() }}";
      }),
      "lane windows must run exactly when lane_windows is requested",
    ],
    [
      "the aggregate stops waiting for a lane",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.jobs.check!.needs = ["resolve", "lint"];
      }),
      "check must need resolve and every lane",
    ],
    [
      "a factory-check job is renamed away from what factory-build matches",
      withWorkflow("factory-check.yml", (workflow) => {
        workflow.jobs.test_server!.name = "Server";
      }),
      "job test_server must be named Test Server ${{ matrix.shard }}",
    ],
    [
      "factory-build runs after factory-check",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.on.workflow_run = { workflows: ["Factory Check"], types: ["completed"] };
      }),
      "factory-build.yml chains on workflow_run",
    ],
    [
      "factory-build starts on a tag push",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.on.push = { tags: ["v*"] };
      }),
      "factory-build.yml must be dispatch-only",
    ],
    [
      "factory-build gains a publish job",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.publish = { "runs-on": "ubuntu-24.04", steps: [] };
      }),
      "jobs must be exactly manifest, package, verify",
    ],
    [
      "factory-build calls a release body",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.manifest = { uses: "./.github/workflows/release-desktop.yml" };
      }),
      "factory-build.yml can start reusable-delivery workflow release-desktop.yml",
    ],
    [
      "factory-build dispatches a publisher",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.manifest!.steps!.push({ run: "gh workflow run release.yml" });
      }),
      "job manifest runs a dispatch, download, signing or publishing command",
    ],
    [
      "factory-build uses a release action",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.manifest!.steps!.push({ uses: "softprops/action-gh-release@v2" });
      }),
      "uses softprops/action-gh-release@v2, which is not an allowed build action",
    ],
    [
      "factory-build reads a signing secret",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.package!.env = { AZURE_CLIENT_SECRET: "${{ secrets.AZURE_CLIENT_SECRET }}" };
      }),
      "factory-build.yml must not reference secrets",
    ],
    [
      "the candidate build gets the API token",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.package!.steps![0]!.env = { GH_TOKEN: "${{ github.token }}" };
      }),
      "job package must not read github.token",
    ],
    [
      "the candidate build gains actions access",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.package!.permissions = { contents: "read", actions: "read" };
      }),
      "job package permissions must be the workflow's contents: read",
    ],
    [
      "the candidate checkout persists its token",
      withWorkflow("factory-build.yml", (workflow) => {
        delete workflow.jobs.package!.steps![1]!.with!["persist-credentials"];
      }),
      "job package checks out without persist-credentials: false",
    ],
    [
      "the package reuses a prebuilt resource monitor",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.package!.env = { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" };
      }),
      "job package must build the resource monitor, not reuse one",
    ],
    [
      "the manifest stops waiting for the package",
      withWorkflow("factory-build.yml", (workflow) => {
        workflow.jobs.manifest!.needs = ["verify"];
      }),
      "manifest must need verify and package",
    ],
  ])("rejects when %s", (_name, files, message) => {
    expect(auditWorkflows(files).join("\n")).toContain(message);
  });
});
